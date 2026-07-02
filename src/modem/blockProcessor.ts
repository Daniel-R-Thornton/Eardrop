/**
 * blockProcessor.ts — Routes decoded framed blocks to the right handler.
 *
 * After the FramedBlockDecoder emits a validated block (CRC verified),
 * the BlockProcessor dispatches it by type:
 *   0x01 SQUAWK  → PilotTracker recalibration
 *   0x02 CONFIG  → Preamble parser (file metadata)
 *   0x03 DICT    → Dictionary decompressor
 *   0x04 PAYLOAD → Byte accumulator (appended to current file buffer)
 *   0xFF EOF     → Flush and emit completed file
 */

import { BLOCK_TYPE } from "./framing";
import { FilePreamble, tryParsePreamble, preambleSize } from "../protocol";

export interface BlockProcessorConfig {
  /** Callback when a complete file has been received */
  onFileComplete: (file: { name: string; data: Uint8Array }) => void;
  /** Callback for partial payload bytes (for progress tracking) */
  onPayloadProgress: (bytesSoFar: number, fileSize: number) => void;
  /** Callback for squawk calibration data */
  onSquawk?: (squawkId: number, refI: number, refQ: number) => void;
}

/**
 * State machine for assembling file data from framed blocks.
 *
 * The expected block sequence is:
 *   CONFIG → [DICT] → (PAYLOAD)* → EOF
 *
 * Any out-of-order block resets the state (discards partial file).
 */
export class BlockProcessor {
  private cfg: BlockProcessorConfig;

  /** Current file being assembled */
  private fileName = "";
  private fileData: number[] = [];
  private expectedSize = 0;
  private dictScheme = 0;
  private configReceived = false;

  /** Stats for debug display */
  public stats = {
    blocksReceived: 0,
    configBlocks: 0,
    dictBlocks: 0,
    payloadBlocks: 0,
    eofBlocks: 0,
    squawkBlocks: 0,
    bytesAssembled: 0,
    resets: 0,
  };

  constructor(cfg: BlockProcessorConfig) {
    this.cfg = cfg;
  }

  /**
   * Process a decoded and CRC-verified block.
   * Returns a human-readable summary string for debug logging.
   */
  processBlock(type: number, data: Uint8Array): string {
    this.stats.blocksReceived++;

    switch (type) {
      case BLOCK_TYPE.SQUAWK:
        return this.handleSquawk(data);

      case BLOCK_TYPE.CONFIG:
        return this.handleConfig(data);

      case BLOCK_TYPE.DICTIONARY:
        return this.handleDictionary(data);

      case BLOCK_TYPE.PAYLOAD:
        return this.handlePayload(data);

      case BLOCK_TYPE.EOF:
        return this.handleEof();

      default:
        return `BLK unknown type=0x${type.toString(16)} len=${data.length}`;
    }
  }

  /** Reset the processor (new file session). */
  reset(): void {
    this.fileName = "";
    this.fileData = [];
    this.expectedSize = 0;
    this.dictScheme = 0;
    this.configReceived = false;
  }

  /** Get current progress info for UI display. */
  getProgress(): { fileName: string; bytesSoFar: number; totalBytes: number } | null {
    if (!this.configReceived) return null;
    return {
      fileName: this.fileName,
      bytesSoFar: this.fileData.length,
      totalBytes: this.expectedSize,
    };
  }

  // ─── Private handlers ───────────────────────────────

  private handleSquawk(data: Uint8Array): string {
    this.stats.squawkBlocks++;
    if (data.length < 1) return `SQWK short (${data.length}B)`;

    const squawkId = data[0];
    let refI = 0, refQ = 0;
    if (data.length >= 5) {
      refI = (data[1] << 8) | data[2];  // fixed-point 16-bit
      refQ = (data[3] << 8) | data[4];
      // Convert from [-32768, 32767] to [-1, 1] float
      refI /= 32768;
      refQ /= 32768;
    }

    if (this.cfg.onSquawk) {
      this.cfg.onSquawk(squawkId, refI, refQ);
    }

    return `SQWK id=${squawkId} refI=${refI.toFixed(3)} refQ=${refQ.toFixed(3)}`;
  }

  private handleConfig(data: Uint8Array): string {
    this.stats.configBlocks++;

    // Parse the config block: [nameLen:2B][fileName:L][totalSize:4B][dictScheme:1B]
    if (data.length < 7) return `CONFIG too short (${data.length}B)`;

    const nameLen = data[0] | (data[1] << 8);
    if (nameLen < 1 || nameLen > 255 || data.length < 7 + nameLen) {
      return `CONFIG invalid nameLen=${nameLen}`;
    }

    const fileName = new TextDecoder().decode(data.slice(2, 2 + nameLen));
    const off = 2 + nameLen;
    const totalSize = (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0;
    const dictScheme = data[off + 4];

    // Validate
    if (totalSize === 0 || totalSize > 10_485_760) {
      return `CONFIG invalid totalSize=${totalSize}`;
    }

    // If we already have a config, reset for new file
    if (this.configReceived) {
      this.reset();
      this.stats.resets++;
    }

    this.fileName = fileName;
    this.expectedSize = totalSize;
    this.dictScheme = dictScheme;
    this.fileData = [];
    this.configReceived = true;

    return `CONFIG "${fileName}" ${totalSize}B dict=0x${dictScheme.toString(16)}`;
  }

  private handleDictionary(data: Uint8Array): string {
    this.stats.dictBlocks++;
    // Dictionary data: [entries:2B][entry0_len:1B][entry0_data...]...
    // For now, store and process later during dictionary decompression.
    return `DICT ${data.length}B (storage not yet implemented)`;
  }

  private handlePayload(data: Uint8Array): string {
    if (!this.configReceived) {
      // Payload before config — likely missed a block, reset
      this.stats.resets++;
      return `PAYLOAD ignored (no config) — RESET`;
    }

    this.stats.payloadBlocks++;
    for (const b of data) {
      this.fileData.push(b);
    }
    this.stats.bytesAssembled = this.fileData.length;

    // Notify progress
    if (this.cfg.onPayloadProgress) {
      this.cfg.onPayloadProgress(this.fileData.length, this.expectedSize);
    }

    // If we've reached or exceeded expected size, auto-finalize
    if (this.fileData.length >= this.expectedSize) {
      this.finalizeFile();
      return `PAYLOAD ${data.length}B (final — ${this.fileData.length}/${this.expectedSize})`;
    }

    return `PAYLOAD ${data.length}B (${this.fileData.length}/${this.expectedSize})`;
  }

  private handleEof(): string {
    this.stats.eofBlocks++;
    if (this.configReceived && this.fileData.length > 0) {
      this.finalizeFile();
    }
    return `EOF — ${this.fileData.length}B total`;
  }

  private finalizeFile(): void {
    if (!this.configReceived || this.fileData.length === 0) return;

    const truncated = this.fileData.slice(0, Math.min(this.fileData.length, this.expectedSize));
    const data = new Uint8Array(truncated);

    if (this.cfg.onFileComplete) {
      this.cfg.onFileComplete({ name: this.fileName, data });
    }

    this.reset();
  }
}

/**
 * txEngine.ts — Complete transmission engine for the Eardrop modem.
 *
 * State machine: CALIBRATION → HEADER → DATA → END
 *
 * Generates audio for a complete file transfer:
 *   1. Preamble (warble → cal → inv → sweep) — 620ms
 *   2. Header atomic frame (type=0x01) — file metadata
 *   3. Data atomic frames (type=0x02) — file payload
 *   4. Tail atomic frame (type=0x03) — end marker
 *
 * All audio is BPSK-modulated on 4 data tones with continuous pilot,
 * peak-normalized to [-1, 1].
 */

import { type ModemConfig, TONE_OFFSETS, DEFAULT_CONFIG, ofdmSamples, OFDM_DEFAULTS, OFDM_TUNING } from '../types';
import { generatePreamble, type PreambleConfig } from '../protocol/preamble';
import { encodeFrame, type AtomicHeader, FRAME_SIZE, PAYLOAD_DATA_SIZE } from '../protocol/atomicFrame';
import { BPSKModulator, type BPSKModulatorConfig } from '../modulation/BPSKModulator';
import { OFDMEngine } from './ofdmEngine';
import { dlog } from '../../lib/debug/dlog';


// ─── Constants ───────────────────────────────────────

/** Number of data tones used in signaling */
const TONE_COUNT = 4;

// ─── TxEngine ────────────────────────────────────────

export class TxEngine {
  
  private cfg: ModemConfig;
  /** Absolute tone frequencies (pilot + offsets) */
  private toneFreqs: [number, number, number, number];
  /** Shared BPSK tone generator (phase accumulators, pilot, data tones) */
  private modulator: BPSKModulator;
  /** OFDM engine for OFDM/QPSK frame modulation (enabled via useOFDM flag) */
  private ofdmEngine: OFDMEngine | null = null;
  /** Whether to use OFDM/QPSK for frame payloads */
  private useOFDM = false;

  constructor(cfg: Partial<ModemConfig> & { useOFDM?: boolean } = {}) {
    // Check for OFDM flag before merging into ModemConfig
    this.useOFDM = (cfg as any).useOFDM === true;
    
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    const offsets = this.cfg.musical ? [87.5, 162.5, 287.5, 487.5] : TONE_OFFSETS;
    this.toneFreqs = [
      this.cfg.pilotFreqHz + offsets[0],
      this.cfg.pilotFreqHz + offsets[1],
      this.cfg.pilotFreqHz + offsets[2],
      this.cfg.pilotFreqHz + offsets[3],
    ] as [number, number, number, number];

    // Initialize shared BPSK modulator (no wobble/noise — TxEngine is direct)
    const modCfg: BPSKModulatorConfig = {
      sampleRate: this.cfg.sampleRate,
      pilotFreqHz: this.cfg.pilotFreqHz,
      pilotAmplitude: this.cfg.pilotAmplitude,
      dataToneAmplitude: this.cfg.dataToneAmplitude,
      toneFrequencies: new Float32Array(this.toneFreqs),
    };
    this.modulator = new BPSKModulator(modCfg);

    // Initialize OFDM engine if OFDM mode is enabled
    if (this.useOFDM) {
      dlog('TX-OFDM', {
        enabled: true,
        tones: this.cfg.toneCount,
        pilot: this.cfg.pilotFreqHz,
      });

      this.ofdmEngine = new OFDMEngine({
        pilotFreqHz: this.cfg.pilotFreqHz,
        sampleRate: this.cfg.sampleRate,
        // BPSK's pilotAmplitude (0.4) is scaled for 4 tones; OFDM peak-
        // normalizes pilot + N unit tones together, so the pilot needs the
        // OFDM-scaled value or it vanishes at high tone counts.
        pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
        toneCount: this.cfg.toneCount,
      });
    }
  }

  reset(): void {
    this.modulator.reset();
  }

  /** Check whether OFDM mode is active */
  isOFDM(): boolean {
    return this.useOFDM;
  }

  /**
   * Get symbol length in samples for the current modem configuration.
   * Returns the number of samples that constitute one symbol for the
   * active modulation scheme (BPSK or OFDM).
   */
  getSymbolLengthInSamples(): number {
    if (this.useOFDM && this.ofdmEngine) {
      // OFDM symbol = FFT window + cyclic prefix — derived from OFDM_SYMBOL_MS + OFDM_CP_MS
      const { symSamples } = ofdmSamples(this.cfg.sampleRate);
      return symSamples;
    }
    // BPSK symbol - maintain backward compatibility
    return 256;
  }

  // ─── Public API ──────────────────────────────────────

  /**
   * Generate complete audio for a file transfer.
   */
  transmitFile(fileName: string, data: Uint8Array): Float32Array {
    // Concatenate every segment, then peak-normalize the whole signal.
    // Behaviourally identical to the pre-generator implementation.
    const segments = [...this.frameSegments(fileName, data)];
    const totalLen = segments.reduce((a, b) => a + b.length, 0);
    const result = new Float32Array(totalLen);
    let offset = 0;
    for (const seg of segments) {
      result.set(seg, offset);
      offset += seg.length;
    }

    // Peak-normalize
    let peak = 0;
    for (let i = 0; i < result.length; i++) {
      const abs = Math.abs(result[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 1.0) {
      const scale = 1.0 / peak;
      for (let i = 0; i < result.length; i++) result[i] *= scale;
    }

    return result;
  }

  /**
   * Yield the audio segments of a complete file transfer, in order:
   * preamble → header (×repeats) → data frames (×repeats) → tail (×repeats)
   * → trailing silence. Single source of truth for transmission layout; both
   * the batch (`transmitFile`) and streaming (`streamChunks`) paths consume it.
   *
   * NB: NO global peak-normalize here — the batch path applies it after
   * concatenation; the streaming path relies on each OFDM symbol already being
   * peak-normed to 0.95 inside OFDMQPSKModulator.generateSymbol.
   */
  private *frameSegments(fileName: string, data: Uint8Array): Generator<Float32Array> {
    this.reset();

    // 1. Preamble: chirp (sync) + training symbols (channel est)
    if (this.useOFDM && this.ofdmEngine) {
      const syncCount = OFDM_TUNING.syncBurstSymbols;
      const trainCount = OFDM_TUNING.trainingSymbols;
      const { chirp } = this.ofdmEngine.generateChirpBurst(syncCount);
      const training = this.ofdmEngine.generateTrainingSymbols(trainCount);
      const combined = new Float32Array(chirp.length + training.length);
      combined.set(chirp, 0);
      combined.set(training, chirp.length);
      dlog('TX-OFDM', {
        chirpSamples: chirp.length,
        trainingSymbols: trainCount,
        preambleMs: Math.round((combined.length / (this.cfg.sampleRate || 48000)) * 1000),
      });
      yield combined;
    } else {
      yield this.transmitPreamble();
    }

    const totalFrames = this.calcFrameCount(data.length);
    const repeats = this.cfg.diversityMode ? 3 : 1;

    // ── Helper: dispatch to BPSK or OFDM ──
    const modulate = (header: AtomicHeader, payload: Uint8Array): Float32Array => {
      if (this.useOFDM && this.ofdmEngine) {
        dlog('TX-OFDM', { frame: `0x${header.type.toString(16)}`, seq: header.seqNum });
        const frame = encodeFrame(header, payload);
        return this.ofdmEngine.modulateFrame(frame);
      }
      return this.transmitFrame(header, payload);
    };

    // 2. Header frame (type 0x01) — repeat if diversity mode
    const headerPayload = this.buildHeaderPayload(fileName, data.length);
    const headerFrame = modulate({ type: 0x01, seqNum: 0, totalFrames, crc: 0 }, headerPayload);
    for (let r = 0; r < repeats; r++) yield headerFrame;

    // 3. Data frames (type 0x02) — repeat if diversity mode
    const dataFrames = this.splitDataIntoFrames(data);
    for (let i = 0; i < dataFrames.length; i++) {
      const frameAudio = modulate({ type: 0x02, seqNum: 1 + i, totalFrames, crc: 0 }, dataFrames[i]);
      for (let r = 0; r < repeats; r++) yield frameAudio;
    }

    // 4. Tail frame (type 0x03)
    const tailFrame = modulate(
      { type: 0x03, seqNum: totalFrames - 1, totalFrames, crc: 0 },
      new Uint8Array(PAYLOAD_DATA_SIZE),
    );
    for (let r = 0; r < repeats; r++) yield tailFrame;

    // 5. Trailing silence
    yield new Float32Array(this.getSymbolLengthInSamples() * OFDM_TUNING.tailSilenceSymbols);
  }

  /**
   * Stream a file transfer as a sequence of audio chunks of ≈chunkSamples each
   * (the final chunk may be shorter). Consumes the same frameSegments layout as
   * transmitFile but emits incrementally, so peak memory is bounded to the
   * chunk size instead of the whole waveform. No global peak-normalize (see
   * frameSegments); each OFDM symbol is already peak-normed to 0.95.
   */
  *streamChunks(fileName: string, data: Uint8Array, chunkSamples: number): Generator<Float32Array> {
    const target = Math.max(1, Math.floor(chunkSamples));
    let buf = new Float32Array(target);
    let filled = 0;
    for (const seg of this.frameSegments(fileName, data)) {
      let segOff = 0;
      while (segOff < seg.length) {
        const take = Math.min(target - filled, seg.length - segOff);
        buf.set(seg.subarray(segOff, segOff + take), filled);
        filled += take;
        segOff += take;
        if (filled === target) {
          yield buf;
          buf = new Float32Array(target);
          filled = 0;
        }
      }
    }
    if (filled > 0) yield buf.subarray(0, filled);
  }

  /**
   * Cheap upper-ish estimate of total samples for a streamed transfer, used to
   * drive the progress bar. Approximate — never used for correctness.
   */
  estimateStreamSamples(dataLen: number): number {
    const symLen = this.getSymbolLengthInSamples();
    const repeats = this.cfg.diversityMode ? 3 : 1;
    const totalFrames = this.calcFrameCount(dataLen); // header + data + tail
    let symbolsPerFrame: number;
    if (this.useOFDM && this.ofdmEngine) {
      const blockCount = Math.max(1, Math.floor(this.cfg.toneCount / 4));
      symbolsPerFrame = Math.ceil(FRAME_SIZE / blockCount);
    } else {
      symbolsPerFrame = (FRAME_SIZE * 8) / TONE_COUNT;
    }
    const preambleSamples =
      this.useOFDM && this.ofdmEngine
        ? (OFDM_TUNING.syncBurstSymbols + OFDM_TUNING.trainingSymbols) * symLen
        : this.transmitPreamble().length;
    const frameSamples = totalFrames * repeats * symbolsPerFrame * symLen;
    const silence = OFDM_TUNING.tailSilenceSymbols * symLen;
    return preambleSamples + frameSamples + silence;
  }

  /**
   * Generate just the preamble audio.
   */
  transmitPreamble(): Float32Array {
    const preambleCfg: PreambleConfig = {
      pilotFreqHz: this.cfg.pilotFreqHz,
      pilotAmplitude: this.cfg.pilotAmplitude,
      dataToneAmplitude: this.cfg.dataToneAmplitude,
      sampleRate: this.cfg.sampleRate,
      toneOffsets: this.cfg.musical
        ? [87.5, 162.5, 287.5, 487.5]
        : [TONE_OFFSETS[0], TONE_OFFSETS[1], TONE_OFFSETS[2], TONE_OFFSETS[3]],
    };
    return generatePreamble(preambleCfg);
  }

  /**
   * Generate BPSK-modulated audio for one atomic frame.
   * The audio includes the continuous pilot tone.
   */
  transmitFrame(header: AtomicHeader, payload: Uint8Array): Float32Array {
    // Build the 79-byte atomic frame
    const frame = encodeFrame(header, payload);

    // Convert frame bytes to a bitstream
    const bits: number[] = [];
    const framesPerByte = 8 / TONE_COUNT; // 2 bits per tone
    for (const byte of frame) {
      for (let f = 0; f < framesPerByte; f++) {
        const shift = 8 - (f + 1) * TONE_COUNT;
        for (let ti = 0; ti < TONE_COUNT; ti++) {
          const bit = (byte >> (shift + TONE_COUNT - 1 - ti)) & 1;
          bits.push(bit);
        }
      }
    }

    
    // BPSK fallback path (existing implementation)
    const totalSymbols = bits.length / TONE_COUNT;
    const totalSamples = totalSymbols * this.getSymbolLengthInSamples();
    const audio = new Float32Array(totalSamples);
    let bitIdx = 0;
    for (let sym = 0; sym < totalSymbols; sym++) {
      for (let t = 0; t < TONE_COUNT; t++) {
        const bit = bitIdx < bits.length ? bits[bitIdx++] : 0;
        this.modulator.bpskMul[t] = bit === 0 ? 1 : -1;
      }
      for (let s = 0; s < this.getSymbolLengthInSamples(); s++) {
        audio[sym * this.getSymbolLengthInSamples() + s] = this.modulator.generateSample();
      }
    }
    return audio;
  }

  // ─── Private helpers ────────────────────────────────

  /**
   * Build the 40-byte header frame payload.
   * Format: [fileID:4B][totalSize:4B][fileNameLen:1B][fileName...][padding...]
   */
  private buildHeaderPayload(fileName: string, totalSize: number): Uint8Array {
    const nameBytes = new TextEncoder().encode(fileName);
    const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
    let off = 0;

    // File ID hash (brief hash of filename, 4 bytes)
    let hash = 0;
    for (let i = 0; i < nameBytes.length; i++) {
      hash = (hash << 5) - hash + nameBytes[i];
      hash = hash & hash;
    }
    payload[off++] = (hash >> 24) & 0xff;
    payload[off++] = (hash >> 16) & 0xff;
    payload[off++] = (hash >> 8) & 0xff;
    payload[off++] = hash & 0xff;


    // Total file size (4 bytes LE)
    payload[off++] = totalSize & 0xff;
    payload[off++] = (totalSize >> 8) & 0xff;
    payload[off++] = (totalSize >> 16) & 0xff;
    payload[off++] = (totalSize >> 24) & 0xff;

    // File name length (1 byte, max 31)
    const nameLen = Math.min(nameBytes.length, PAYLOAD_DATA_SIZE - 9);
    payload[off++] = nameLen & 0xff;

    // File name
    for (let i = 0; i < nameLen && off < PAYLOAD_DATA_SIZE; i++) {
      payload[off++] = nameBytes[i];
    }

    // Zero-pad remaining
    while (off < PAYLOAD_DATA_SIZE) {
      payload[off++] = 0;
    }

    // Compute CRC for entire payload (40 bytes)
    const crc = this.computeCRC16(payload);
    dlog('TX-FRAME', { headerCrc: `0x${(crc >>> 0).toString(16).padStart(4, '0')}` });

    return payload;
  }

  /**
   * Calculate total frame count for a given data size.
   * Header (1) + Data (ceil(size/40)) + Tail (1)
   */
  private calcFrameCount(dataSize: number): number {
    const dataFrames = Math.max(1, Math.ceil(dataSize / PAYLOAD_DATA_SIZE));
    return dataFrames + 2; // header + data + tail
  }

  /**
   * Split file data into 40-byte chunks for atomic frames.
   * Last chunk is zero-padded.
   */
  private splitDataIntoFrames(data: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    const numDataFrames = Math.max(1, Math.ceil(data.length / PAYLOAD_DATA_SIZE));

    for (let i = 0; i < numDataFrames; i++) {
      const start = i * PAYLOAD_DATA_SIZE;
      const chunk = data.slice(start, start + PAYLOAD_DATA_SIZE);
      if (chunk.length < PAYLOAD_DATA_SIZE) {
        const padded = new Uint8Array(PAYLOAD_DATA_SIZE);
        padded.set(chunk, 0);
        frames.push(padded);
      } else {
        frames.push(chunk);
      }
    }

    return frames;
  }

  private computeCRC16(data: Uint8Array): number {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i] << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
        else crc <<= 1;
      }
    }
    return crc & 0xffff;
  }
}

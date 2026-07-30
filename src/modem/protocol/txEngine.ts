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
import {
  encodeFrame,
  type AtomicHeader,
  FRAME_SIZE,
  PAYLOAD_DATA_SIZE,
  FRAME_TYPE_HEADER,
  FRAME_TYPE_PAYLOAD,
  FRAME_TYPE_TAIL,
  FRAME_TYPE_PROFILE,
  HEADER_FRAME_REPEATS,
} from '../protocol/atomicFrame';
import { BPSKModulator, type BPSKModulatorConfig } from '../modulation/BPSKModulator';
import { OFDMEngine } from './ofdmEngine';
import {
  packLinkProfile,
  DEFAULT_LINK_PROFILE,
  qamMapToOrders,
  PROFILE_FRAME_REPEATS,
  type LinkProfile,
} from '../protocol/linkProfile';
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
  /**
   * Whether to emit the link-profile frame (Phase 4). Default FALSE —
   * live transmission is byte-identical to today unless explicitly opted in.
   */
  private emitLinkProfile = false;
  /**
   * Phase 3 per-tone qamMap (2-bit codes, see linkProfile.ts), supplied by
   * config/bit-loading policy. Only consulted when emitLinkProfile is true;
   * undefined ⇒ the announced (and used) profile is the all-QPSK default.
   */
  private qamMap: number[] | undefined;
  private qamScaleOverride: number | undefined;
  private toneGains: number[] | undefined;
  /**
   * Settle symbols emitted before the training symbols. The RX must discard
   * exactly this many (see OFDM_TUNING.trainingSettleSymbols) — the receiver
   * finds the preamble/data boundary by counting and nothing else.
   */
  private settleSymbols: number;

  constructor(
    cfg: Partial<ModemConfig> & { useOFDM?: boolean; emitLinkProfile?: boolean; qamMap?: number[]; qamScaleOverride?: number; toneGains?: number[];
      trainingSettleSymbols?: number } = {},
  ) {
    // Check for OFDM flag before merging into ModemConfig
    this.useOFDM = (cfg as any).useOFDM === true;
    this.emitLinkProfile = (cfg as any).emitLinkProfile === true;
    this.qamMap = (cfg as any).qamMap;
    this.qamScaleOverride = (cfg as any).qamScaleOverride;
    this.toneGains = (cfg as any).toneGains;
    const settleOverride = (cfg as any).trainingSettleSymbols;
    this.settleSymbols = typeof settleOverride === 'number' && Number.isFinite(settleOverride)
      ? Math.max(0, Math.round(settleOverride))
      : OFDM_TUNING.trainingSettleSymbols;

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
        qamScaleOverride: this.qamScaleOverride,
        toneGains: this.toneGains,
        toneStartHz: this.cfg.toneStartHz,
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
  transmitFile(
    fileName: string,
    data: Uint8Array,
    schemeId = 0,
    origSize = data.length,
  ): Float32Array {
    // Concatenate every segment, then peak-normalize the whole signal.
    // Behaviourally identical to the pre-generator implementation.
    const segments = [...this.frameSegments(fileName, data, schemeId, origSize)];
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
   * NB: NO global peak-normalize here — the batch path applies a safety-net
   * clamp after concatenation (see transmitFile), but should never actually
   * fire: every OFDM symbol this generator yields is already at the SAME
   * fixed, deterministic scale (see OFDMQPSKModulator's qamScale doc), with
   * worst-case |sample| <= 0.95, so the streaming path needs no
   * post-hoc normalization either — that is what makes chunked streaming
   * (streamChunks) safe: each chunk leaves the transmitter at the same level
   * as every other chunk, so the player's per-chunk clip guard never has
   * reason to rescale one chunk differently from the next.
   */
  private *frameSegments(
    fileName: string,
    data: Uint8Array,
    schemeId = 0,
    origSize = data.length,
  ): Generator<Float32Array> {
    this.reset();
    // Phase 3: always start a transmission at the base (all-QPSK) rate —
    // preamble, training, and the profile frame are always base-rate; a
    // previous transmission on this same engine instance may have left the
    // OFDM engine switched to a QAM map.
    if (this.useOFDM && this.ofdmEngine) this.ofdmEngine.resetToneOrders();

    // 1. Preamble: chirp (sync) + training symbols (channel est)
    if (this.useOFDM && this.ofdmEngine) {
      // Settle symbols first, then the ones the RX actually trains on — see
      // OFDM_TUNING.trainingSettleSymbols. The RX discards exactly the same
      // count, so both sides must read it from there.
      // Chirp length is its own lever — see OFDM_TUNING.chirpSymbols. Tying it
      // to the sync-burst pool meant raising the settle period lengthened the
      // chirp, i.e. more of the thing the settle period exists to recover from.
      const { chirp } = this.ofdmEngine.generateChirpBurst(OFDM_TUNING.chirpSymbols);
      // Settle symbols carry VARYING data and are discarded by the RX; only the
      // training symbols that follow are identical. See generateSettleSymbols
      // for why a stationary settle period breaks the channel estimate.
      const settle = this.ofdmEngine.generateSettleSymbols(this.settleSymbols);
      const training = this.ofdmEngine.generateTrainingSymbols(OFDM_TUNING.trainingSymbols);
      const combined = new Float32Array(chirp.length + settle.length + training.length);
      combined.set(chirp, 0);
      combined.set(settle, chirp.length);
      combined.set(training, chirp.length + settle.length);
      dlog('TX-OFDM', {
        chirpSamples: chirp.length,
        trainingSymbols: OFDM_TUNING.trainingSymbols,
        settleSymbols: this.settleSymbols,
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

    // 1b. Link-profile frame (Phase 4, flag-gated) — sent AFTER training,
    // BEFORE the header, always at the base rate (today's exact modulation:
    // all-QPSK, RS t=6, 5ms CP) so it decodes before any profile is known.
    // Sent ×2 (cheap insurance — a lost profile kills interpretation of the
    // whole transmission). Default OFF: emits nothing, waveform unchanged.
    if (this.emitLinkProfile) {
      const profile: LinkProfile = this.qamMap
        ? { ...DEFAULT_LINK_PROFILE(this.cfg.toneCount), qamMap: this.qamMap }
        : DEFAULT_LINK_PROFILE(this.cfg.toneCount);
      const profilePayload = packLinkProfile(profile);
      const profileFrame = modulate(
        { type: FRAME_TYPE_PROFILE, seqNum: 0, totalFrames, crc: 0 },
        profilePayload,
      );
      for (let r = 0; r < PROFILE_FRAME_REPEATS; r++) yield profileFrame;

      // Phase 3: NOW switch the OFDM engine to the announced qamMap — after
      // the profile itself (base-rate) but before header/data/tail, which
      // are the frames the profile describes. This is the ONE switch point
      // on the TX side (see plan deviation doc at the top of this file's
      // sibling rxEngine.ts for the matching RX-side switch point).
      if (this.useOFDM && this.ofdmEngine && this.qamMap) {
        const orders = qamMapToOrders(this.qamMap);
        this.ofdmEngine.setToneOrders(orders);
        // QAM reference symbols (see OFDM_TUNING.qamRefSymbols doc): only
        // when some tone is actually above QPSK — an all-QPSK qamMap must
        // leave the waveform byte-identical to before this feature existed.
        if (!orders.every((o) => o === 2)) {
          yield this.ofdmEngine.modulateQamRefSymbols();
        }
      }
    }

    // 2. Header frame (type 0x01) — repeated at least HEADER_FRAME_REPEATS
    // times unconditionally (a lost header kills the whole transfer), or
    // `repeats` times when diversity mode already sends more than that.
    const headerPayload = this.buildHeaderPayload(fileName, data.length, schemeId, origSize);
    const headerFrame = modulate({ type: FRAME_TYPE_HEADER, seqNum: 0, totalFrames, crc: 0 }, headerPayload);
    const headerRepeats = Math.max(repeats, HEADER_FRAME_REPEATS);
    for (let r = 0; r < headerRepeats; r++) yield headerFrame;

    // 3. Data frames (type 0x02) — repeat if diversity mode
    const dataFrames = this.splitDataIntoFrames(data);
    for (let i = 0; i < dataFrames.length; i++) {
      const frameAudio = modulate({ type: FRAME_TYPE_PAYLOAD, seqNum: 1 + i, totalFrames, crc: 0 }, dataFrames[i]);
      for (let r = 0; r < repeats; r++) yield frameAudio;
    }

    // 4. Tail frame (type 0x03)
    const tailFrame = modulate(
      { type: FRAME_TYPE_TAIL, seqNum: totalFrames - 1, totalFrames, crc: 0 },
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
   * frameSegments); every OFDM symbol already sits at the same fixed
   * qamScale, so no chunk needs (or gets) independent rescaling.
   */
  *streamChunks(
    fileName: string,
    data: Uint8Array,
    chunkSamples: number,
    schemeId = 0,
    origSize = data.length,
  ): Generator<Float32Array> {
    const target = Math.max(1, Math.floor(chunkSamples));
    let buf = new Float32Array(target);
    let filled = 0;
    for (const seg of this.frameSegments(fileName, data, schemeId, origSize)) {
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
    const headerRepeats = Math.max(repeats, HEADER_FRAME_REPEATS);
    const totalFrames = this.calcFrameCount(dataLen); // header + data + tail
    const dataAndTailFrames = totalFrames - 1; // everything except the header
    let symbolsPerFrame: number;
    if (this.useOFDM && this.ofdmEngine) {
      const blockCount = Math.max(1, Math.floor(this.cfg.toneCount / 4));
      symbolsPerFrame = Math.ceil(FRAME_SIZE / blockCount);
    } else {
      symbolsPerFrame = (FRAME_SIZE * 8) / TONE_COUNT;
    }
    const preambleSamples =
      this.useOFDM && this.ofdmEngine
        // chirpSymbols, not syncBurstSymbols — this must mirror what the
        // preamble actually emits (chirp + settle + training), or the
        // speed-test's duration estimate drifts from reality.
        ? (OFDM_TUNING.chirpSymbols
            + OFDM_TUNING.trainingSymbols
            + this.settleSymbols) * symLen
        : this.transmitPreamble().length;
    // Header is repeated `headerRepeats` times (>= HEADER_FRAME_REPEATS,
    // unconditionally); data + tail frames repeated `repeats` times each
    // (diversity mode only).
    const frameSamples =
      (headerRepeats + dataAndTailFrames * repeats) * symbolsPerFrame * symLen;
    // Link-profile frame (Phase 4, flag-gated): sent PROFILE_FRAME_REPEATS
    // times at the base rate, plus OFDM_TUNING.qamRefSymbols training symbols
    // when the announced qamMap uses anything above QPSK.
    let profileSamples = 0;
    if (this.emitLinkProfile) {
      profileSamples += PROFILE_FRAME_REPEATS * symbolsPerFrame * symLen;
      if (this.useOFDM && this.qamMap && !qamMapToOrders(this.qamMap).every((o) => o === 2)) {
        profileSamples += OFDM_TUNING.qamRefSymbols * symLen;
      }
    }
    const silence = OFDM_TUNING.tailSilenceSymbols * symLen;
    return preambleSamples + frameSamples + profileSamples + silence;
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
   * Build the header frame payload (PAYLOAD_DATA_SIZE bytes, currently 160).
   * Format: [fileID:4B][totalSize:4B][fileNameLen:1B][fileName...][schemeId:1B][origSize:4B LE][padding...]
   *
   * `totalSize` is the WIRE (post-compression) size — legacy progress math
   * depends on this remaining the size of what's actually transmitted.
   * `schemeId`/`origSize` (Phase 6 compression) are appended immediately
   * after the file name, ahead of the zero-pad, so a legacy RX (which only
   * reads up to the name and ignores the rest as padding) stays compatible;
   * a new RX reads them back to restore the true (decompressed) size.
   */
  private buildHeaderPayload(
    fileName: string,
    totalSize: number,
    schemeId = 0,
    origSize = totalSize,
  ): Uint8Array {
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

    // File name length (1 byte) — reserve 5 trailing bytes for
    // [schemeId:1][origSize:4] appended right after the name.
    const nameLen = Math.min(nameBytes.length, PAYLOAD_DATA_SIZE - 9 - 5);
    payload[off++] = nameLen & 0xff;

    // File name
    for (let i = 0; i < nameLen && off < PAYLOAD_DATA_SIZE; i++) {
      payload[off++] = nameBytes[i];
    }

    // Compression scheme id (1 byte) + original (decompressed) size (4 bytes LE)
    if (off < PAYLOAD_DATA_SIZE) payload[off++] = schemeId & 0xff;
    payload[off++] = origSize & 0xff;
    payload[off++] = (origSize >> 8) & 0xff;
    payload[off++] = (origSize >> 16) & 0xff;
    payload[off++] = (origSize >> 24) & 0xff;

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

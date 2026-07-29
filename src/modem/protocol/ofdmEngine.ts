/**
 * OFDMEngine — OFDM/QPSK transmission engine for atomic frames.
 *
 * Native-rate: all timing is derived from OFDM_SYMBOL_MS + OFDM_CP_MS via
 * ofdmSamples(), which yields integer window sizes at any hardware rate.
 * Tone frequencies are absolute Hz on the 25 Hz grid (integer cycles per
 * window ⇒ orthogonal at any sample rate). No FFT, no power-of-two constraint.
 *
 * Sync burst: chirped pilot (LFM sweep) for frequency-diversity timing.
 * Training: standard OFDM all-zero symbols for per-tone channel estimation.
 */
import { ofdmSamples, ofdmToneFrequencies, OFDM_DEFAULTS } from '../types';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import type { QamOrder } from '../modulation/constellation';
import { generateChirp, type ChirpConfig } from './chirp';
import { dlog } from '../../lib/debug/dlog';

export class OFDMEngine {
  private toneCount: number;
  private toneFreqs: Float32Array;
  private ofdm: OFDMQPSKModulator;
  private pilotFreqHz: number;
  private sampleRate: number;
  private symSamples: number;
  /** Chirp span (Hz) around pilot; sweep goes pilot±span/2 */
  private chirpSpanHz: number;

  // Per-tone bit-loading (Phase 3). Default: every tone QPSK, which keeps
  // modulateFrame() on the untouched legacy 4-tone/nibble-lane path (see
  // modulateFrameQpsk) — byte-identical to the pre-QAM engine. Only changed
  // by setToneOrders(), called by TxEngine exactly once per transmission,
  // right after the base-rate PROFILE frame is yielded.
  private toneOrders: QamOrder[];
  private allQpsk = true;

  constructor(cfg: {
    sampleRate: number;
    toneCount?: number;
    pilotFreqHz?: number;
    pilotAmplitude?: number;
    chirpSpanHz?: number;
    qamScaleOverride?: number;
  }) {
    const toneCount = cfg.toneCount ?? OFDM_DEFAULTS.toneCount;
    this.toneCount = toneCount % 4 !== 0 ? 4 : toneCount;
    if (toneCount % 4 !== 0) {
      dlog('TX-OFDM', { badToneCount: toneCount, using: 4 }, { level: 'warn' });
    }

    const pilotFreqHz = cfg.pilotFreqHz ?? 1900;
    const pilotAmplitude = cfg.pilotAmplitude ?? 2.0;
    this.pilotFreqHz = pilotFreqHz;
    this.sampleRate = cfg.sampleRate;
    this.chirpSpanHz = cfg.chirpSpanHz ?? 200;
    const { symSamples } = ofdmSamples(cfg.sampleRate);
    this.symSamples = symSamples;

    this.toneFreqs = ofdmToneFrequencies({ toneCount: this.toneCount, pilotFreqHz });

    this.ofdm = new OFDMQPSKModulator({
      sampleRate: cfg.sampleRate,
      toneFrequencies: this.toneFreqs,
      pilotFreqHz,
      pilotAmplitude,
      qamScaleOverride: cfg.qamScaleOverride,
    });
    this.toneOrders = new Array(this.toneCount).fill(2) as QamOrder[];

    dlog('TX-OFDM', {
      pilot: pilotFreqHz,
      tones: Array.from(this.toneFreqs).map((f) => f.toFixed(1)),
    });
  }

  /** Chirped sync burst — linear sweep across chirpSpanHz for timing detection. */
  generateChirpBurst(symbolCount: number): { chirp: Float32Array; chirpCfg: ChirpConfig } {
    const durationSec = (symbolCount * this.symSamples) / this.sampleRate;
    const halfSpan = this.chirpSpanHz / 2;
    const chirpCfg: ChirpConfig = {
      fStart: this.pilotFreqHz - halfSpan,
      fEnd: this.pilotFreqHz + halfSpan,
      durationSec,
      sampleRate: this.sampleRate,
    };
    const chirp = generateChirp(chirpCfg);
    dlog('TX-OFDM', {
      chirp: `${chirpCfg.fStart}-${chirpCfg.fEnd}Hz`,
      durMs: Math.round(durationSec * 1000),
      samples: chirp.length,
    });
    return { chirp, chirpCfg };
  }

  /** Training symbols — standard OFDM with all tones at QPSK 0° for channel estimation. */
  generateTrainingSymbols(count: number): Float32Array {
    return this.generateSyncBurst(count);
  }

  generateSyncBurst(count: number): Float32Array {
    const zeros = new Array(this.toneCount).fill(0);
    const parts: Float32Array[] = [];
    for (let i = 0; i < count; i++) {
      this.ofdm.setSymbols(zeros);
      parts.push(this.ofdm.generateSymbol());
    }
    const totalLen = parts.reduce((a, b) => a + b.length, 0);
    const audio = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }
    return audio;
  }

  /**
   * Per-tone bit-loading (Phase 3): assign each tone's constellation order
   * for TX. Default (never called) is all-QPSK, which keeps modulateFrame()
   * on the legacy byte-identical nibble-lane path.
   */
  setToneOrders(orders: QamOrder[]): void {
    this.ofdm.setToneOrders(orders);
    this.toneOrders = orders.slice();
    this.allQpsk = orders.every((o) => o === 2);
  }

  /**
   * Reset to the base (all-QPSK) rate — called at the start of every
   * transmission (TxEngine.frameSegments), so preamble/training/profile
   * frames are always modulated at the base rate regardless of what a
   * previous transmission on this engine instance left it at.
   */
  resetToneOrders(): void {
    this.setToneOrders(new Array(this.toneCount).fill(2) as QamOrder[]);
  }

  /**
   * Modulate a frame. All-QPSK (default): tones are grouped into 4-tone
   * blocks; each block carries one byte per OFDM symbol (upper nibble on the
   * b0 bit lane, lower nibble on b1) — UNCHANGED, byte-identical to the
   * pre-QAM engine. If any tone's order is above QPSK, a generic per-tone
   * bit-serializer is used instead (see modulateFrameGeneric).
   */
  modulateFrame(frame: Uint8Array): Float32Array {
    return this.allQpsk ? this.modulateFrameQpsk(frame) : this.modulateFrameGeneric(frame);
  }

  /** Legacy all-QPSK frame modulation — UNCHANGED from the pre-QAM engine. */
  private modulateFrameQpsk(frame: Uint8Array): Float32Array {
    const blockCount = Math.max(1, Math.floor(this.toneCount / 4));
    const parts: Float32Array[] = [];
    for (let i = 0; i < frame.length; i += blockCount) {
      const symbols: number[] = new Array(this.toneCount).fill(0);
      for (let blk = 0; blk < blockCount; blk++) {
        const byte = i + blk < frame.length ? frame[i + blk] : 0x00;
        const upper = (byte >> 4) & 0xf;
        const lower = byte & 0xf;
        for (let j = 0; j < 4; j++) {
          const b0 = (upper >> (3 - j)) & 1;
          const b1 = (lower >> (3 - j)) & 1;
          symbols[blk * 4 + j] = (b0 << 1) | b1;
        }
      }
      this.ofdm.setSymbols(symbols);
      parts.push(this.ofdm.generateSymbol());
    }
    const totalLen = parts.reduce((a, b) => a + b.length, 0);
    const audio = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }
    return audio;
  }

  /**
   * Generic per-tone bit-serializer — taken only when some tone's order is
   * above QPSK. Drains `frame` bytes MSB-first into a bit queue; per OFDM
   * symbol, each tone t takes `toneOrders[t]` bits off the queue (MSB-first)
   * and maps them to a constellation index. The final symbol of the frame is
   * padded with zero bits (mirrors the legacy path's zero-byte padding).
   *
   * rxEngine.feedSample's generic path is the exact inverse: it accumulates
   * demodulated per-tone bits (same tone order, same MSB-first convention)
   * into a byte buffer and feeds SentinelScanner as 8 bits fill — see the
   * comment there for the shared contract.
   */
  private modulateFrameGeneric(frame: Uint8Array): Float32Array {
    const bitsPerSymbol = this.toneOrders.reduce((a, b) => a + b, 0);
    const totalBits = frame.length * 8;
    const symbolCount = Math.ceil(totalBits / Math.max(1, bitsPerSymbol));

    let byteIdx = 0;
    let bitInByte = 0; // 0 = MSB of frame[byteIdx]
    const nextBit = (): number => {
      if (byteIdx >= frame.length) return 0; // pad past the frame's end
      const bit = (frame[byteIdx] >> (7 - bitInByte)) & 1;
      bitInByte++;
      if (bitInByte === 8) {
        bitInByte = 0;
        byteIdx++;
      }
      return bit;
    };

    const parts: Float32Array[] = [];
    for (let s = 0; s < symbolCount; s++) {
      const symbols: number[] = new Array(this.toneCount);
      for (let t = 0; t < this.toneCount; t++) {
        const order = this.toneOrders[t];
        let value = 0;
        for (let b = 0; b < order; b++) value = (value << 1) | nextBit();
        symbols[t] = value;
      }
      this.ofdm.setSymbols(symbols);
      parts.push(this.ofdm.generateSymbol());
    }
    const totalLen = parts.reduce((a, b) => a + b.length, 0);
    const audio = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }
    return audio;
  }
}

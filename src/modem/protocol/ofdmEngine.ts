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

  constructor(cfg: {
    sampleRate: number;
    toneCount?: number;
    pilotFreqHz?: number;
    pilotAmplitude?: number;
    chirpSpanHz?: number;
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
    });

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
   * Modulate a frame. Tones are grouped into 4-tone blocks; each block carries
   * one byte per OFDM symbol (upper nibble on the b0 bit lane, lower nibble on
   * b1). 4 tones → 1 byte/symbol, 8 tones → 2 bytes/symbol, 16 tones → 4 bytes/symbol.
   */
  modulateFrame(frame: Uint8Array): Float32Array {
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
}

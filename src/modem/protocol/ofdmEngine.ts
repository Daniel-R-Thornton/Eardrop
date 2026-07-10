/**
 * OFDMEngine — OFDM/QPSK transmission engine for atomic frames.
 *
 * Native-rate: all timing is derived from OFDM_SYMBOL_MS + OFDM_CP_MS via
 * ofdmSamples(), which yields integer window sizes at any hardware rate.
 * Tone frequencies are absolute Hz on the 25 Hz grid (integer cycles per
 * window ⇒ orthogonal at any sample rate). No FFT, no power-of-two constraint.
 */
import { ofdmSamples, ofdmToneFrequencies } from '../types';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { dlog } from '../../lib/debug/dlog';

export class OFDMEngine {
  private toneCount: number;
  private toneFreqs: Float32Array;
  private ofdm: OFDMQPSKModulator;
  private pilotFreqHz: number;

  constructor(cfg: { sampleRate: number; toneCount?: number; pilotFreqHz?: number; pilotAmplitude?: number }) {
    const toneCount = cfg.toneCount ?? 16;
    this.toneCount = toneCount % 4 !== 0 ? 4 : toneCount;
    if (toneCount % 4 !== 0) {
      dlog('TX-OFDM', { badToneCount: toneCount, using: 4 }, { level: 'warn' });
    }

    const pilotFreqHz = cfg.pilotFreqHz ?? 1900;
    const pilotAmplitude = cfg.pilotAmplitude ?? 2.0;
    this.pilotFreqHz = pilotFreqHz;

    this.toneFreqs = ofdmToneFrequencies({ toneCount: this.toneCount });

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

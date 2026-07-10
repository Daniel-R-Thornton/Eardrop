/**
 * OFDMEngine — OFDM/QPSK transmission engine for atomic frames.
 * Uses fixed 256-point IFFT/FFT (12.5 sym/s) matching the atomic frame
 * protocol's SPS. Tone count configurable.
 */

import { type ModemConfig, DEFAULT_CONFIG, TONE_OFFSETS } from '../types';
import { OFDMQPSKModulator, type OFDMQPSKModulatorConfig } from '../modulation/OFDMQPSKModulator';
import { makeToneOffsets, makeToneFrequencies } from '../../lib/math';
import { dlog } from '../../lib/debug/dlog';

const FFT_SIZE = 256;
/** Cyclic prefix length in samples — provides timing guard interval */
const CP_LENGTH = 16;
/** Total OFDM symbol length = FFT + CP */
const SYM_LEN = FFT_SIZE + CP_LENGTH;

export class OFDMEngine {
  /** FFT size for OFDM — number of subcarriers (256 bins) */
  static readonly FFT_SIZE = 256;
  /** Cyclic prefix length in samples */
  static readonly CP_LENGTH = 16;

  private cfg: ModemConfig;
  private ofdm: OFDMQPSKModulator;
  private toneFreqs: Float32Array;
  private toneCount: number;

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.toneCount = this.cfg.toneCount || 4;
    if (this.toneCount % 4 !== 0) {
      dlog('TX-OFDM', { badToneCount: this.toneCount, using: 4 }, { level: 'warn' });
      this.toneCount = 4;
    }

    const offsets = makeToneOffsets(this.toneCount, 100, 100);
    this.toneFreqs = makeToneFrequencies(this.cfg.pilotFreqHz, offsets);

    const ofdmCfg: OFDMQPSKModulatorConfig = {
      sampleRate: this.cfg.sampleRate,
      toneCount: this.toneCount,
      ifftSize: FFT_SIZE,
      // IFFT raw peak = (toneCount*2 + pilotAmplitude*2) / FFT_SIZE for real-valued output.
      // Scale to 0.95 so output fills [-0.95, 0.95] range.
      amplitude: 0.95 / ((this.toneCount * 2 + this.cfg.pilotAmplitude * 2) / FFT_SIZE),
      pilotFreqHz: this.cfg.pilotFreqHz,
      pilotAmplitude: this.cfg.pilotAmplitude,
      toneFrequencies: this.toneFreqs,
      cpLength: CP_LENGTH,
    };
    this.ofdm = new OFDMQPSKModulator(ofdmCfg);
    dlog('TX-OFDM', {
      pilot: this.cfg.pilotFreqHz,
      pilotBin: Math.round((this.cfg.pilotFreqHz * FFT_SIZE) / this.cfg.sampleRate),
      tones: Array.from(this.toneFreqs).map((f) => f.toFixed(1)),
      bins: Array.from(this.toneFreqs).map((f) => Math.round((f * FFT_SIZE) / this.cfg.sampleRate)),
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
   * b1). 4 tones → 1 byte/symbol, 8 tones → 2 bytes/symbol. A trailing odd
   * byte is padded with 0x00 — the frame is byte-exact from the sentinel, so
   * pad bits are inert.
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

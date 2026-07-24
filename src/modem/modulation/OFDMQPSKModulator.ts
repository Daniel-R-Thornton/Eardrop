/**
 * OFDMQPSKModulator — native-rate multitone QPSK synthesis.
 *
 * No IFFT: tone frequencies are absolute Hz on the 1/OFDM_SYMBOL_MS grid, so
 * each completes an integer number of cycles per window and the set is
 * orthogonal at ANY sample rate. Direct cosine synthesis; the cyclic prefix
 * is the tail of the window copied to the front, exactly as before.
 */
import { ofdmSamples } from '../types';

export interface OFDMQPSKModulatorConfig {
  sampleRate: number;
  toneFrequencies: Float32Array;
  pilotFreqHz: number;
  pilotAmplitude: number;
}

function qpskPhase(symbol: number): number {
  return (symbol % 4) * (Math.PI / 2);
}

export class OFDMQPSKModulator {
  private cfg: OFDMQPSKModulatorConfig;
  private phases: number[];
  private fftSamples: number;
  private cpSamples: number;

  // Precomputed per-tone basis samples: sinTable[t][n] = sin(2π·f[t]·n/Fs),
  // cosTable[t][n] = cos(...). Tones and pilot are identical across every
  // symbol; only the QPSK phase (a multiple of π/2) varies, so each tone's
  // contribution is ±sin or ±cos of the same argument. Precomputing these
  // once turns the per-sample inner loop from a Math.sin call per (n,t) into
  // a table read + sign — the dominant encode cost.
  private sinTable: Float32Array[];
  private cosTable: Float32Array[];
  private pilotTable: Float32Array;
  // Per-symbol selectors (rebuilt in setSymbols): which table to read and the
  // sign to apply, derived from the QPSK symbol value 0..3.
  private selTable: Float32Array[];
  private selSign: Float32Array;

  constructor(config: OFDMQPSKModulatorConfig) {
    this.cfg = config;
    const numTones = config.toneFrequencies.length;
    this.phases = new Array(numTones).fill(0);
    const { fftSamples, cpSamples } = ofdmSamples(config.sampleRate);
    this.fftSamples = fftSamples;
    this.cpSamples = cpSamples;

    const twoPiOverFs = (2 * Math.PI) / config.sampleRate;
    this.sinTable = new Array(numTones);
    this.cosTable = new Array(numTones);
    for (let t = 0; t < numTones; t++) {
      const s = new Float32Array(fftSamples);
      const c = new Float32Array(fftSamples);
      const w = twoPiOverFs * config.toneFrequencies[t];
      for (let n = 0; n < fftSamples; n++) {
        s[n] = Math.sin(w * n);
        c[n] = Math.cos(w * n);
      }
      this.sinTable[t] = s;
      this.cosTable[t] = c;
    }
    this.pilotTable = new Float32Array(fftSamples);
    const wp = twoPiOverFs * config.pilotFreqHz;
    for (let n = 0; n < fftSamples; n++) {
      this.pilotTable[n] = config.pilotAmplitude * Math.cos(wp * n);
    }
    // Default selectors: symbol 0 (0° ⇒ +sin) on every tone.
    this.selTable = this.sinTable.slice();
    this.selSign = new Float32Array(numTones).fill(1);
  }

  setSymbols(symbols: number[]): void {
    if (symbols.length !== this.cfg.toneFrequencies.length) {
      throw new Error(
        `Expected ${this.cfg.toneFrequencies.length} symbols, got ${symbols.length}`,
      );
    }
    this.phases = symbols.map(qpskPhase);
    // sin(base + k·π/2): 0→+sin, 1→+cos, 2→−sin, 3→−cos
    for (let t = 0; t < symbols.length; t++) {
      const s = ((symbols[t] % 4) + 4) % 4;
      this.selTable[t] = s === 1 || s === 3 ? this.cosTable[t] : this.sinTable[t];
      this.selSign[t] = s === 2 || s === 3 ? -1 : 1;
    }
  }

  generateSymbol(): Float32Array {
    const { toneFrequencies } = this.cfg;
    const numTones = toneFrequencies.length;
    const body = new Float32Array(this.fftSamples);
    const { pilotTable, selTable, selSign } = this;
    for (let n = 0; n < this.fftSamples; n++) {
      let acc = pilotTable[n];
      for (let t = 0; t < numTones; t++) {
        acc += selSign[t] * selTable[t][n];
      }
      body[n] = acc;
    }
    // Peak-normalize to 0.95
    let peak = 0;
    for (let n = 0; n < body.length; n++) peak = Math.max(peak, Math.abs(body[n]));
    const scale = peak > 0 ? 0.95 / peak : 1;
    for (let n = 0; n < body.length; n++) body[n] *= scale;
    // Cyclic prefix
    const out = new Float32Array(this.fftSamples + this.cpSamples);
    out.set(body.subarray(this.fftSamples - this.cpSamples), 0);
    out.set(body, this.cpSamples);
    return out;
  }
}

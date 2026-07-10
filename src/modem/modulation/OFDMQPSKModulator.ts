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

  constructor(config: OFDMQPSKModulatorConfig) {
    this.cfg = config;
    this.phases = new Array(config.toneFrequencies.length).fill(0);
    const { fftSamples, cpSamples } = ofdmSamples(config.sampleRate);
    this.fftSamples = fftSamples;
    this.cpSamples = cpSamples;
  }

  setSymbols(symbols: number[]): void {
    if (symbols.length !== this.cfg.toneFrequencies.length) {
      throw new Error(
        `Expected ${this.cfg.toneFrequencies.length} symbols, got ${symbols.length}`,
      );
    }
    this.phases = symbols.map(qpskPhase);
  }

  generateSymbol(): Float32Array {
    const { sampleRate, toneFrequencies, pilotFreqHz, pilotAmplitude } = this.cfg;
    const body = new Float32Array(this.fftSamples);
    const twoPiOverFs = (2 * Math.PI) / sampleRate;
    for (let n = 0; n < this.fftSamples; n++) {
      let acc = pilotAmplitude * Math.cos(twoPiOverFs * pilotFreqHz * n);
      for (let t = 0; t < toneFrequencies.length; t++) {
        acc += Math.sin(twoPiOverFs * toneFrequencies[t] * n + this.phases[t]);
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

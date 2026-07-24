/**
 * OFDMQPSKModulator — native-rate multitone QPSK synthesis.
 *
 * No IFFT: tone frequencies are absolute Hz on the 1/OFDM_SYMBOL_MS grid, so
 * each completes an integer number of cycles per window and the set is
 * orthogonal at ANY sample rate. Direct cosine synthesis; the cyclic prefix
 * is the tail of the window copied to the front, exactly as before.
 */
import { ofdmSamples } from '../types';
import { MAX_QAM_MAGNITUDE, mapSymbol, type QamOrder } from './constellation';

export interface OFDMQPSKModulatorConfig {
  sampleRate: number;
  toneFrequencies: Float32Array;
  pilotFreqHz: number;
  pilotAmplitude: number;
  /**
   * Fixed per-tone TX scale used ONLY when at least one tone is above QPSK
   * (see generateSymbol). Default: derived in the constructor from the
   * worst-case fully-aligned sum of every tone at the largest QAM corner
   * point plus the pilot, backed off to a 0.95 peak target — see the
   * `qamScale` field doc below for the honest PAPR caveat. Override only for
   * tuning against real hardware headroom.
   */
  qamScaleOverride?: number;
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

  // Per-tone bit-loading (Phase 3). Default: every tone QPSK (order 2), which
  // keeps generateSymbol on the untouched legacy sign/table path below —
  // byte-identical to the pre-QAM modem. Only set by setToneOrders().
  private toneOrders: QamOrder[];
  private allQpsk: boolean;
  // Per-tone (re, im) constellation points for the current symbol, used ONLY
  // by the QAM synthesis path (allQpsk === false). Kept as flat Float32Arrays
  // to mirror sinTable/cosTable's access pattern.
  private symRe: Float32Array;
  private symIm: Float32Array;
  // Fixed per-tone TX scale for the QAM path — see config doc + constructor.
  private readonly qamScale: number;

  constructor(config: OFDMQPSKModulatorConfig) {
    this.cfg = config;
    const numTones = config.toneFrequencies.length;
    this.phases = new Array(numTones).fill(0);
    const { fftSamples, cpSamples } = ofdmSamples(config.sampleRate);
    this.fftSamples = fftSamples;
    this.cpSamples = cpSamples;
    this.toneOrders = new Array(numTones).fill(2) as QamOrder[];
    this.allQpsk = true;
    this.symRe = new Float32Array(numTones);
    this.symIm = new Float32Array(numTones);
    // Fixed QAM-path scale: bound the worst case where every tone lands on
    // its largest QAM corner point (MAX_QAM_MAGNITUDE, from the 64-QAM
    // corner) fully in-phase, plus the pilot, then back off to a 0.95 peak.
    // This is a hard worst-case bound, not a measured-PAPR estimate — actual
    // multitone peaks are far below full alignment almost always (the CLT
    // sum-of-random-phases result), so real symbols will sit well under 0.95
    // peak on average. That's an intentional, documented loudness trade —
    // amplitude STABILITY across symbols (a fixed scale) is the requirement
    // here, not peak loudness; hardware-tuning a tighter back-off constant is
    // left for later per the plan.
    this.qamScale =
      config.qamScaleOverride ??
      0.95 / (numTones * MAX_QAM_MAGNITUDE + config.pilotAmplitude);

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

  /**
   * Per-tone bit-loading (Phase 3): assign each tone's constellation order.
   * Default (never called) is all-QPSK, which keeps generateSymbol on the
   * legacy byte-identical path. Length must match toneFrequencies.
   */
  setToneOrders(orders: QamOrder[]): void {
    if (orders.length !== this.cfg.toneFrequencies.length) {
      throw new Error(
        `Expected ${this.cfg.toneFrequencies.length} tone orders, got ${orders.length}`,
      );
    }
    this.toneOrders = orders.slice();
    this.allQpsk = orders.every((o) => o === 2);
  }

  setSymbols(symbols: number[]): void {
    if (symbols.length !== this.cfg.toneFrequencies.length) {
      throw new Error(
        `Expected ${this.cfg.toneFrequencies.length} symbols, got ${symbols.length}`,
      );
    }
    if (this.allQpsk) {
      // Legacy path: symbols are QPSK phase indices 0..3. UNCHANGED from the
      // pre-QAM modem — this is what keeps generateSymbol byte-identical
      // when every tone is QPSK (the default and today's only mode).
      this.phases = symbols.map(qpskPhase);
      // sin(base + k·π/2): 0→+sin, 1→+cos, 2→−sin, 3→−cos
      for (let t = 0; t < symbols.length; t++) {
        const s = ((symbols[t] % 4) + 4) % 4;
        this.selTable[t] = s === 1 || s === 3 ? this.cosTable[t] : this.sinTable[t];
        this.selSign[t] = s === 2 || s === 3 ? -1 : 1;
      }
      return;
    }
    // QAM path: each symbols[t] is the integer constellation index (0..2^order-1)
    // for that tone's assigned order. Map to a (re, im) point once per symbol;
    // generateSymbol synthesizes re·cos − im·sin per tone from these.
    for (let t = 0; t < symbols.length; t++) {
      const { re, im } = mapSymbol(symbols[t], this.toneOrders[t]);
      this.symRe[t] = re;
      this.symIm[t] = im;
    }
  }

  generateSymbol(): Float32Array {
    const body = this.allQpsk ? this.synthesizeQpsk() : this.synthesizeQam();
    // Cyclic prefix
    const out = new Float32Array(this.fftSamples + this.cpSamples);
    out.set(body.subarray(this.fftSamples - this.cpSamples), 0);
    out.set(body, this.cpSamples);
    return out;
  }

  /** Legacy all-QPSK synthesis — UNCHANGED, byte-identical to the pre-QAM modem. */
  private synthesizeQpsk(): Float32Array {
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
    return body;
  }

  /**
   * Mixed/higher-order synthesis — taken only when some tone's order > QPSK.
   * Standard quadrature synthesis re·cos(2πfn) − im·sin(2πfn) per tone, reusing
   * the same precomputed sin/cos tables as the legacy path. Uses the FIXED
   * qamScale (not per-symbol peak-normalize) so every tone's amplitude is
   * stable across symbols — required for amplitude to be a usable decision
   * axis on 16/64-QAM.
   */
  private synthesizeQam(): Float32Array {
    const { toneFrequencies } = this.cfg;
    const numTones = toneFrequencies.length;
    const body = new Float32Array(this.fftSamples);
    const { pilotTable, sinTable, cosTable, symRe, symIm, qamScale } = this;
    for (let n = 0; n < this.fftSamples; n++) {
      let acc = pilotTable[n];
      for (let t = 0; t < numTones; t++) {
        acc += symRe[t] * cosTable[t][n] - symIm[t] * sinTable[t][n];
      }
      body[n] = acc * qamScale;
    }
    return body;
  }
}

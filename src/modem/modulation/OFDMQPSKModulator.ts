/**
 * OFDMQPSKModulator — native-rate multitone QPSK synthesis.
 *
 * No IFFT: tone frequencies are absolute Hz on the 1/OFDM_SYMBOL_MS grid, so
 * each completes an integer number of cycles per window and the set is
 * orthogonal at ANY sample rate. Direct cosine synthesis; the cyclic prefix
 * is the tail of the window copied to the front, exactly as before.
 */
import { ofdmSamples } from '../types';
import { mapSymbol, type ConstellationPoint, type QamOrder } from './constellation';

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
    // Fixed QAM-path scale (stable across symbols — the requirement for
    // amplitude to be a usable decision axis; the demod derives its reference
    // from this same value so raising it is safe).
    //
    // PAPR back-off, not the worst case: an OFDM symbol is a sum of N
    // independent tones, so by the CLT its peak sits at ~CREST·RMS, far below
    // the all-tones-aligned worst case. Targeting the worst case made QAM data
    // ~2.5× quieter than the per-symbol-normalized QPSK preamble → after the
    // player normalizes the whole signal to the loud preamble, the QAM data
    // lost ~8 dB of SNR and failed to decode even on a pristine link. Instead
    // target a high-percentile peak at 0.95: RMS = sqrt(Σ tone power + pilot²)
    // (constellation is unit average power), peak ≈ CREST·RMS. CREST=3.5
    // (~11 dB) covers ~99.9% of symbols; the rare over-peak clips harmlessly.
    // This makes QAM data as loud as QPSK so its SNR is fair.
    const CREST = 3.5;
    const rms = Math.sqrt(numTones + config.pilotAmplitude * config.pilotAmplitude);
    this.qamScale = config.qamScaleOverride ?? 0.95 / (CREST * rms);

    const twoPiOverFs = (2 * Math.PI) / config.sampleRate;
    // Precomputed sin/cos tables: each is a Float32Array of fftSamples.
    // Memory footprint is approximately 2 * toneCount * fftSamples * 4 bytes
    // (plus one pilotTable of fftSamples * 4 bytes).
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
  /**
   * Fixed QAM-path scale (see the `qamScale` field/config doc above) — exposed
   * so the demodulator can compute the correction ratio between the training
   * burst's per-symbol peak-norm amplitude and this fixed scale (both are
   * pure functions of shared config, no channel measurement needed; see
   * OFDMQPSKDemodulator's `computeQamRefScale` doc for the derivation).
   */
  getQamScale(): number {
    return this.qamScale;
  }

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

  /**
   * Set per-tone constellation points directly, bypassing the Gray-index
   * mapSymbol lookup — used ONLY by the QAM reference-symbol path (see
   * OFDMEngine.modulateQamRefSymbols), which needs points rotated off the
   * Gray lattice by a per-tone phase to de-cohere the sum. Requires the
   * modulator already be in QAM mode (setToneOrders with a non-all-QPSK
   * assignment); synthesis is otherwise identical to setSymbols's QAM
   * branch — same qamScale, pilot, and cyclic prefix.
   */
  setPoints(points: ConstellationPoint[]): void {
    if (points.length !== this.cfg.toneFrequencies.length) {
      throw new Error(
        `Expected ${this.cfg.toneFrequencies.length} points, got ${points.length}`,
      );
    }
    for (let t = 0; t < points.length; t++) {
      this.symRe[t] = points[t].re;
      this.symIm[t] = points[t].im;
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

/**
 * BPSKModulator — Shared BPSK tone generation for Encoder and TxEngine.
 *
 * Encapsulates the phase-continuous oscillator pool (pilot + data tones)
 * and the per-sample mixing logic. Both Encoder and TxEngine had identical
 * patterns: pilot * pilotAmp + Σ(tone[t] * dataAmp * bpskMul[t]).
 *
 * Extracted to eliminate duplication and provide a single source of truth
 * for the sin-then-increment phase ordering that must match the decoder's
 * toneIQ reference.
 */

import { PhaseAcc } from '../dsp/oscillator';

export interface BPSKModulatorConfig {
  sampleRate: number;
  pilotFreqHz: number;
  pilotAmplitude: number;
  dataToneAmplitude: number;
  /** Absolute tone frequencies (pilotFreq + offsets), one per tone */
  toneFrequencies: Float32Array;
  /** Enable amplitude wobble to prevent mic noise gate suppression */
  wobble?: { rateHz: number; depth: number };
  /** Enable correlated noise (same PRNG seed as decoder for cancellation) */
  correlatedNoise?: { amplitude: number; seed: number };
}

export class BPSKModulator {
  private cfg: BPSKModulatorConfig;
  private pilotOsc: PhaseAcc;
  private toneOscs: PhaseAcc[];
  private numTones: number;

  // Wobble state
  private wobblePhase = 0;
  private wobbleEnabled: boolean;

  // Correlated noise state
  private noiseEnabled: boolean;
  private noiseState: number;
  private noiseAmp: number;

  // BPSK multipliers (set per symbol, read per sample)
  public bpskMul: Float32Array;

  constructor(config: BPSKModulatorConfig) {
    this.cfg = config;
    this.numTones = config.toneFrequencies.length;

    this.pilotOsc = new PhaseAcc();
    this.toneOscs = Array.from({ length: this.numTones }, () => new PhaseAcc());
    this.bpskMul = new Float32Array(this.numTones);
    for (let t = 0; t < this.numTones; t++) this.bpskMul[t] = 1;

    this.wobbleEnabled = !!config.wobble;
    this.noiseEnabled = !!config.correlatedNoise;
    this.noiseState = config.correlatedNoise?.seed ?? 12345;
    this.noiseAmp = config.correlatedNoise?.amplitude ?? 0;
  }

  /**
   * Reset all phase accumulators. Call before starting a new transmission.
   */
  reset(): void {
    this.pilotOsc.reset();
    for (const osc of this.toneOscs) osc.reset();
    this.wobblePhase = 0;
    this.noiseState = this.cfg.correlatedNoise?.seed ?? 12345;
    for (let t = 0; t < this.numTones; t++) this.bpskMul[t] = 1;
  }

  /**
   * Generate one audio sample. Pilot is always on (if pilotAmplitude > 0).
   * Data tones are scaled by bpskMul[t] (1 = 0°, -1 = 180°, 0 = off).
   * Wobble and correlated noise are applied if configured.
   *
   * Contract: advance() returns sin(2π·phase) at OLD phase, then increments.
   * This matches decoder's toneIQ reference sin(ωn).
   */
  generateSample(): number {
    const { sampleRate, pilotFreqHz, pilotAmplitude, dataToneAmplitude, toneFrequencies } =
      this.cfg;
    let output = 0;

    // Pilot (continuous)
    if (pilotAmplitude > 0) {
      output += this.pilotOsc.advance(pilotFreqHz, sampleRate) * pilotAmplitude;
    }

    // Data tones with BPSK multipliers (only advance when tone is active)
    // Note: when bpskMul[t] === 0, we intentionally do NOT advance the tone
    // oscillator. This matches the original Encoder behavior where inactive
    // tones freeze their phase, preventing phase drift across silent periods.
    for (let t = 0; t < this.numTones; t++) {
      if (this.bpskMul[t] !== 0) {
        output +=
          this.toneOscs[t].advance(toneFrequencies[t], sampleRate) *
          dataToneAmplitude *
          this.bpskMul[t];
      }
    }

    // Wobble: slow amplitude modulation to prevent mic noise gate suppression
    if (this.wobbleEnabled && this.cfg.wobble) {
      const { rateHz, depth } = this.cfg.wobble;
      this.wobblePhase += rateHz / sampleRate;
      if (this.wobblePhase >= 1.0) this.wobblePhase -= 1.0;
      const wobble = 1.0 - depth * 0.5 + depth * 0.5 * Math.sin(2 * Math.PI * this.wobblePhase);
      output *= wobble;
    }

    // Correlated noise: deterministic PRNG, same seed as decoder for cancellation
    if (this.noiseEnabled) {
      this.noiseState = (this.noiseState * 1664525 + 1013904223) & 0x7fffffff;
      const noise = ((this.noiseState >>> 0) / 2147483648 - 1) * this.noiseAmp;
      output += noise;
    }

    return output;
  }
}

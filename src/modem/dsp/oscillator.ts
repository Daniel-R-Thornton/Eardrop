/**
 * oscillator.ts — Shared phase-accumulating sinusoidal oscillator.
 *
 * Used by ALL tone generation paths (Encoder, TxEngine, preamble).
 * Single source of truth for the sin-then-increment phase ordering.
 *
 * Contract: advance() returns sin(2π·phase) at the OLD phase, then increments.
 * This matches the decoder's toneIQ reference sin(ωn) — both encoder and
 * decoder use the same phase origin, so 0° BPSK always maps to positive I.
 */

export class PhaseAcc {
  private phase = 0;

  /**
   * Return sin(2π·phase) at current phase, then advance by freqHz/sampleRate.
   * Matches decoder toneIQ reference: sample n → sin(ωn).
   */
  advance(freqHz: number, sampleRate: number): number {
    const v = Math.sin(2 * Math.PI * this.phase);
    this.phase += freqHz / sampleRate;
    if (this.phase >= 1.0) this.phase -= 1.0;
    if (this.phase < 0) this.phase += 1.0;
    return v;
  }

  reset(): void {
    this.phase = 0;
  }
}

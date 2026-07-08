/**
 * preamble.ts — Structured 920ms preamble generator.
 *
 *   Warble (400ms) → Calibration (160ms) → Inversion (160ms) → Sweep (200ms)
 *
 * The pilot runs continuously underneath at cfg.pilotAmplitude.
 * All output is peak-normalized to [-1, 1].
 */

export interface PreambleConfig {
  pilotFreqHz: number;
  pilotAmplitude: number;
  dataToneAmplitude: number;
  sampleRate: number;
  toneOffsets: [number, number, number, number];
}

// ─── Phase accumulator helper ────────────────────────

class PhaseAcc {
  private phase = 0;
  advance(freqHz: number, sampleRate: number): number {
    this.phase += freqHz / sampleRate;
    if (this.phase >= 1.0) this.phase -= 1.0;
    if (this.phase < 0) this.phase += 1.0;
    return Math.sin(2 * Math.PI * this.phase);
  }
  reset() { this.phase = 0; }
  get raw() { return this.phase; }
  set raw(v: number) { this.phase = v; }
}

// ─── Generate full preamble ──────────────────────────

export function generatePreamble(cfg: PreambleConfig): Float32Array {
  const { sampleRate, pilotFreqHz, pilotAmplitude, dataToneAmplitude, toneOffsets } = cfg;

  // Compute absolute tone frequencies
  const toneFreqs = toneOffsets.map(o => pilotFreqHz + o);

  // Phase accumulators
  const pilot = new PhaseAcc();
  const tones = [new PhaseAcc(), new PhaseAcc(), new PhaseAcc(), new PhaseAcc()];
  // Separate accumulator for the warble carrier
  const warble = new PhaseAcc();

  // Duration in samples
  const warbleSamps = Math.floor(0.400 * sampleRate);    // 1280
  const calSamps = Math.floor(0.160 * sampleRate);        // 512
  const invSamps = Math.floor(0.160 * sampleRate);        // 512
  const sweepSamps = Math.floor(0.200 * sampleRate);      // 640
  // Total: warble(1280) + marker(128) + cal0(128) + cal1(128) + guard(32) = 1696
  const totalSamps = warbleSamps + 128 + 128 + 128 + 32;

  const out = new Float32Array(totalSamps);
  let idx = 0;

  // ── Phase 1: Warble (400ms) ────────────────────────
  // Toggle between pilotFreq-50 and pilotFreq+50 at 100Hz
  const warbleInterval = Math.floor(0.010 * sampleRate); // 32 samples
  for (let i = 0; i < warbleSamps; i++) {
    let s = 0;
    s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;
    const cycleIdx = Math.floor(i / warbleInterval) % 2;
    const warbleFreq = cycleIdx === 0 ? pilotFreqHz - 50 : pilotFreqHz + 50;
    s += warble.advance(warbleFreq, sampleRate) * dataToneAmplitude;
    out[idx++] = s;
  }
  // ── Warble end marker: 128 samples of all tones ON full blast ──
  for (let i = 0; i < 128; i++) {
    let s = 0;
    s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;
    for (let t = 0; t < 4; t++) {
      s += tones[t].advance(toneFreqs[t], sampleRate) * dataToneAmplitude;
    }
    out[idx++] = s;
  }

  // ── Phase 2: Calibration ───────────────────────────
  // Frame 0: All 4 tones ON at 0° phase
  for (let i = 0; i < 128; i++) {
    let s = 0;
    s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;
    for (let t = 0; t < 4; t++) {
      s += tones[t].advance(toneFreqs[t], sampleRate) * dataToneAmplitude;
    }
    out[idx++] = s;
  }
  // Frame 1: All 4 tones ON at 180° phase (inverted)
  for (let t = 0; t < 4; t++) {
    // Reset phase accumulators to advance by 180° more
    tones[t] = new PhaseAcc();
  }
  for (let i = 0; i < 128; i++) {
    let s = 0;
    s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;
    for (let t = 0; t < 4; t++) {
      s += tones[t].advance(toneFreqs[t], sampleRate) * (-dataToneAmplitude); // 180° = NEGATE
    }
    out[idx++] = s;
  }

  // ── Phase 3: Guard (32 samples of silence) ─────────
  for (let i = 0; i < 32; i++) {
    let s = 0;
    s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;
    for (let t = 0; t < 4; t++) {
      tones[t].advance(toneFreqs[t], sampleRate);
    }
    out[idx++] = s;
  }

  // ── Normalize to [-1, 1] ──────────────────────────
  let peak = 0;
  for (let i = 0; i < totalSamps; i++) {
    const abs = Math.abs(out[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 1.0) {
    const scale = 1.0 / peak;
    for (let i = 0; i < totalSamps; i++) out[i] *= scale;
  }

  return out;
}

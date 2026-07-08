/**
 * preamble.ts — Structured 620ms preamble generator.
 *
 * Replaces the old leader→sync→calibrate with:
 *   Warble (100ms) → Calibration (160ms) → Inversion (160ms) → Sweep (200ms)
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
  const warbleSamps = Math.floor(0.100 * sampleRate);    // 320
  const calSamps = Math.floor(0.160 * sampleRate);        // 512
  const invSamps = Math.floor(0.160 * sampleRate);        // 512
  const sweepSamps = Math.floor(0.200 * sampleRate);      // 640
  const totalSamps = warbleSamps + calSamps + invSamps + sweepSamps; // 1984

  const out = new Float32Array(totalSamps);
  let idx = 0;

  // ── Phase 1: Warble (100ms) ────────────────────────
  // Toggle between pilotFreq-50 and pilotFreq+50 at 100Hz (every 10ms = 32 samples)
  const warbleInterval = Math.floor(0.010 * sampleRate); // 32 samples
  for (let i = 0; i < warbleSamps; i++) {
    let s = 0;

    // Pilot (continuous)
    s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;

    // Warble tone: toggle between ±50Hz every warbleInterval samples
    const cycleIdx = Math.floor(i / warbleInterval) % 2;
    const warbleFreq = cycleIdx === 0 ? pilotFreqHz - 50 : pilotFreqHz + 50;
    s += warble.advance(warbleFreq, sampleRate) * dataToneAmplitude;

    out[idx++] = s;
  }

  // ── Phase 2: Calibration (160ms) ───────────────────
  // 4 frames × 40ms = 160ms. Pattern: High, Low, High, Low
  const frameSamps = Math.floor(0.040 * sampleRate); // 128 samples = 1 symbol
  const calPattern = [true, false, true, false]; // High, Low, High, Low
  for (let f = 0; f < calPattern.length; f++) {
    const isHigh = calPattern[f];
    for (let i = 0; i < frameSamps; i++) {
      let s = 0;

      // Pilot (continuous)
      s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;

      // Data tones: High = all ON, Low = OFF
      if (isHigh) {
        for (let t = 0; t < 4; t++) {
          s += tones[t].advance(toneFreqs[t], sampleRate) * dataToneAmplitude;
        }
      } else {
        // Low: advance phase but output silence
        for (let t = 0; t < 4; t++) {
          tones[t].advance(toneFreqs[t], sampleRate);
        }
      }

      out[idx++] = s;
    }
  }

  // ── Phase 3: Inversion (160ms) ─────────────────────
  // 4 frames × 40ms. Pattern: Low, High, Low, High (inverse of cal)
  const invPattern = [false, true, false, true]; // Low, High, Low, High
  for (let f = 0; f < invPattern.length; f++) {
    const isHigh = invPattern[f];
    for (let i = 0; i < frameSamps; i++) {
      let s = 0;

      // Pilot (continuous)
      s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;

      // Data tones
      if (isHigh) {
        for (let t = 0; t < 4; t++) {
          s += tones[t].advance(toneFreqs[t], sampleRate) * dataToneAmplitude;
        }
      } else {
        for (let t = 0; t < 4; t++) {
          tones[t].advance(toneFreqs[t], sampleRate);
        }
      }

      out[idx++] = s;
    }
  }

  // ── Phase 4: Sweep (200ms) ─────────────────────────
  // Linear sine sweep from 200Hz to 1200Hz
  const sweepAcc = new PhaseAcc();
  for (let i = 0; i < sweepSamps; i++) {
    let s = 0;

    // Pilot (continuous)
    s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;

    // Sweep tone: instantaneous frequency at this sample
    const progress = i / sweepSamps;
    const sweepFreq = 200 + (1200 - 200) * progress; // 200 → 1200 Hz
    s += sweepAcc.advance(sweepFreq, sampleRate) * dataToneAmplitude;

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

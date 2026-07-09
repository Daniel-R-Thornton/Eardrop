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

import { WARBLE_CODE } from './types';

// ─── Phase accumulator helper ────────────────────────

class PhaseAcc {
  private phase = 0;
  /** Return sin at current phase, then advance. Matches decoder toneIQ reference sin(ωn). */
  advance(freqHz: number, sampleRate: number): number {
    const v = Math.sin(2 * Math.PI * this.phase);
    this.phase += freqHz / sampleRate;
    if (this.phase >= 1.0) this.phase -= 1.0;
    if (this.phase < 0) this.phase += 1.0;
    return v;
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
  // Total: warble(1280) + marker(256) + cal(16×256=4096) + guard(512) = 6144
  const totalSamps = warbleSamps + 256 + 4096 + 512;

  const out = new Float32Array(totalSamps);
  let idx = 0;

  // ── Phase 1: Warble (400ms) ────────────────────────
  // Encode the 16-bit warble code, repeating for the entire warble duration.
  // Each bit selects pilotFreq-50Hz (0) or pilotFreq+50Hz (1) for 32 samples.
  const warbleInterval = Math.floor(0.010 * sampleRate); // 32 samples
  for (let i = 0; i < warbleSamps; i++) {
    let s = 0;
    s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;
    const interval = Math.floor(i / warbleInterval);
    const codeBit = (WARBLE_CODE >> (15 - (interval % 16))) & 1;
    const warbleFreq = codeBit === 0 ? pilotFreqHz - 50 : pilotFreqHz + 50;
    s += warble.advance(warbleFreq, sampleRate) * dataToneAmplitude;
    out[idx++] = s;
  }
  // ── Warble end marker: 256 samples of all tones ON full blast ──
  for (let i = 0; i < 256; i++) {
    let s = 0;
    s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;
    for (let t = 0; t < 4; t++) {
      s += tones[t].advance(toneFreqs[t], sampleRate) * dataToneAmplitude;
    }
    out[idx++] = s;
  }

  // ── Phase 2: Calibration — Gray code through all 16 permutations ──
  // Each 256-sample frame encodes one 4-bit Gray code value (2×128 for SPS=256).
  // Bits 0-3 map to tones 0-3. Bit=0 → 0° phase, Bit=1 → 180° phase.
  const grayCodes = [0,1,3,2,6,7,5,4,12,13,15,14,10,11,9,8];
  const calFrameSamps = 256;
  const bpskMul = (bit: number) => bit === 0 ? 1 : -1;
  for (let gf = 0; gf < grayCodes.length; gf++) {
    const gc = grayCodes[gf];
    const bits = [(gc >> 3) & 1, (gc >> 2) & 1, (gc >> 1) & 1, gc & 1];
    for (let i = 0; i < calFrameSamps; i++) {
      let s = 0;
      s += pilot.advance(pilotFreqHz, sampleRate) * pilotAmplitude;
      for (let t = 0; t < 4; t++) {
        s += tones[t].advance(toneFreqs[t], sampleRate) * dataToneAmplitude * bpskMul(bits[t]);
      }
      out[idx++] = s;
    }
  }

  // ── Phase 3: Guard (4 frames = 512 samples for alignment) ──
  for (let i = 0; i < 512; i++) {
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

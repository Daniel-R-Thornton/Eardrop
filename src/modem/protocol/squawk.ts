/**
 * squawk.ts — Periodic calibration beacon system.
 *
 * Squawks are framed blocks (Type=0x01) sent at regular intervals during
 * transmission. Each squawk carries known reference I/Q points that the
 * decoder uses to recalibrate:
 *   - Pilot PLL phase offset
 *   - AGC gain (amplitude correction)
 *   - Per-tone thresholds
 *
 * Squawk block data format:
 *   [squawkId:1B][refI0:2B][refQ0:2B][refI1:2B][refQ1:2B]
 *   [refI2:2B][refQ2:2B][refI3:2B][refQ3:2B]
 *
 * Where refI/refQ are 16-bit fixed-point values in [-32768, 32767] range,
 * representing the expected I/Q constellation points for this transmission.
 * The decoder measures the actual received I/Q and computes correction.
 */

import { debugLogger, STAGE, LOG_LEVEL } from '../debug/debugger';

// ─── Squawk Data Format ──────────────────────────────

/** Size of a squawk data payload in bytes */
export const SQUAWK_PAYLOAD_BYTES = 1 + 4 * 2 * 2; // id(1) + 4 tones × I(2) + Q(2)

/** Scale factor for 16-bit fixed-point I/Q */
const FIXED_SCALE = 32768;

function toFixed(v: number): number {
  return Math.round(Math.max(-1, Math.min(1, v)) * FIXED_SCALE);
}

function fromFixed(v: number): number {
  return v / FIXED_SCALE;
}

// ─── Squawk Generator (Encoder Side) ─────────────────

export interface SquawkReference {
  /** Per-tone reference I/Q values (pilot-relative, -1..1 range) */
  refI: [number, number, number, number];
  refQ: [number, number, number, number];
}

/**
 * Generate the reference I/Q points for a squawk.
 * These are the expected pilot-relative I/Q values when all 4 tones
 * are ON with phase bit = 1 (right half-plane = positive I).
 */
export function generateSquawkReference(): SquawkReference {
  // With all tones ON and phase=1, the expected pilot-relative I/Q is:
  // I = dataToneAmplitude (positive), Q = 0 (ideal BPSK)
  // But we use a more informative pattern:
  // Tone 0: (+amp, +amp)  — quadrant I
  // Tone 1: (+amp, -amp)  — quadrant IV
  // Tone 2: (-amp, +amp)  — quadrant II
  // Tone 3: (-amp, -amp)  — quadrant III
  // This covers all 4 constellation quadrants in one squawk.
  const amp = 0.3; // reference amplitude (matches typical data tone level)
  return {
    refI: [amp, amp, -amp, -amp],
    refQ: [amp, -amp, amp, -amp],
  };
}

/**
 * Encode a squawk into framed block payload bytes.
 */
export function encodeSquawkPayload(squawkId: number, ref?: SquawkReference): Uint8Array {
  const r = ref || generateSquawkReference();
  const buf = new Uint8Array(SQUAWK_PAYLOAD_BYTES);
  let off = 0;
  buf[off++] = squawkId;
  for (let t = 0; t < 4; t++) {
    const i16 = toFixed(r.refI[t]);
    const q16 = toFixed(r.refQ[t]);
    buf[off++] = (i16 >> 8) & 0xff;
    buf[off++] = i16 & 0xff;
    buf[off++] = (q16 >> 8) & 0xff;
    buf[off++] = q16 & 0xff;
  }
  return buf;
}

// ─── Squawk Processor (Decoder Side) ─────────────────

export interface SquawkCorrection {
  /** Squawk sequence number */
  squawkId: number;
  /** Phase correction in degrees (positive = received phase leads expected) */
  phaseCorrectionDeg: number;
  /** Amplitude correction ratio (expectedAmp / measuredAmp) */
  ampCorrection: number;
  /** Per-tone SNR estimate from this squawk */
  toneSnr: [number, number, number, number];
  /** Pilot SNR at time of squawk */
  pilotSnr: number;
  /** Timestamp */
  timestamp: number;
}

export interface SquawkProcessorConfig {
  /** How many squawks to keep in history */
  historySize: number;
  /** Maximum phase correction before triggering a warning (degrees) */
  maxPhaseWarnDeg: number;
  /** Maximum amplitude correction ratio before warning */
  maxAmpWarnRatio: number;
}

const DEFAULT_SQUAWK_CONFIG: SquawkProcessorConfig = {
  historySize: 20,
  maxPhaseWarnDeg: 20,
  maxAmpWarnRatio: 2.0,
};

export class SquawkProcessor {
  private cfg: SquawkProcessorConfig;
  private history: SquawkCorrection[] = [];
  private expectedRef: SquawkReference | null = null;
  private lastSquawkId = -1;

  /** Accumulated drift since last full calibration */
  private accumulatedDriftDeg = 0;

  constructor(cfg?: Partial<SquawkProcessorConfig>) {
    this.cfg = { ...DEFAULT_SQUAWK_CONFIG, ...cfg };
  }

  /**
   * Set the expected squawk reference (from the first received squawk,
   * or pre-configured if known).
   */
  setExpectedRef(ref: SquawkReference): void {
    this.expectedRef = ref;
  }

  /**
   * Process a decoded squawk block.
   * @param data — The raw squawk payload bytes
   * @param measuredIQ — What the decoder actually measured for each tone (pilot-relative I/Q)
   * @returns The computed correction, or null if no reference set
   */
  processSquawk(
    data: Uint8Array,
    measuredIQ: Array<{ i: number; q: number }>,
  ): SquawkCorrection | null {
    if (data.length < 1) return null;

    const squawkId = data[0];

    // Parse expected I/Q from the payload
    const expectedI: number[] = [];
    const expectedQ: number[] = [];
    let off = 1;
    for (let t = 0; t < 4 && off + 4 <= data.length; t++) {
      const i16 = (data[off] << 8) | data[off + 1];
      const q16 = (data[off + 2] << 8) | data[off + 3];
      expectedI.push(fromFixed(i16));
      expectedQ.push(fromFixed(q16));
      off += 4;
    }

    // Use the first squawk to set the reference if not already set
    if (!this.expectedRef && expectedI.length === 4) {
      this.expectedRef = {
        refI: [expectedI[0], expectedI[1], expectedI[2], expectedI[3]],
        refQ: [expectedQ[0], expectedQ[1], expectedQ[2], expectedQ[3]],
      };
    }

    if (!this.expectedRef || measuredIQ.length < 4) {
      return null;
    }

    // Compute per-tone phase and amplitude corrections
    let totalPhaseDeg = 0;
    let totalAmpRatio = 0;
    const toneSnr: [number, number, number, number] = [0, 0, 0, 0];

    for (let t = 0; t < 4; t++) {
      const ei = expectedI[t];
      const eq = expectedQ[t];
      const mi = measuredIQ[t].i;
      const mq = measuredIQ[t].q;

      // Expected vs measured phase
      const expectedPhase = Math.atan2(eq, ei);
      const measuredPhase = Math.atan2(mq, mi);
      let phaseDiff = measuredPhase - expectedPhase;
      // Normalize to [-π, π]
      if (phaseDiff > Math.PI) phaseDiff -= 2 * Math.PI;
      if (phaseDiff < -Math.PI) phaseDiff += 2 * Math.PI;
      totalPhaseDeg += (phaseDiff * 180) / Math.PI;

      // Amplitude ratio: expected magnitude / measured magnitude
      const expectedMag = Math.hypot(ei, eq);
      const measuredMag = Math.hypot(mi, mq);
      const ampRatio = measuredMag > 1e-12 ? expectedMag / measuredMag : 1;
      totalAmpRatio += ampRatio;

      // Tone SNR: |measured|² / |noise|² estimated from deviation
      const noiseI = mi - ei;
      const noiseQ = mq - eq;
      const noiseMag = Math.hypot(noiseI, noiseQ);
      toneSnr[t] =
        measuredMag > 1e-12 && noiseMag > 1e-12 ? 20 * Math.log10(measuredMag / noiseMag) : 40; // cap at 40 dB
    }

    const avgPhaseDeg = totalPhaseDeg / 4;
    const avgAmpRatio = totalAmpRatio / 4;
    const pilotSnr = toneSnr.reduce((a, b) => a + b, 0) / 4;

    // Accumulate drift
    if (this.lastSquawkId >= 0) {
      this.accumulatedDriftDeg += Math.abs(avgPhaseDeg);
    }
    this.lastSquawkId = squawkId;

    const correction: SquawkCorrection = {
      squawkId,
      phaseCorrectionDeg: avgPhaseDeg,
      ampCorrection: avgAmpRatio,
      toneSnr,
      pilotSnr,
      timestamp: performance.now(),
    };

    this.history.push(correction);
    if (this.history.length > this.cfg.historySize) this.history.shift();

    // Log to debugger
    const level =
      Math.abs(avgPhaseDeg) > this.cfg.maxPhaseWarnDeg ||
      avgAmpRatio > this.cfg.maxAmpWarnRatio ||
      avgAmpRatio < 1 / this.cfg.maxAmpWarnRatio
        ? LOG_LEVEL.WARN
        : LOG_LEVEL.INFO;

    debugLogger.log(
      STAGE.SQUAWK_CAL,
      level,
      {
        id: squawkId,
        drift_deg: avgPhaseDeg.toFixed(1),
        amp_corr: avgAmpRatio.toFixed(3),
        pilot_snr: pilotSnr.toFixed(1),
        tone_snr: toneSnr.map((s) => s.toFixed(1)).join('/'),
        acc_drift: this.accumulatedDriftDeg.toFixed(1),
      },
      `Squawk #${squawkId}: drift=${avgPhaseDeg.toFixed(1)}° amp=${avgAmpRatio.toFixed(3)} SNR=${pilotSnr.toFixed(1)}dB`,
    );

    return correction;
  }

  /** Get the last correction */
  getLastCorrection(): SquawkCorrection | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /** Get the full history */
  getHistory(): readonly SquawkCorrection[] {
    return this.history;
  }

  /** Get average drift over the last N squawks */
  getAverageDrift(n?: number): number {
    const slice = n ? this.history.slice(-n) : this.history;
    if (slice.length === 0) return 0;
    return slice.reduce((a, c) => a + Math.abs(c.phaseCorrectionDeg), 0) / slice.length;
  }

  /** Get total accumulated drift (degrees) */
  getAccumulatedDrift(): number {
    return this.accumulatedDriftDeg;
  }

  /** Reset for a new transmission */
  reset(): void {
    this.history = [];
    this.expectedRef = null;
    this.lastSquawkId = -1;
    this.accumulatedDriftDeg = 0;
  }
}

/**
 * PreambleDetector — Leader→Sync→Calibrate→Data phase detection.
 *
 * Extracted from Decoder.feedSample(). Detects preamble phase transitions
 * based on per-frame energy levels and frame counting. Matches the
 * Encoder's preamble sequence: leader (pilot only) → sync (all tones)
 * → calibrate (one tone at a time) → data.
 *
 * Also accumulates BPSK phase references during calibration to determine
 * the correct phase sign for each data tone.
 */

export type PreamblePhase = 'leader' | 'sync' | 'calibrate' | 'data';

export interface PreambleFrameInput {
  /** Total energy across all tones in this frame */
  totalEnergy: number;
  /** Per-tone energy (absolute magnitude of I/Q) */
  energies: [number, number, number, number];
  /** Per-tone raw I component (for phase reference accumulation) */
  relI: [number, number, number, number];
}

export interface PreambleResult {
  /** Current preamble phase */
  phase: PreamblePhase;
  /** True on the frame where calibrate→data transition occurs */
  enteredFrame: boolean;
  /** True when calibration reference is finalized */
  calibrationDone: boolean;
  /** Per-tone phase flip (±1): multiply relI by this to get corrected phase */
  calPhaseFlip: [number, number, number, number];
}

const ENERGY_THRESHOLD = 0.0005;
const TONE_ENERGY_THRESHOLD = 0.0003;
const SYNC_FRAMES = 10; // Encoder sends 10 sync frames
const CALIBRATE_FRAMES = 16; // Encoder sends 4 tones × 4 frames each = 16

export class PreambleDetector {
  private _phase: PreamblePhase = 'leader';
  private syncFrameCount = 0;
  private calibrateCount = 0;
  private dominantTones: number[] = [];

  // Calibration: accumulate phase sign per tone
  private calPhaseSum: [number, number, number, number] = [0, 0, 0, 0];
  private calPhaseCount: [number, number, number, number] = [0, 0, 0, 0];
  private _calDone = false;
  private _calPhaseFlip: [number, number, number, number] = [1, 1, 1, 1];

  reset(): void {
    this._phase = 'leader';
    this.syncFrameCount = 0;
    this.calibrateCount = 0;
    this.dominantTones = [];
    this.calPhaseSum = [0, 0, 0, 0];
    this.calPhaseCount = [0, 0, 0, 0];
    this._calDone = false;
    this._calPhaseFlip = [1, 1, 1, 1];
  }

  /**
   * Process one symbol frame. Returns phase transition events.
   *
   * @param input Per-frame energy and I/Q data
   * @returns Events for this frame (enteredFrame only true on transition frame)
   */
  update(input: PreambleFrameInput): PreambleResult {
    let enteredFrame = false;

    const hasSignal =
      input.totalEnergy > ENERGY_THRESHOLD && Math.max(...input.energies) > TONE_ENERGY_THRESHOLD;

    const maxToneIdx = hasSignal ? input.energies.indexOf(Math.max(...input.energies)) : -1;

    // Phase calibration accumulation
    if (!this._calDone && hasSignal && maxToneIdx >= 0 && this.calPhaseCount[maxToneIdx] < 3) {
      this.calPhaseSum[maxToneIdx] += input.relI[maxToneIdx] >= 0 ? 1 : -1;
      this.calPhaseCount[maxToneIdx]++;

      const totalCounts = this.calPhaseCount.reduce((a, b) => a + b, 0);
      if (totalCounts >= 8) {
        let totalSum = 0;
        for (let t = 0; t < 4; t++) totalSum += this.calPhaseSum[t];
        const globalFlip = totalSum >= 0 ? 1 : -1;
        for (let t = 0; t < 4; t++) this._calPhaseFlip[t] = globalFlip;
        this._calDone = true;
      }
    }

    // Track dominant tone history
    if (maxToneIdx >= 0) {
      this.dominantTones.push(maxToneIdx);
      if (this.dominantTones.length > 20) this.dominantTones.shift();
    }

    // Phase transitions
    if (this._phase === 'leader' && hasSignal) {
      this._phase = 'sync';
      this.syncFrameCount = 0;
    }

    if (this._phase === 'sync') {
      this.syncFrameCount++;
      if (this.syncFrameCount >= SYNC_FRAMES) {
        this._phase = 'calibrate';
        this.calibrateCount = 0;
      }
    }

    if (this._phase === 'calibrate') {
      this.calibrateCount++;
      if (this.calibrateCount >= CALIBRATE_FRAMES) {
        this._phase = 'data';
        enteredFrame = true;
      }
    }

    return {
      phase: this._phase,
      enteredFrame,
      calibrationDone: this._calDone,
      calPhaseFlip: this._calPhaseFlip,
    };
  }

  get phase(): PreamblePhase {
    return this._phase;
  }
  get isInFrame(): boolean {
    return this._phase === 'data';
  }
  get calPhaseFlip(): [number, number, number, number] {
    return this._calPhaseFlip;
  }
}

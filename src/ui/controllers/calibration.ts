/**
 * calibration.ts — per-tone pre-emphasis calibration, split into a pure(ish)
 * orchestration core and an audio-I/O wrapper so it can run from two places:
 *
 *   - the CHANNEL SWEEP panel (operator-initiated, with charts), and
 *   - the SEND path (auto-calibrate when the current mic+band has no stored
 *     gains — an uncalibrated band costs 3-4 dB of MER, which is the whole
 *     FEC margin at 32+ tones).
 *
 * The core takes injected measurement functions and knows nothing about
 * AudioContext, so autoCalibrate.test.ts exercises the loop with a fake
 * channel.
 */
import { getState, setState, type AppState } from '../Store';
import { AudioPlayer } from '../../audio/player';
import { AudioRecorder } from '../../audio/recorder';
import { dlog } from '../../lib/debug/dlog';
import {
  buildGridBurst,
  buildSweep,
  measureGridResponse,
  measureSweep,
  refinePreEmphasis,
  gainsDbToLinear,
  responseSpreadDb,
  sampleResponseAt,
  SWEEP_DEFAULTS,
} from '../../modem/diag/channelSweep';
import { ofdmToneFrequencies, OFDM_DEFAULTS } from '../../modem/types';
import { MAX_QAM_MAGNITUDE } from '../../modem/modulation/constellation';

/** Extra capture time after playback ends, covering output+input latency. */
const CAPTURE_TAIL_MS = 400;

export interface CalibrateCoreDeps {
  toneCount: number;
  gridRounds: number;
  /** Play the grid under these LINEAR gains, return per-tone magnitudes (null = heard nothing). */
  measureGrid: (linearGains: number[]) => Promise<number[] | null>;
  /** Single-tone sweep sampled at the tone frequencies (null = sweep failed). */
  measureSweepAtTones: () => Promise<number[] | null>;
}

export type CalibrateCoreResult =
  | { failed: 'baseline' | `round${number}` | 'verify' }
  | {
      failed?: undefined;
      /** LINEAR per-tone gains, ready for toneGainsByDevice / the modulator. */
      gains: number[];
      beforeSpread: number;
      afterSpread: number;
      baseline: number[];
      finalMags: number[];
    };

/**
 * The calibration loop: baseline grid → sweep seed → grid refinement rounds →
 * verification measure under the final gains. Storage is the caller's job.
 */
export async function calibrateGainsCore(deps: CalibrateCoreDeps): Promise<CalibrateCoreResult> {
  let gainsDb = new Array<number>(deps.toneCount).fill(0);

  const baseline = await deps.measureGrid(gainsDbToLinear(gainsDb));
  if (!baseline) return { failed: 'baseline' };
  const beforeSpread = responseSpreadDb(baseline);
  dlog('CAL-ROUND', { stage: 'baseline', spreadDb: beforeSpread.toFixed(1) });

  // Sweep seed: one tone at a time carries the whole transmit power, so this
  // estimate is far less noise-limited than the grid's — a better starting
  // point than iterating up from zero. Optional: a failed sweep only costs
  // convergence speed.
  const atTones = await deps.measureSweepAtTones();
  if (atTones) {
    gainsDb = refinePreEmphasis(gainsDb, atTones);
    dlog('CAL-ROUND', { stage: 'sweepSeed', spreadDb: responseSpreadDb(atTones).toFixed(1) });
  } else {
    dlog('CAL-ROUND', { stage: 'sweepSeed', failed: true }, { level: 'warn' });
  }

  for (let round = 0; round < deps.gridRounds; round++) {
    const mags = await deps.measureGrid(gainsDbToLinear(gainsDb));
    if (!mags) return { failed: `round${round}` };
    dlog('CAL-ROUND', { round, spreadDb: responseSpreadDb(mags).toFixed(1) });
    gainsDb = refinePreEmphasis(gainsDb, mags);
    for (let i = 0; i < gainsDb.length; i += 16) {
      dlog('CAL-GAIN-DB', {
        t: i,
        db: gainsDb.slice(i, i + 16).map((g) => g.toFixed(1)).join(','),
      });
    }
  }

  // Verify with the final gains rather than trusting the last correction.
  const finalMags = await deps.measureGrid(gainsDbToLinear(gainsDb));
  if (!finalMags) return { failed: 'verify' };

  return {
    gains: gainsDbToLinear(gainsDb),
    beforeSpread,
    afterSpread: responseSpreadDb(finalMags),
    baseline,
    finalMags,
  };
}

/** Calibration key — see AppState.toneGainsByDevice for why both parts. */
export function calibrationKey(s: AppState): string {
  return `${s.pilotFreqHz}:${s.toneStartHz}:${s.toneCount}`;
}

/**
 * Stored gains for the current mic+band, or undefined when uncalibrated.
 * Looks up by mic LABEL first (stable), then by id (legacy entries).
 */
export function currentCalibrationGains(s: AppState): number[] | undefined {
  const key = calibrationKey(s);
  const byLabel = s.selectedInputLabel
    ? s.toneGainsByDevice[s.selectedInputLabel]?.[key]
    : undefined;
  return byLabel ?? s.toneGainsByDevice[s.selectedInputId]?.[key];
}

/**
 * Full audio-I/O calibration of the CURRENT config, storing the result into
 * toneGainsByDevice (same place the CHANNEL SWEEP panel stores). Creates its
 * own player/recorder and tears them down. Returns the core result so callers
 * can report before/after.
 */
export async function runAutoCalibration(): Promise<CalibrateCoreResult> {
  const s = getState();
  const SR = 48000;
  const freqs = Array.from(
    ofdmToneFrequencies({
      toneCount: s.toneCount,
      pilotFreqHz: s.pilotFreqHz,
      startHz: s.toneStartHz,
      spacingHz: OFDM_DEFAULTS.toneSpacingHz,
    }),
  );
  // The modem's own per-tone amplitude, so calibration probes the SAME
  // operating point the transmission will use (the chain compresses; a
  // different level measures a different chain).
  const safeScale = 0.95 / (s.toneCount * MAX_QAM_MAGNITUDE + OFDM_DEFAULTS.pilotAmplitude);
  const amplitude = Math.min(s.qamScaleOverride ?? safeScale, safeScale);

  const player = new AudioPlayer();
  const recorder = new AudioRecorder();

  const measureGrid = async (linearGains: number[]): Promise<number[] | null> => {
    const burst = buildGridBurst({
      sampleRate: SR,
      freqs,
      pilotFreqHz: s.pilotFreqHz,
      pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
      amplitude,
      ms: 900,
      toneGains: linearGains,
    });
    const offset = (await recorder.getRecordedSamples()).length;
    await player.play(burst.audio, SR, s.selectedOutputId, true);
    await new Promise((r) => setTimeout(r, CAPTURE_TAIL_MS));
    const all = await recorder.getRecordedSamples();
    const measured = measureGridResponse(all.slice(offset), burst);
    return measured.failed ? null : measured.mags;
  };

  const measureSweepAtTones = async (): Promise<number[] | null> => {
    const pad = OFDM_DEFAULTS.toneSpacingHz;
    const plan = buildSweep({
      ...SWEEP_DEFAULTS,
      sampleRate: SR,
      amplitude,
      startHz: Math.max(SWEEP_DEFAULTS.startHz, freqs[0] - pad),
      endHz: freqs[freqs.length - 1] + pad,
    });
    const offset = (await recorder.getRecordedSamples()).length;
    await player.play(plan.audio, SR, s.selectedOutputId, true);
    await new Promise((r) => setTimeout(r, CAPTURE_TAIL_MS));
    const all = await recorder.getRecordedSamples();
    const res = measureSweep(all.slice(offset), plan);
    return res.failed ? null : sampleResponseAt(res, freqs);
  };

  try {
    await recorder.start(SR, undefined, s.selectedInputId, s.selectedInputLabel);
    await new Promise((r) => setTimeout(r, 250));
    dlog('CAL', { tones: s.toneCount, key: calibrationKey(s), auto: true });

    const result = await calibrateGainsCore({
      toneCount: s.toneCount,
      gridRounds: 2,
      measureGrid,
      measureSweepAtTones,
    });

    if (!result.failed) {
      const device = s.selectedInputLabel || s.selectedInputId;
      setState({
        toneGainsByDevice: {
          ...s.toneGainsByDevice,
          [device]: {
            ...(s.toneGainsByDevice[device] ?? {}),
            [calibrationKey(s)]: result.gains,
          },
        },
      });
      dlog('CAL', {
        done: true,
        beforeSpreadDb: result.beforeSpread.toFixed(1),
        afterSpreadDb: result.afterSpread.toFixed(1),
        stored: calibrationKey(s),
      }, { level: 'warn' });
    } else {
      dlog('CAL', { failed: result.failed }, { level: 'warn' });
    }
    return result;
  } finally {
    try { await recorder.stop(); } catch { /* already stopped */ }
  }
}

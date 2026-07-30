/**
 * ChannelSweep.tsx — plays a stepped-sine sweep out of the speaker, records it
 * back through the mic, and plots the measured amplitude response.
 *
 * Answers the question `[OFDM-TRAIN] h` cannot: is a dip in the tone grid a
 * narrow acoustic cancellation notch, a broad speaker rolloff, or an artifact
 * of our own processing? h only samples the 8/16/32 frequencies the grid
 * happens to occupy and cannot see outside the configured band; this measures
 * every 50 Hz from 1 to 9 kHz, so the shape of the response is visible rather
 * than inferred.
 *
 * Measurement lives in modem/diag/channelSweep.ts (pure, unit-tested against
 * an injected notch of known depth). This file is playback, capture, and
 * drawing only.
 */
import { useCallback, useRef, useState } from 'react';
import { useStore, setState } from '../Store';
import { T } from '../theme/labaccent/tokens';
import { Button } from '../components/instrument/Button';
import { dlog } from '../../lib/debug/dlog';
import { AudioPlayer } from '../../audio/player';
import { AudioRecorder } from '../../audio/recorder';
import {
  buildSweep,
  measureSweep,
  summarizeSweep,
  buildGridBurst,
  measureGridResponse,
  gridVsSweepDelta,
  buildToneBurst,
  measureEnvelope,
  linearityDeviationDb,
  refinePreEmphasis,
  gainsDbToLinear,
  responseSpreadDb,
  sampleResponseAt,
  magsToRelativeDb,
  makeGainInterpolator,
  SWEEP_DEFAULTS,
  type SweepResult,
} from '../../modem/diag/channelSweep';
import { ofdmToneFrequencies, OFDM_DEFAULTS } from '../../modem/types';
import { MAX_QAM_MAGNITUDE } from '../../modem/modulation/constellation';

/** Extra capture time after the sweep ends, to cover output+input latency. */
const CAPTURE_TAIL_MS = 700;

export function ChannelSweep({ onClose }: { onClose?: () => void }) {
  const s = useStore((x) => x);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Previous run, kept so moving the laptop shows whether notches MOVE. */
  const prevRef = useRef<SweepResult | null>(null);
  /** Sweep measured WITH the stored pre-emphasis applied, when one exists. */
  const [sweepCalibrated, setSweepCalibrated] = useState<SweepResult | null>(null);
  /** Last grid-burst run — all tones at once, at the modem's real per-tone level. */
  const [grid, setGrid] = useState<SweepResult | null>(null);
  const sweepRef = useRef<SweepResult | null>(null);

  // One player/recorder for the panel's lifetime. Constructing an AudioRecorder
  // per run also constructs an AudioContext per run, and browsers cap those at
  // a handful — a debug panel is exactly the thing that gets clicked ten times
  // in a row, so it must not leak one each time.
  const ioRef = useRef<{ player: AudioPlayer; recorder: AudioRecorder } | null>(null);
  const io = useCallback(() => {
    if (!ioRef.current) {
      // Match the app's mic gain, or these measurements are not comparable to
      // the numbers the modem itself reports (AudioRecorder defaults to 8.0,
      // which silently differed from the UI setting the logs were quoting).
      ioRef.current = {
        player: new AudioPlayer(),
        recorder: new AudioRecorder(undefined, s.micGain),
      };
    }
    ioRef.current.recorder.micGain = s.micGain;
    return ioRef.current;
  }, [s.micGain]);

  const gridBurst = useCallback(() => {
    const freqs = Array.from(
      ofdmToneFrequencies({
        toneCount: s.toneCount,
        pilotFreqHz: s.pilotFreqHz,
        startHz: s.toneStartHz,
        spacingHz: OFDM_DEFAULTS.toneSpacingHz,
      }),
    );
    // The modem's own worst-case-peak scale, so this measures the grid at
    // exactly the per-tone level a real transmission uses — the whole point is
    // that it is far below the single-tone sweep's 0.25.
    const safeScale = 0.95 / (s.toneCount * MAX_QAM_MAGNITUDE + OFDM_DEFAULTS.pilotAmplitude);
    const amplitude = Math.min(s.qamScaleOverride ?? safeScale, safeScale);
    return buildGridBurst({
      sampleRate: 48000,
      freqs,
      pilotFreqHz: s.pilotFreqHz,
      pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
      amplitude,
      ms: 1500,
    });
  }, [s.toneCount, s.pilotFreqHz, s.toneStartHz, s.qamScaleOverride]);

  const runGrid = useCallback(async () => {
    setRunning(true);
    setError(null);
    const { player, recorder } = io();
    const burst = gridBurst();
    try {
      await recorder.start(48000, undefined, s.selectedInputId);
      await new Promise((r) => setTimeout(r, 250));
      dlog('GRID', {
        tones: burst.freqs.length,
        lo: burst.freqs[0],
        hi: burst.freqs[burst.freqs.length - 1],
        ms: Math.round((burst.audio.length / burst.sampleRate) * 1000),
      });
      await player.play(burst.audio, burst.sampleRate, s.selectedOutputId, true);
      await new Promise((r) => setTimeout(r, CAPTURE_TAIL_MS));
      const recorded = await recorder.getRecordedSamples();
      const r = measureGridResponse(recorded, burst);
      if (r.failed) {
        setError('No grid burst found in the recording — check input device and volume.');
        dlog('GRID', { failed: true }, { level: 'warn' });
      } else {
        setGrid(r);
        const spread = Math.max(...r.db) - Math.min(...r.db);
        dlog('GRID', { spreadDb: spread.toFixed(1) });
        for (let i = 0; i < r.freqs.length; i += 16) {
          dlog('GRID-DB', {
            f: r.freqs[i],
            db: r.db.slice(i, i + 16).map((d) => d.toFixed(0)).join(','),
          });
        }
        // The comparison that matters: what does sounding all tones at once
        // cost, over and above what a lone tone at the same frequency loses?
        const ref = sweepRef.current;
        if (ref) {
          const delta = gridVsSweepDelta(r, ref);
          for (let i = 0; i < delta.length; i += 16) {
            dlog('GRID-DELTA', {
              f: delta[i]?.freqHz,
              db: delta.slice(i, i + 16).map((d) => d.deltaDb.toFixed(0)).join(','),
            });
          }
        } else {
          dlog('GRID', { note: 'runSweepFirstForDelta' });
        }
      }
    } catch (err) {
      setError(String(err));
      dlog('GRID', { error: String(err) }, { level: 'error' });
    } finally {
      // stopPlayback(), NOT stop(): AudioPlayer.stop() calls ctx.close(), and
      // ensureCtx() only resumes a SUSPENDED context — it cannot reopen a
      // closed one. Closing here would make the shared player permanently
      // unusable, so the second run in a session would fail with "Connecting
      // nodes after the context has been closed". recorder.stop() is fine to
      // call repeatedly: it tears down nodes and tracks but keeps its context.
      recorder.stop();
      player.stopPlayback();
      setRunning(false);
    }
  }, [gridBurst, io, s.selectedInputId, s.selectedOutputId]);

  /**
   * Full analog-chain characterisation. Everything the steady-state sweep cannot
   * answer, in one pass, logged compactly.
   *
   * Each stage exists because a specific recurring failure could not be
   * explained from the sweep alone:
   *  1 NOISE  — per-tone noise floor, so "weak tone" and "noisy tone" stop being
   *             confused. Gives true per-tone SNR when combined with stage 2.
   *  2 LEVEL  — the grid at four drive levels. If the per-tone SHAPE changes
   *             with level the path is non-linear, and a channel estimate taken
   *             at one level cannot predict another. This is the measurement
   *             that decides whether the recurring 20+ dB h ramp is real.
   *  3 IMD    — grid on EVEN slots only, measured on all slots. Any energy in
   *             the odd slots is intermodulation, and because the grid is
   *             uniformly spaced those products land exactly on other tones,
   *             where they are indistinguishable from channel response.
   *  4 ENV    — one tone, quiet then loud, magnitude per 25 ms block. Shows
   *             compression attack and release directly, with a time constant.
   *  5 XIENT  — a high-crest (coherent) burst followed by a low-crest one at the
   *             same RMS, which is exactly the preamble→data transition. Reads
   *             out the level step the receiver's amplitude reference has to
   *             survive.
   */
  const runDiagnostic = useCallback(async () => {
    setRunning(true);
    setError(null);
    const { player, recorder } = io();
    const SR = 48000;
    const freqs = Array.from(
      ofdmToneFrequencies({
        toneCount: s.toneCount,
        pilotFreqHz: s.pilotFreqHz,
        startHz: s.toneStartHz,
        spacingHz: OFDM_DEFAULTS.toneSpacingHz,
      }),
    );
    const safeScale = 0.95 / (s.toneCount * MAX_QAM_MAGNITUDE + OFDM_DEFAULTS.pilotAmplitude);
    const baseAmp = Math.min(s.qamScaleOverride ?? safeScale, safeScale);

    // AudioRecorder.getRecordedSamples() returns the ENTIRE session buffer, not
    // just what arrived since the last call, and every measurement here aligns
    // on the first rising edge it finds. Without tracking a read offset each
    // stage therefore re-measures the FIRST burst: the four drive levels came
    // back byte-identical, linearity read a flat 0 dB, and the IMD stage scored
    // odd slots off a full-grid burst from an earlier stage. Slice from the
    // offset and advance it, so each stage sees only its own audio.
    let readOffset = 0;
    const syncOffset = async (): Promise<void> => {
      readOffset = (await recorder.getRecordedSamples()).length;
    };
    const play = async (audio: Float32Array): Promise<Float32Array> => {
      await syncOffset();
      await player.play(audio, SR, s.selectedOutputId, true);
      await new Promise((r) => setTimeout(r, CAPTURE_TAIL_MS));
      const all = await recorder.getRecordedSamples();
      const fresh = all.slice(readOffset);
      readOffset = all.length;
      return fresh;
    };

    try {
      await recorder.start(SR, undefined, s.selectedInputId);
      await new Promise((r) => setTimeout(r, 250));
      dlog('DIAG', {
        tones: s.toneCount,
        lo: freqs[0],
        hi: freqs[freqs.length - 1],
        baseAmp: baseAmp.toFixed(4),
        micGain: s.micGain,
      });

      // ── 1 NOISE: record silence, measure every tone slot ──
      const silentBurst = buildGridBurst({
        sampleRate: SR, freqs, pilotFreqHz: s.pilotFreqHz,
        pilotAmplitude: 0, amplitude: 0, ms: 600,
      });
      await syncOffset();
      await new Promise((r) => setTimeout(r, 600));
      const allNoise = await recorder.getRecordedSamples();
      const noiseRec = allNoise.slice(readOffset);
      readOffset = allNoise.length;
      const noise = measureGridResponse(noiseRec, silentBurst, freqs);
      const noiseMags = noise.mags;
      for (let i = 0; i < freqs.length; i += 16) {
        dlog('DIAG-NOISE', {
          f: freqs[i],
          m: noiseMags.slice(i, i + 16).map((v) => v.toExponential(1)).join(','),
        });
      }

      // ── 2 LEVEL: same grid, four drive levels ──
      const levels = [0.25, 0.5, 1, 2].map((k) => baseAmp * k);
      const responses: Array<{ amplitude: number; mags: number[] }> = [];
      for (const amplitude of levels) {
        const burst = buildGridBurst({
          sampleRate: SR, freqs, pilotFreqHz: s.pilotFreqHz,
          pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude, amplitude, ms: 800,
        });
        const rec = await play(burst.audio);
        const r = measureGridResponse(rec, burst);
        responses.push({ amplitude, mags: r.mags });
        const spread = r.failed ? NaN : Math.max(...r.db) - Math.min(...r.db);
        dlog('DIAG-LEVEL', {
          amp: amplitude.toFixed(4),
          rel: `${(20 * Math.log10(amplitude / baseAmp)).toFixed(0)}dB`,
          spreadDb: spread.toFixed(1),
          failed: r.failed,
        });
        for (let i = 0; i < freqs.length; i += 16) {
          dlog('DIAG-LEVEL-DB', {
            f: freqs[i],
            db: r.db.slice(i, i + 16).map((d) => d.toFixed(0)).join(','),
          });
        }
      }
      const lin = linearityDeviationDb(responses);
      dlog(
        'DIAG-LINEARITY',
        {
          maxDevDb: lin.maxDeviationDb.toFixed(1),
          note: lin.maxDeviationDb > 3 ? 'NONLINEAR' : 'linear',
        },
        { level: 'warn' },
      );
      for (let i = 0; i < lin.perToneDb.length; i += 16) {
        dlog('DIAG-LIN-DB', {
          f: freqs[i],
          db: lin.perToneDb.slice(i, i + 16).map((d) => d.toFixed(0)).join(','),
        });
      }

      // ── 3 IMD: transmit even slots, measure all ──
      const evenFreqs = freqs.filter((_f, i) => i % 2 === 0);
      const imdBurst = buildGridBurst({
        sampleRate: SR, freqs: evenFreqs, pilotFreqHz: s.pilotFreqHz,
        pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude, amplitude: baseAmp, ms: 800,
      });
      const imdRec = await play(imdBurst.audio);
      const imd = measureGridResponse(imdRec, imdBurst, freqs);
      const onSlots: number[] = [];
      const offSlots: number[] = [];
      imd.mags.forEach((m, i) => (i % 2 === 0 ? onSlots : offSlots).push(m));
      const meanOn = onSlots.reduce((a, b) => a + b, 0) / Math.max(1, onSlots.length);
      const meanOff = offSlots.reduce((a, b) => a + b, 0) / Math.max(1, offSlots.length);
      const meanNoiseOff = noiseMags
        .filter((_m, i) => i % 2 !== 0)
        .reduce((a, b) => a + b, 0) / Math.max(1, offSlots.length);
      dlog(
        'DIAG-IMD',
        {
          onSlotDb: '0',
          offSlotDb: (20 * Math.log10(Math.max(meanOff, 1e-12) / Math.max(meanOn, 1e-12))).toFixed(1),
          noiseSlotDb: (20 * Math.log10(Math.max(meanNoiseOff, 1e-12) / Math.max(meanOn, 1e-12))).toFixed(1),
          note: meanOff > meanNoiseOff * 3 ? 'IMD_ABOVE_NOISE' : 'imd_at_noise',
        },
        { level: 'warn' },
      );

      // ── 4 ENV: one tone, quiet 400ms then loud 800ms then quiet 400ms ──
      const probeHz = freqs[Math.floor(freqs.length / 2)];
      const quiet = buildToneBurst({ sampleRate: SR, freqHz: probeHz, amplitude: baseAmp, ms: 400 });
      const loud = buildToneBurst({ sampleRate: SR, freqHz: probeHz, amplitude: Math.min(0.9, baseAmp * 8), ms: 800 });
      const envAudio = new Float32Array(quiet.length + loud.length + quiet.length);
      envAudio.set(quiet, 0);
      envAudio.set(loud, quiet.length);
      envAudio.set(quiet, quiet.length + loud.length);
      const envRec = await play(envAudio);
      const env = measureEnvelope(envRec, probeHz, SR, 25);
      dlog('DIAG-ENV', { hz: probeHz, blockMs: 25, blocks: env.blocks.length });
      for (let i = 0; i < env.blocks.length; i += 16) {
        dlog('DIAG-ENV-M', {
          b: i,
          m: env.blocks.slice(i, i + 16).map((v) => v.toExponential(1)).join(','),
        });
      }

      // ── 5 XIENT: coherent (high-crest) then de-cohered, equal RMS ──
      const coherent = buildGridBurst({
        sampleRate: SR, freqs, pilotFreqHz: s.pilotFreqHz,
        pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude, amplitude: baseAmp, ms: 700,
      });
      // Force phase alignment by rebuilding as a plain sum at zero phase.
      const coh = new Float32Array(coherent.audio.length);
      for (const f of freqs) {
        const w = (2 * Math.PI * f) / SR;
        for (let i = 0; i < coh.length; i++) coh[i] += baseAmp * Math.sin(w * i);
      }
      const wp = (2 * Math.PI * s.pilotFreqHz) / SR;
      for (let i = 0; i < coh.length; i++) {
        coh[i] += baseAmp * OFDM_DEFAULTS.pilotAmplitude * Math.sin(wp * i);
      }
      const xient = new Float32Array(coh.length + coherent.audio.length);
      xient.set(coh, 0);
      xient.set(coherent.audio, coh.length);
      let cohPeak = 0;
      for (let i = 0; i < coh.length; i++) cohPeak = Math.max(cohPeak, Math.abs(coh[i]));
      let decPeak = 0;
      for (let i = 0; i < coherent.audio.length; i++) {
        decPeak = Math.max(decPeak, Math.abs(coherent.audio[i]));
      }
      const xRec = await play(xient);
      const xEnv = measureEnvelope(xRec, s.pilotFreqHz, SR, 25);
      dlog('DIAG-XIENT', {
        cohPeak: cohPeak.toFixed(3),
        decohPeak: decPeak.toFixed(3),
        blocks: xEnv.blocks.length,
        note: 'pilot magnitude per 25ms across coherent->decohered',
      });
      for (let i = 0; i < xEnv.blocks.length; i += 16) {
        dlog('DIAG-XIENT-M', {
          b: i,
          m: xEnv.blocks.slice(i, i + 16).map((v) => v.toExponential(1)).join(','),
        });
      }

      dlog('DIAG', { done: true });
    } catch (err) {
      setError(String(err));
      dlog('DIAG', { error: String(err) }, { level: 'error' });
    } finally {
      recorder.stop();
      player.stopPlayback();
      setRunning(false);
    }
  }, [
    io, s.toneCount, s.pilotFreqHz, s.toneStartHz, s.qamScaleOverride,
    s.selectedInputId, s.selectedOutputId, s.micGain,
  ]);

  /** Before/after per-tone response, for the calibration plot. */
  const [cal, setCal] = useState<{
    freqs: number[];
    beforeDb: number[];
    afterDb: number[];
    beforeSpread: number;
    afterSpread: number;
  } | null>(null);

  /**
   * The modem's own per-tone amplitude. Every measurement here uses it so the
   * sweep, the grid and the calibration all probe the SAME operating point —
   * measuring at a different level measures a different chain, because the
   * output stage compresses (see SWEEP_DEFAULTS.amplitude).
   */
  const perToneAmplitude = useCallback(() => {
    const safeScale = 0.95 / (s.toneCount * MAX_QAM_MAGNITUDE + OFDM_DEFAULTS.pilotAmplitude);
    return Math.min(s.qamScaleOverride ?? safeScale, safeScale);
  }, [s.toneCount, s.qamScaleOverride]);

  /** Calibration key — see AppState.toneGainsByDevice for why both parts. */
  const calKey = `${s.pilotFreqHz}:${s.toneStartHz}:${s.toneCount}`;
  const storedGains = s.toneGainsByDevice[s.selectedInputId]?.[calKey];

  /**
   * Iteratively flatten the RECEIVED spectrum: measure the grid, correct the
   * per-tone gains, measure again. Three passes, then store the result against
   * this microphone and band.
   *
   * Measures with the gains actually in force each round rather than predicting
   * from one measurement, because the prediction is only exact for a noiseless
   * linear channel — and it converges in 2-3 passes anyway.
   */
  const runCalibration = useCallback(async () => {
    setRunning(true);
    setError(null);
    const { player, recorder } = io();
    const SR = 48000;
    const freqs = Array.from(
      ofdmToneFrequencies({
        toneCount: s.toneCount,
        pilotFreqHz: s.pilotFreqHz,
        startHz: s.toneStartHz,
        spacingHz: OFDM_DEFAULTS.toneSpacingHz,
      }),
    );
    const safeScale = 0.95 / (s.toneCount * MAX_QAM_MAGNITUDE + OFDM_DEFAULTS.pilotAmplitude);
    const amplitude = Math.min(s.qamScaleOverride ?? safeScale, safeScale);

    let gainsDb = new Array<number>(s.toneCount).fill(0);
    const GRID_ROUNDS = 2;

    /** Play a grid burst under `gains` and return its per-tone magnitudes. */
    const measureGrid = async (gains: number[]): Promise<number[] | null> => {
      const burst = buildGridBurst({
        sampleRate: SR,
        freqs,
        pilotFreqHz: s.pilotFreqHz,
        pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
        amplitude,
        ms: 900,
        toneGains: gainsDbToLinear(gains),
      });
      const offset = (await recorder.getRecordedSamples()).length;
      await player.play(burst.audio, SR, s.selectedOutputId, true);
      await new Promise((r) => setTimeout(r, CAPTURE_TAIL_MS));
      const all = await recorder.getRecordedSamples();
      const measured = measureGridResponse(all.slice(offset), burst);
      return measured.failed ? null : measured.mags;
    };

    try {
      await recorder.start(SR, undefined, s.selectedInputId);
      await new Promise((r) => setTimeout(r, 250));
      dlog('CAL', { tones: s.toneCount, key: calKey, gridRounds: GRID_ROUNDS, maxBoostDb: 9 });

      // ── 0: uncalibrated grid, kept as the "before" reference ──
      const baseline = await measureGrid(gainsDb);
      if (!baseline) {
        setError('Calibration heard nothing — check input device and volume.');
        dlog('CAL', { stage: 'baseline', failed: true }, { level: 'warn' });
        return;
      }
      const beforeSpread = responseSpreadDb(baseline);
      dlog('CAL-ROUND', { stage: 'baseline', spreadDb: beforeSpread.toFixed(1) });

      // ── 1: seed from a high-resolution single-tone sweep of just this band ──
      // One tone at a time means each point gets the whole transmit power rather
      // than 1/N of it, so this estimate is far less noise-limited than a grid
      // measurement — a much better starting point than iterating up from zero.
      const pad = OFDM_DEFAULTS.toneSpacingHz;
      const sweepPlan = buildSweep({
        ...SWEEP_DEFAULTS,
        sampleRate: SR,
        amplitude,
        startHz: Math.max(SWEEP_DEFAULTS.startHz, freqs[0] - pad),
        endHz: freqs[freqs.length - 1] + pad,
      });
      const sweepOffset = (await recorder.getRecordedSamples()).length;
      await player.play(sweepPlan.audio, SR, s.selectedOutputId, true);
      await new Promise((r) => setTimeout(r, CAPTURE_TAIL_MS));
      const sweepAll = await recorder.getRecordedSamples();
      const sweepRes = measureSweep(sweepAll.slice(sweepOffset), sweepPlan);
      if (!sweepRes.failed) {
        const atTones = sampleResponseAt(sweepRes, freqs);
        gainsDb = refinePreEmphasis(gainsDb, atTones);
        dlog('CAL-ROUND', {
          stage: 'sweepSeed',
          steps: sweepPlan.freqs.length,
          spreadDb: responseSpreadDb(atTones).toFixed(1),
        });
      } else {
        dlog('CAL-ROUND', { stage: 'sweepSeed', failed: true }, { level: 'warn' });
      }

      // ── 2: refine against the real multi-tone waveform ──
      for (let round = 0; round < GRID_ROUNDS; round++) {
        const mags = await measureGrid(gainsDb);
        if (!mags) {
          setError('Calibration lost the signal mid-run.');
          dlog('CAL', { round, failed: true }, { level: 'warn' });
          return;
        }
        dlog('CAL-ROUND', { round, spreadDb: responseSpreadDb(mags).toFixed(1) });
        gainsDb = refinePreEmphasis(gainsDb, mags);
        for (let i = 0; i < gainsDb.length; i += 16) {
          dlog('CAL-GAIN-DB', {
            t: i,
            db: gainsDb.slice(i, i + 16).map((g) => g.toFixed(1)).join(','),
          });
        }
      }

      // ── 3: verify with the final gains rather than trusting the last correction ──
      const finalMags = await measureGrid(gainsDb);
      if (!finalMags) {
        setError('Calibration lost the signal before verification.');
        return;
      }
      const afterSpread = responseSpreadDb(finalMags);

      setCal({
        freqs,
        beforeDb: magsToRelativeDb(baseline),
        afterDb: magsToRelativeDb(finalMags),
        beforeSpread,
        afterSpread,
      });

      setState({
        toneGainsByDevice: {
          ...s.toneGainsByDevice,
          [s.selectedInputId]: {
            ...(s.toneGainsByDevice[s.selectedInputId] ?? {}),
            [calKey]: gainsDbToLinear(gainsDb),
          },
        },
      });
      dlog(
        'CAL',
        {
          done: true,
          beforeSpreadDb: beforeSpread.toFixed(1),
          afterSpreadDb: afterSpread.toFixed(1),
          stored: calKey,
        },
        { level: 'warn' },
      );
    } catch (err) {
      setError(String(err));
      dlog('CAL', { error: String(err) }, { level: 'error' });
    } finally {
      recorder.stop();
      player.stopPlayback();
      setRunning(false);
    }
  }, [
    io, calKey, s.toneCount, s.pilotFreqHz, s.toneStartHz, s.qamScaleOverride,
    s.selectedInputId, s.selectedOutputId, s.toneGainsByDevice,
  ]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    const { player, recorder } = io();
    const plan = buildSweep({
      ...SWEEP_DEFAULTS,
      sampleRate: 48000,
      amplitude: perToneAmplitude(),
    });

    try {
      await recorder.start(48000, undefined, s.selectedInputId);
      // Let the input stream settle before the first step, otherwise step 0
      // can be clipped by stream startup and alignment has nothing to lock to.
      await new Promise((r) => setTimeout(r, 250));

      const durationMs = (plan.audio.length / plan.sampleRate) * 1000;
      dlog('SWEEP', {
        start: plan.freqs[0],
        end: plan.freqs[plan.freqs.length - 1],
        step: plan.freqs[1] - plan.freqs[0],
        steps: plan.freqs.length,
        ms: Math.round(durationMs),
      });

      // `clean` playback: bypass the UI volume and clip guard so the level
      // that reaches the speaker is exactly the amplitude we chose. A rescaled
      // sweep would measure the guard's behavior, not the channel's.
      await player.play(plan.audio, plan.sampleRate, s.selectedOutputId, true);
      await new Promise((r) => setTimeout(r, CAPTURE_TAIL_MS));

      const recorded = await recorder.getRecordedSamples();
      const r = measureSweep(recorded, plan);

      if (r.failed) {
        setError('No sweep found in the recording — check the input device and volume.');
        dlog('SWEEP', { failed: true, recordedSamples: recorded.length }, { level: 'warn' });
      } else {
        const { spreadDb, notches, notchSpacingHz } = summarizeSweep(r);
        prevRef.current = result;
        sweepRef.current = r;
        setResult(r);
        dlog('SWEEP', {
          spreadDb: spreadDb.toFixed(1),
          notches: notches.length,
          spacingHz: notchSpacingHz ?? '-',
        });
        // Full curve, in the same compact form as [OFDM-TRAIN] h so the two are
        // directly comparable in the log.
        for (let i = 0; i < r.freqs.length; i += 16) {
          dlog('SWEEP-DB', {
            f: r.freqs[i],
            db: r.db.slice(i, i + 16).map((d) => d.toFixed(0)).join(','),
          });
        }
        for (const n of notches) {
          dlog('SWEEP-NOTCH', { hz: n.freqHz, depthDb: n.depthDb.toFixed(1) }, { level: 'warn' });
        }

        // ── second pass, with the stored pre-emphasis applied ──
        // Measured, not predicted. Adding the gain table to the raw curve would
        // assume the correction lands exactly as intended, which is the very
        // thing worth checking.
        const gainKey = `${s.pilotFreqHz}:${s.toneStartHz}:${s.toneCount}`;
        const gains = s.toneGainsByDevice[s.selectedInputId]?.[gainKey];
        // Say why the second pass is or is not meaningful. "Both curves look
        // identical" has three quite different causes — no calibration stored,
        // a calibration stored under a different key, or a stored calibration
        // that is genuinely near-unity — and they are indistinguishable on the
        // plot alone.
        const gainSpreadDb = gains && gains.length > 0
          ? 20 * Math.log10(Math.max(...gains) / Math.max(Math.min(...gains), 1e-9))
          : 0;
        dlog('SWEEP-CAL', {
          key: gainKey,
          device: (s.selectedInputId || 'default').slice(0, 8),
          haveGains: Boolean(gains),
          gainCount: gains?.length ?? 0,
          expected: s.toneCount,
          gainSpreadDb: gainSpreadDb.toFixed(1),
          knownKeys: Object.keys(s.toneGainsByDevice[s.selectedInputId] ?? {}).join('|') || 'none',
        });
        if (gains && gains.length === s.toneCount && gainSpreadDb < 0.5) {
          dlog(
            'SWEEP-CAL',
            { skipped: 'gainsAreFlat', note: 'calibration is near-unity, nothing to show' },
            { level: 'warn' },
          );
        }
        if (gains && gains.length === s.toneCount) {
          const toneFreqs = Array.from(
            ofdmToneFrequencies({
              toneCount: s.toneCount,
              pilotFreqHz: s.pilotFreqHz,
              startHz: s.toneStartHz,
              spacingHz: OFDM_DEFAULTS.toneSpacingHz,
            }),
          );
          const calPlan = buildSweep({
            ...SWEEP_DEFAULTS,
            sampleRate: 48000,
            amplitude: perToneAmplitude(),
            gainForFreq: makeGainInterpolator(toneFreqs, gains),
          });
          const calOffset = (await recorder.getRecordedSamples()).length;
          await player.play(calPlan.audio, calPlan.sampleRate, s.selectedOutputId, true);
          await new Promise((rr) => setTimeout(rr, CAPTURE_TAIL_MS));
          const calAll = await recorder.getRecordedSamples();
          const calRes = measureSweep(calAll.slice(calOffset), calPlan);
          if (calRes.failed) {
            setSweepCalibrated(null);
            dlog('SWEEP', { calibratedPass: 'failed' }, { level: 'warn' });
          } else {
            setSweepCalibrated(calRes);
            const cs = summarizeSweep(calRes);
            dlog('SWEEP-CAL', {
              spreadDb: cs.spreadDb.toFixed(1),
              notches: cs.notches.length,
            });
            for (let i = 0; i < calRes.freqs.length; i += 16) {
              dlog('SWEEP-CAL-DB', {
                f: calRes.freqs[i],
                db: calRes.db.slice(i, i + 16).map((d) => d.toFixed(0)).join(','),
              });
            }
          }
        } else {
          setSweepCalibrated(null);
        }
      }
    } catch (err) {
      setError(String(err));
      dlog('SWEEP', { error: String(err) }, { level: 'error' });
    } finally {
      // stopPlayback(), NOT stop(): AudioPlayer.stop() calls ctx.close(), and
      // ensureCtx() only resumes a SUSPENDED context — it cannot reopen a
      // closed one. Closing here would make the shared player permanently
      // unusable, so the second run in a session would fail with "Connecting
      // nodes after the context has been closed". recorder.stop() is fine to
      // call repeatedly: it tears down nodes and tracks but keeps its context.
      recorder.stop();
      player.stopPlayback();
      setRunning(false);
    }
  }, [
    io, perToneAmplitude, s.selectedInputId, s.selectedOutputId, result,
    s.toneGainsByDevice, s.toneCount, s.pilotFreqHz, s.toneStartHz,
  ]);

  const summary = result ? summarizeSweep(result) : null;

  // ── plot geometry ──
  const W = 620;
  const H = 200;
  const DB_FLOOR = -45;
  const x = (i: number, n: number) => (i / Math.max(1, n - 1)) * W;
  const y = (db: number) => {
    const clamped = Math.max(DB_FLOOR, Math.min(0, db));
    return H - ((clamped - DB_FLOOR) / -DB_FLOOR) * H;
  };
  const path = (r: SweepResult) =>
    r.db.map((db, i) => `${i === 0 ? 'M' : 'L'}${x(i, r.db.length).toFixed(1)},${y(db).toFixed(1)}`).join(' ');

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        width: W + 40,
        background: '#12140f',
        border: `2px solid ${T.panelEdge}`,
        borderRadius: T.radius,
        padding: 16,
        fontFamily: T.mono,
        fontSize: 12,
        color: '#e8e4d8',
        boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        zIndex: 1000,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <strong style={{ fontSize: 13, letterSpacing: 1 }}>CHANNEL SWEEP · speaker → mic response</strong>
        {onClose && (
          <button
            onClick={onClose}
            style={{ background: 'none', border: 0, color: '#8a857a', cursor: 'pointer', fontSize: 14 }}
          >
            ✕
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
        <Button primary onClick={run} disabled={running}>
          {running ? 'SWEEPING…' : '▶ SINGLE-TONE SWEEP'}
        </Button>
        <Button onClick={runGrid} disabled={running}>
          {running ? 'RUNNING…' : '▶ GRID (ALL TONES AT ONCE)'}
        </Button>
        <Button onClick={runDiagnostic} disabled={running}>
          {running ? 'RUNNING…' : '🔬 FULL CHAIN DIAGNOSTIC (~15s)'}
        </Button>
        <Button onClick={runCalibration} disabled={running}>
          {running ? 'RUNNING…' : '🎚 CALIBRATE PRE-EMPHASIS'}
        </Button>
        <span style={{ color: storedGains ? T.phosphor : '#8a857a', fontSize: 11 }}>
          {storedGains
            ? `calibrated: ${storedGains.length} tones @ ${calKey}`
            : `uncalibrated @ ${calKey}`}
        </span>
        <span style={{ color: '#8a857a', fontSize: 11 }}>
          {SWEEP_DEFAULTS.startHz}–{SWEEP_DEFAULTS.endHz} Hz · {SWEEP_DEFAULTS.stepHz} Hz steps ·{' '}
          {((buildSweep(SWEEP_DEFAULTS).audio.length / 48000)).toFixed(1)}s
        </span>
      </div>

      {error && <div style={{ color: '#ff8a8a', marginBottom: 8 }}>{error}</div>}

      {cal && (() => {
        // Before/after per-tone response, both plotted relative to their OWN
        // mean — calibration redistributes power rather than adding any, so an
        // absolute comparison would just show the two curves offset. What
        // matters is whether the spread collapsed.
        const CW = W;
        const CH = 130;
        const FLOOR = -24;
        const cx = (i: number) => (i / Math.max(1, cal.freqs.length - 1)) * CW;
        const cy = (db: number) => {
          const v = Math.max(FLOOR, Math.min(-FLOOR, Number.isFinite(db) ? db : FLOOR));
          return CH / 2 - (v / -FLOOR) * (CH / 2);
        };
        const line = (arr: number[]) =>
          arr
            .map((db, i) => `${i === 0 ? 'M' : 'L'}${cx(i).toFixed(1)},${cy(db).toFixed(1)}`)
            .join(' ');
        const improved = cal.beforeSpread - cal.afterSpread;
        return (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, marginBottom: 4, letterSpacing: 1 }}>
              PRE-EMPHASIS · per-tone, relative to own mean
            </div>
            <svg width={CW} height={CH} style={{ background: '#0a0b08', borderRadius: 4, display: 'block' }}>
              {[12, 6, 0, -6, -12].map((db) => (
                <g key={db}>
                  <line
                    x1={0}
                    x2={CW}
                    y1={cy(db)}
                    y2={cy(db)}
                    stroke={db === 0 ? '#3a3d33' : '#2a2d24'}
                    strokeWidth={1}
                  />
                  <text x={2} y={cy(db) - 2} fill="#5a5d50" fontSize={9}>
                    {db > 0 ? `+${db}` : db}
                  </text>
                </g>
              ))}
              <path d={line(cal.beforeDb)} fill="none" stroke="#8a857a" strokeWidth={1} strokeDasharray="3 3" />
              <path d={line(cal.afterDb)} fill="none" stroke={T.phosphor} strokeWidth={1.5} />
            </svg>
            <div style={{ display: 'flex', gap: 16, marginTop: 6, fontSize: 11, flexWrap: 'wrap' }}>
              <span style={{ color: '#8a857a' }}>
                before <strong>{cal.beforeSpread.toFixed(1)} dB</strong>
              </span>
              <span style={{ color: T.phosphor }}>
                after <strong>{cal.afterSpread.toFixed(1)} dB</strong>
              </span>
              <span style={{ color: improved > 0 ? T.phosphor : '#ff8a8a' }}>
                {improved > 0 ? '−' : '+'}
                {Math.abs(improved).toFixed(1)} dB spread
              </span>
              <span style={{ color: '#8a857a' }}>
                {cal.freqs[0]}–{cal.freqs[cal.freqs.length - 1]} Hz
              </span>
            </div>
            <div style={{ marginTop: 4, color: '#8a857a', fontSize: 11, lineHeight: 1.5 }}>
              Dashed = uncalibrated. Solid = after calibration. Gains are clamped to ±9 dB and
              mean-zero, so a tone in a deep null is deliberately NOT fully corrected — inverting
              it would spend the power budget on a frequency the room deletes.
            </div>
          </div>
        );
      })()}

      {result && (
        <>
          <svg width={W} height={H} style={{ background: '#0a0b08', borderRadius: 4, display: 'block' }}>
            {/* dB gridlines every 10 dB */}
            {[0, -10, -20, -30, -40].map((db) => (
              <g key={db}>
                <line x1={0} x2={W} y1={y(db)} y2={y(db)} stroke="#2a2d24" strokeWidth={1} />
                <text x={2} y={y(db) - 2} fill="#5a5d50" fontSize={9}>
                  {db}
                </text>
              </g>
            ))}
            {/* the band the tone grid currently occupies */}
            {(() => {
              const lo = s.pilotFreqHz + (s.toneStartHz ?? 0);
              const hi = lo + (s.toneCount - 1) * 50;
              const f0 = result.freqs[0];
              const fN = result.freqs[result.freqs.length - 1];
              const toX = (f: number) => ((f - f0) / (fN - f0)) * W;
              return (
                <rect
                  x={toX(lo)}
                  width={Math.max(1, toX(hi) - toX(lo))}
                  y={0}
                  height={H}
                  fill="#3b7d4f"
                  opacity={0.13}
                />
              );
            })()}
            {prevRef.current && (
              <path d={path(prevRef.current)} fill="none" stroke="#5a5d50" strokeWidth={1} strokeDasharray="3 3" />
            )}
            <path d={path(result)} fill="none" stroke="#5aa9ff" strokeWidth={1.5} />
            {sweepCalibrated && (
              <path d={path(sweepCalibrated)} fill="none" stroke="#ffd23d" strokeWidth={1.5} />
            )}
            {grid && (() => {
              // Grid tones are a subset of the sweep's frequencies, so place
              // them on the sweep's x-axis rather than their own.
              const f0 = result.freqs[0];
              const fN = result.freqs[result.freqs.length - 1];
              const toX = (f: number) => ((f - f0) / (fN - f0)) * W;
              const d = grid.freqs
                .map((f, i) => `${i === 0 ? 'M' : 'L'}${toX(f).toFixed(1)},${y(grid.db[i]).toFixed(1)}`)
                .join(' ');
              return <path d={d} fill="none" stroke="#ffb03d" strokeWidth={1.5} />;
            })()}
          </svg>

          <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
            <span>
              spread <strong>{summary!.spreadDb.toFixed(1)} dB</strong>
            </span>
            <span>
              notches <strong>{summary!.notches.length}</strong>
            </span>
            {sweepCalibrated && (() => {
              const rawSpread = summarizeSweep(result).spreadDb;
              const calSpread = summarizeSweep(sweepCalibrated).spreadDb;
              const delta = rawSpread - calSpread;
              return (
                <span style={{ color: '#ffd23d' }}>
                  calibrated spread <strong>{calSpread.toFixed(1)} dB</strong>{' '}
                  <span style={{ color: delta > 0 ? T.phosphor : '#ff8a8a' }}>
                    ({delta > 0 ? '−' : '+'}
                    {Math.abs(delta).toFixed(1)} dB)
                  </span>
                </span>
              );
            })()}
            {summary!.notchSpacingHz != null && (
              <span>
                spacing <strong>{summary!.notchSpacingHz} Hz</strong>{' '}
                <span style={{ color: '#8a857a' }}>
                  (≈{(34300 / summary!.notchSpacingHz).toFixed(0)} cm path difference)
                </span>
              </span>
            )}
          </div>

          {summary!.notches.length > 0 && (
            <div style={{ marginTop: 6, color: '#cfc9ba', fontSize: 11 }}>
              deepest:{' '}
              {summary!.notches
                .slice()
                .sort((a, b) => a.depthDb - b.depthDb)
                .slice(0, 6)
                .map((n) => `${n.freqHz}Hz ${n.depthDb.toFixed(0)}dB`)
                .join('  ')}
            </div>
          )}

          {grid && (() => {
            const delta = gridVsSweepDelta(grid, result);
            if (!delta.length) return null;
            const worst = delta.slice().sort((a, b) => a.deltaDb - b.deltaDb).slice(0, 5);
            const mean = delta.reduce((a, d) => a + d.deltaDb, 0) / delta.length;
            return (
              <div style={{ marginTop: 8, fontSize: 11, color: '#ffb03d' }}>
                GRID − SWEEP: mean <strong>{mean.toFixed(1)} dB</strong>, worst{' '}
                {worst.map((d) => `${d.freqHz}Hz ${d.deltaDb.toFixed(0)}dB`).join('  ')}
                <div style={{ color: '#8a857a', marginTop: 2 }}>
                  Both curves are normalized to their own peak, so a flat 0 line means sounding all
                  tones together costs nothing beyond the room. Big negative spikes at single tones
                  are a multi-tone-only effect (intermodulation, compression, or a noisy channel
                  estimate) — not the room, and not fixable by moving the band.
                </div>
              </div>
            );
          })()}

          <div style={{ marginTop: 8, color: '#8a857a', fontSize: 11, lineHeight: 1.5 }}>
            Blue = single-tone sweep, raw.{' '}
            {sweepCalibrated
              ? 'Yellow = same sweep with the stored pre-emphasis applied.'
              : `No pre-emphasis stored for ${calKey} on this input, so only the raw curve is shown — run CALIBRATE first.`} Orange = the real {s.toneCount}-tone grid at the modem's own per-tone level.
            Green band = the grid's current frequencies. Dashed grey = previous sweep.
            <br />
            Run once, move the laptop or lift it off the desk, run again: notches that MOVE are
            acoustic cancellation (bit loading is the fix). Notches that STAY are fixed speaker or
            mic response (a permanent band choice can dodge them).
          </div>
        </>
      )}
    </div>
  );
}

/**
 * channelSweep.test.ts — the sweep must report a flat channel as flat, and
 * must find a notch that is really there, at the right frequency and depth.
 *
 * This matters more than usual: the whole point of the tool is to settle
 * whether a dip seen in `[OFDM-TRAIN] h` is acoustic or an artifact of our own
 * processing. A sweep that invents or misplaces notches would send that
 * investigation the wrong way, so both directions are pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSweep,
  measureSweep,
  summarizeSweep,
  buildGridBurst,
  measureGridResponse,
  gridVsSweepDelta,
  SWEEP_DEFAULTS,
  buildToneBurst,
  measureEnvelope,
  linearityDeviationDb,
  refinePreEmphasis,
  gainsDbToLinear,
  responseSpreadDb,
  PRE_EMPHASIS_DEFAULTS,
  sampleResponseAt,
  magsToRelativeDb,
  makeGainInterpolator,
} from '../diag/channelSweep';

// A short, coarse sweep — same code paths, far fewer steps than the real one.
const OPTS = { ...SWEEP_DEFAULTS, startHz: 2000, endHz: 4000, stepHz: 100, stepMs: 40 };

/** Delay the recording by `n` samples, as real capture latency would. */
function delayed(audio: Float32Array, n: number): Float32Array {
  const out = new Float32Array(audio.length + n);
  out.set(audio, n);
  return out;
}

describe('channel sweep: flat channel', () => {
  it('reports a flat response when the loopback is flat', () => {
    const plan = buildSweep(OPTS);
    const r = measureSweep(delayed(plan.audio, 1234), plan);

    expect(r.failed).toBe(false);
    const { spreadDb, notches } = summarizeSweep(r);
    // Goertzel leakage and fade windowing leave a little ripple; nothing near
    // the 20+ dB the acoustic runs show.
    expect(spreadDb).toBeLessThan(3);
    expect(notches).toHaveLength(0);
  });

  it('recovers alignment despite capture latency', () => {
    const plan = buildSweep(OPTS);
    const delay = 5000;
    const r = measureSweep(delayed(plan.audio, delay), plan);
    // Within one analysis hop of the true offset.
    expect(Math.abs(r.alignOffset - delay)).toBeLessThan(Math.round(0.02 * OPTS.sampleRate));
  });
});

describe('channel sweep: notched channel', () => {
  it('finds an injected notch at the right frequency and depth', () => {
    const plan = buildSweep(OPTS);
    const NOTCH_HZ = 3000;
    const NOTCH_GAIN = 0.05; // -26 dB

    // Attenuate only the step that carries the notch frequency, which is what
    // a narrow acoustic null does to a stepped sweep.
    const notched = new Float32Array(plan.audio.length);
    notched.set(plan.audio);
    const k = plan.freqs.indexOf(NOTCH_HZ);
    expect(k).toBeGreaterThan(0);
    for (let n = 0; n < plan.stepSamples; n++) {
      notched[k * plan.stepSamples + n] *= NOTCH_GAIN;
    }

    const r = measureSweep(delayed(notched, 777), plan);
    expect(r.failed).toBe(false);

    const { notches } = summarizeSweep(r);
    expect(notches.length).toBeGreaterThanOrEqual(1);
    const found = notches.find((x) => Math.abs(x.freqHz - NOTCH_HZ) <= OPTS.stepHz);
    expect(found).toBeDefined();
    expect(found!.depthDb).toBeLessThan(-20);

    // The neighbours must stay clean — a notch that smears would make a
    // narrow null look like broad rolloff.
    const ki = r.freqs.indexOf(NOTCH_HZ);
    expect(r.db[ki - 1]).toBeGreaterThan(-3);
    expect(r.db[ki + 1]).toBeGreaterThan(-3);
  });
});

describe('grid burst: all tones at once', () => {
  const GRID = {
    sampleRate: 48000,
    freqs: Array.from({ length: 32 }, (_u, k) => 4900 + k * 50),
    pilotFreqHz: 1850,
    pilotAmplitude: 2.0,
    amplitude: 0.02,
    ms: 400,
  };

  it('measures every tone flat over a flat loopback', () => {
    const burst = buildGridBurst(GRID);
    const r = measureGridResponse(delayed(burst.audio, 3000), burst);
    expect(r.failed).toBe(false);
    const spread = Math.max(...r.db) - Math.min(...r.db);
    expect(spread).toBeLessThan(3);
  });

  it('does not let 32 simultaneous tones leak into each other', () => {
    // Null ONE tone in the frequency domain by subtracting it back out. If the
    // measurement leaked from the 31 neighbours still sounding, a fully
    // removed tone would still read a healthy level — which is exactly the
    // artifact that would fake a "multi-tone penalty".
    const burst = buildGridBurst(GRID);
    const k = 16;
    const audio = new Float32Array(burst.audio);
    const phase = (-Math.PI * k * (k - 1)) / GRID.freqs.length;
    const w = (2 * Math.PI * GRID.freqs[k]) / GRID.sampleRate;
    const fadeSamples = Math.min(Math.round(0.01 * GRID.sampleRate), audio.length >> 3);
    for (let i = 0; i < audio.length; i++) {
      let env = 1;
      if (i < fadeSamples) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeSamples);
      else if (i >= audio.length - fadeSamples) {
        const m = audio.length - 1 - i;
        env = 0.5 - 0.5 * Math.cos((Math.PI * m) / fadeSamples);
      }
      audio[i] -= env * GRID.amplitude * Math.sin(w * i + phase);
    }

    const r = measureGridResponse(delayed(audio, 1500), burst);
    expect(r.db[k]).toBeLessThan(-20);
    expect(r.db[k - 1]).toBeGreaterThan(-3);
    expect(r.db[k + 1]).toBeGreaterThan(-3);
  });

  it('reports a zero delta when grid and sweep see the same channel', () => {
    const sweepPlan = buildSweep({ ...SWEEP_DEFAULTS, startHz: 4900, endHz: 6450, stepHz: 50 });
    const sweep = measureSweep(delayed(sweepPlan.audio, 900), sweepPlan);
    const burst = buildGridBurst(GRID);
    const grid = measureGridResponse(delayed(burst.audio, 900), burst);

    const delta = gridVsSweepDelta(grid, sweep);
    expect(delta.length).toBe(32);
    for (const d of delta) expect(Math.abs(d.deltaDb)).toBeLessThan(3);
  });
});

describe('channel sweep: no signal', () => {
  it('flags a silent recording instead of reporting a response', () => {
    const plan = buildSweep(OPTS);
    const r = measureSweep(new Float32Array(plan.audio.length), plan);
    expect(r.failed).toBe(true);
  });
});

describe('envelope probe', () => {
  it('reads a constant tone as a flat envelope', () => {
    const SR = 48000;
    const tone = buildToneBurst({ sampleRate: SR, freqHz: 7000, amplitude: 0.2, ms: 500 });
    const { blocks } = measureEnvelope(delayed(tone, 2000), 7000, SR, 25);
    // Drop the last block, which can straddle the trailing fade.
    const body = blocks.slice(0, -1);
    expect(body.length).toBeGreaterThan(5);
    const spread = 20 * Math.log10(Math.max(...body) / Math.min(...body));
    expect(spread).toBeLessThan(1.5);
  });

  it('tracks a deliberate mid-burst gain step', () => {
    // A compressor releasing looks exactly like this, so the probe must resolve
    // it rather than average it away.
    const SR = 48000;
    const tone = buildToneBurst({ sampleRate: SR, freqHz: 7000, amplitude: 0.2, ms: 600 });
    const half = tone.length >> 1;
    for (let i = half; i < tone.length; i++) tone[i] *= 0.25; // -12 dB step
    const { blocks } = measureEnvelope(delayed(tone, 500), 7000, SR, 25);
    const early = blocks[2];
    const late = blocks[blocks.length - 3];
    const stepDb = 20 * Math.log10(late / early);
    expect(stepDb).toBeLessThan(-9);
    expect(stepDb).toBeGreaterThan(-15);
  });
});

describe('linearity deviation', () => {
  it('reports ~0 dB when every level has the same shape', () => {
    // A purely linear path: identical response scaled by drive level.
    const shape = [1, 2, 0.5, 4, 0.25];
    const responses = [0.1, 0.2, 0.4].map((amplitude) => ({
      amplitude,
      mags: shape.map((v) => v * amplitude),
    }));
    expect(linearityDeviationDb(responses).maxDeviationDb).toBeLessThan(0.01);
  });

  it('flags a level-dependent shape change', () => {
    // The high-drive case compresses one tone by 12 dB relative to the others,
    // which is the signature we are hunting and must not be normalized away.
    const responses = [
      { amplitude: 0.1, mags: [1, 1, 1, 1] },
      { amplitude: 0.4, mags: [1, 1, 0.25, 1] },
    ];
    const { maxDeviationDb } = linearityDeviationDb(responses);
    expect(maxDeviationDb).toBeGreaterThan(6);
  });

  it('is not fooled by an overall level difference between runs', () => {
    // Only SHAPE matters: two runs 20 dB apart but identically shaped must read
    // as linear, or every measurement would look non-linear.
    const responses = [
      { amplitude: 0.1, mags: [1, 2, 4] },
      { amplitude: 1.0, mags: [10, 20, 40] },
    ];
    expect(linearityDeviationDb(responses).maxDeviationDb).toBeLessThan(0.01);
  });
});

describe('measurement contract: callers must slice their own audio', () => {
  it('locks onto the FIRST burst when handed a recording containing several', () => {
    // Not a bug in measureGridResponse — a contract. Alignment finds the first
    // rising edge, so a caller that hands it the whole session buffer measures
    // whichever burst came first, no matter which one it just played. The chain
    // diagnostic did exactly that and reported four different drive levels as
    // byte-identical, which then read out as "perfectly linear". This test
    // exists so the next caller sees the requirement.
    const GRID = {
      sampleRate: 48000,
      freqs: Array.from({ length: 32 }, (_u, k) => 4900 + k * 50),
      pilotFreqHz: 1850,
      pilotAmplitude: 2.0,
      amplitude: 0.02,
      ms: 300,
    };
    const loud = buildGridBurst(GRID);
    const quiet = buildGridBurst({ ...GRID, amplitude: 0.002 });

    const both = new Float32Array(loud.audio.length + quiet.audio.length);
    both.set(loud.audio, 0);
    both.set(quiet.audio, loud.audio.length);

    // Whole recording: reads the loud burst even though `quiet` is the plan.
    const naive = measureGridResponse(delayed(both, 500), quiet);
    // Correctly sliced: reads the quiet burst.
    const sliced = measureGridResponse(both.slice(loud.audio.length), quiet);

    const meanOf = (m: number[]): number => m.reduce((a, b) => a + b, 0) / m.length;
    // ~20 dB apart, and the naive call reports the louder one.
    expect(meanOf(naive.mags) / meanOf(sliced.mags)).toBeGreaterThan(5);
  });
});

describe('pre-emphasis calibration', () => {
  /** Simulate a channel: received = transmitted gain x channel response. */
  const applyChannel = (gainsDb: number[], channelDb: number[]): number[] =>
    gainsDb.map((g, t) => Math.pow(10, (g + channelDb[t]) / 20));

  it('flattens a tilted channel within a few iterations', () => {
    // A 17 dB tilt, the shape actually measured on one of the microphones.
    const n = 40;
    const channelDb = Array.from({ length: n }, (_u, t) => -17 + (17 * t) / (n - 1));
    let gains = new Array<number>(n).fill(0);
    const before = responseSpreadDb(applyChannel(gains, channelDb));
    expect(before).toBeGreaterThan(16);

    for (let i = 0; i < 3; i++) {
      gains = refinePreEmphasis(gains, applyChannel(gains, channelDb));
    }
    const after = responseSpreadDb(applyChannel(gains, channelDb));
    expect(after).toBeLessThan(1);
  });

  it('never lets one tone exceed the boost clamp', () => {
    // A 40 dB null. Fully inverting it would hand almost the whole power budget
    // to a frequency the room deletes, which is why the clamp exists.
    const n = 16;
    const channelDb = new Array<number>(n).fill(0);
    channelDb[8] = -40;
    let gains = new Array<number>(n).fill(0);
    for (let i = 0; i < 6; i++) {
      gains = refinePreEmphasis(gains, applyChannel(gains, channelDb));
    }
    for (const g of gains) {
      expect(Math.abs(g)).toBeLessThanOrEqual(PRE_EMPHASIS_DEFAULTS.maxBoostDb + 0.001);
    }
  });

  it('stays mean-zero so total transmit power is redistributed, not raised', () => {
    // The peak budget in OFDMQPSKModulator assumes unity mean gain; breaking
    // that would reintroduce clipping, which has broken this link three times.
    const n = 32;
    const channelDb = Array.from({ length: n }, (_u, t) => (t % 2 === 0 ? -8 : 4));
    let gains = new Array<number>(n).fill(0);
    for (let i = 0; i < 4; i++) {
      gains = refinePreEmphasis(gains, applyChannel(gains, channelDb));
      const mean = gains.reduce((a, b) => a + b, 0) / n;
      expect(Math.abs(mean)).toBeLessThan(0.001);
    }
  });

  it('ignores tones that returned nothing instead of chasing them', () => {
    // A dead tone reads 0 magnitude. Treating that as "needs maximum boost"
    // would peg it at the clamp forever and skew every other tone via the
    // re-centring step.
    const gains = [0, 0, 0, 0];
    const next = refinePreEmphasis(gains, [1, 1, 0, 1]);
    expect(Number.isFinite(next[2])).toBe(true);
    expect(Math.abs(next[2])).toBeLessThanOrEqual(PRE_EMPHASIS_DEFAULTS.maxBoostDb);
  });

  it('converts dB to linear multipliers', () => {
    const lin = gainsDbToLinear([0, 6, -6]);
    expect(lin[0]).toBeCloseTo(1, 6);
    expect(lin[1]).toBeCloseTo(1.9953, 3);
    expect(lin[2]).toBeCloseTo(0.5012, 3);
  });
});

describe('sweep-seeded calibration', () => {
  it('samples a sweep at the tone grid frequencies', () => {
    // The sweep runs at 25 Hz steps and the grid sits on 50 Hz, so every tone
    // has a measured point. This is what lets a high-SNR single-tone sweep seed
    // a per-tone calibration.
    const plan = buildSweep({ ...SWEEP_DEFAULTS, startHz: 6900, endHz: 7100 });
    const r = measureSweep(delayed(plan.audio, 700), plan);
    const toneFreqs = [6900, 6950, 7000, 7050, 7100];
    const at = sampleResponseAt(r, toneFreqs);
    expect(at).toHaveLength(5);
    for (const m of at) expect(m).toBeGreaterThan(0);
  });

  it('returns 0 for frequencies the sweep never measured', () => {
    // refinePreEmphasis declines to chase a 0, so an out-of-band tone must not
    // come back as a plausible-looking magnitude.
    const plan = buildSweep({ ...SWEEP_DEFAULTS, startHz: 6900, endHz: 7000 });
    const r = measureSweep(delayed(plan.audio, 700), plan);
    expect(sampleResponseAt(r, [8000])[0]).toBe(0);
  });

  it('expresses before/after relative to each set own mean', () => {
    // Calibration redistributes power rather than adding any, so comparing
    // absolute levels would only show an offset. Two sets 20 dB apart but
    // identically shaped must produce identical relative curves.
    const a = magsToRelativeDb([1, 2, 4]);
    const b = magsToRelativeDb([10, 20, 40]);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 6);
  });
});

describe('gain interpolation for a swept measurement', () => {
  const toneFreqs = [7000, 7050, 7100, 7150];

  it('returns the exact gain on grid frequencies', () => {
    const g = makeGainInterpolator(toneFreqs, [1, 2, 0.5, 1]);
    expect(g(7000)).toBeCloseTo(1, 6);
    expect(g(7050)).toBeCloseTo(2, 6);
    expect(g(7100)).toBeCloseTo(0.5, 6);
  });

  it('interpolates in dB between grid frequencies', () => {
    // Halfway between +6 dB and -6 dB must be 0 dB (unity), not the arithmetic
    // mean of the linear values (1.25) — gains are a dB quantity.
    const g = makeGainInterpolator([7000, 7100], [2, 0.5]);
    expect(g(7050)).toBeCloseTo(1, 3);
  });

  it('returns unity outside the calibrated band', () => {
    // The modem transmits nothing out there, so both sweep passes must see the
    // same thing off-band or the comparison would be misleading.
    const g = makeGainInterpolator(toneFreqs, [4, 4, 4, 4]);
    expect(g(5000)).toBeCloseTo(1, 6);
    expect(g(9000)).toBeCloseTo(1, 6);
  });

  it('survives an empty calibration', () => {
    expect(makeGainInterpolator([], [])(7000)).toBe(1);
  });

  it('applies through buildSweep so the second pass is measured, not predicted', () => {
    const gainForFreq = makeGainInterpolator([3000], [4]); // +12 dB at 3000 Hz
    const plain = buildSweep({ ...SWEEP_DEFAULTS, startHz: 3000, endHz: 3000 });
    const boosted = buildSweep({ ...SWEEP_DEFAULTS, startHz: 3000, endHz: 3000, gainForFreq });
    const peak = (a: Float32Array): number => {
      let p = 0;
      for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
      return p;
    };
    expect(20 * Math.log10(peak(boosted.audio) / peak(plain.audio))).toBeCloseTo(12, 1);
  });
});

describe('sweep operating point', () => {
  it('defaults to a per-tone amplitude, not a full-scale one', () => {
    // The sweep must probe the SAME operating point as the modem, because the
    // output stage compresses: a loud sweep measures a compressed chain, which
    // flattens the reported response and makes pre-emphasis invisible (measured
    // 0-2 dB change from a +9 dB boost). 0.25 was ~20 dB above the modem's
    // qamScale at 40 tones and did exactly that.
    const modemPerToneAmplitude = 0.95 / (40 * 1.5275 + 2.0); // ~0.0151
    expect(SWEEP_DEFAULTS.amplitude).toBeLessThan(modemPerToneAmplitude * 4);
  });

  it('scales the waveform with the amplitude it is given', () => {
    const quiet = buildSweep({ ...SWEEP_DEFAULTS, startHz: 3000, endHz: 3000, amplitude: 0.02 });
    const loud = buildSweep({ ...SWEEP_DEFAULTS, startHz: 3000, endHz: 3000, amplitude: 0.2 });
    const peak = (a: Float32Array): number => {
      let p = 0;
      for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
      return p;
    };
    expect(20 * Math.log10(peak(loud.audio) / peak(quiet.audio))).toBeCloseTo(20, 1);
  });
});

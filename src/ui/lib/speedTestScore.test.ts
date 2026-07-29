/**
 * scoreTrial — the auto-tune objective. These cases are drawn from real sweep
 * output, including the run where a working 16-QAM link was wrongly discarded.
 */
import { expect, it } from 'vitest';
import { scoreTrial } from './speedTestScore';
import type { SpeedTestResult } from '../Store';

const trial = (over: Partial<SpeedTestResult>): SpeedTestResult => ({
  toneCount: 8,
  micGain: 8,
  pilotFreqHz: 1900,
  qamBits: 2,
  qamScale: 0.1,
  success: false,
  passes: 0,
  framesOk: 0,
  framesTotal: 0,
  merDb: null,
  evmPct: null,
  throughputKbps: 0.26,
  durationMs: 1000,
  ...over,
});

it('ranks a faster working link above a cleaner slower one', () => {
  // The real regression: 16-QAM delivered the file at 15.8 dB, QPSK delivered it
  // at 30.0 dB, and the sweep picked QPSK because MER outvoted throughput.
  const qpsk = trial({ success: true, qamBits: 2, dataFramesOk: 6, merDb: 30.0, throughputKbps: 0.26 });
  const qam16 = trial({ success: true, qamBits: 4, dataFramesOk: 6, merDb: 15.8, throughputKbps: 0.31 });
  expect(scoreTrial(qam16)).toBeGreaterThan(scoreTrial(qpsk));
});

it('breaks ties between equal-throughput successes on MER', () => {
  const clean = trial({ success: true, merDb: 30, throughputKbps: 0.3 });
  const marginal = trial({ success: true, merDb: 12, throughputKbps: 0.3 });
  expect(scoreTrial(clean)).toBeGreaterThan(scoreTrial(marginal));
});

it('puts every success above every failure, however good the failure looks', () => {
  const barelyWorks = trial({ success: true, dataFramesOk: 6, merDb: 9, throughputKbps: 0.01 });
  const nearMiss = trial({ dataFramesOk: 5, syncLevel: 3, merDb: 40, throughputKbps: 9 });
  expect(scoreTrial(barelyWorks)).toBeGreaterThan(scoreTrial(nearMiss));
});

it('ranks failures by data frames first', () => {
  const three = trial({ dataFramesOk: 3, syncLevel: 3, rawMerDb: 5 });
  const one = trial({ dataFramesOk: 1, syncLevel: 3, rawMerDb: 30 });
  expect(scoreTrial(three)).toBeGreaterThan(scoreTrial(one));
});

it('ignores PROFILE-only frames by preferring dataFramesOk', () => {
  // 16-QAM at a bad scale: 2 profile frames decoded, zero data. Must not
  // outrank a trial that actually moved payload.
  const profileOnly = trial({ framesOk: 2, dataFramesOk: 0, syncLevel: 3, merDb: 27 });
  const oneDataFrame = trial({ framesOk: 1, dataFramesOk: 1, syncLevel: 3, rawMerDb: 8 });
  expect(scoreTrial(oneDataFrame)).toBeGreaterThan(scoreTrial(profileOnly));
});

it('ranks deeper sync above shallower when no data got through', () => {
  const trained = trial({ dataFramesOk: 0, syncLevel: 3, rawMerDb: 2 });
  const chirpOnly = trial({ dataFramesOk: 0, syncLevel: 1, rawMerDb: 2 });
  expect(scoreTrial(trained)).toBeGreaterThan(scoreTrial(chirpOnly));
});

it('falls back to staged MER when no committed MER exists', () => {
  const withRaw = trial({ dataFramesOk: 0, syncLevel: 3, rawMerDb: 12 });
  const noMer = trial({ dataFramesOk: 0, syncLevel: 3 });
  expect(scoreTrial(withRaw)).toBeGreaterThan(scoreTrial(noMer));
});

it('clamps the 99 dB "immeasurably clean" sentinel so it cannot swing a ranking', () => {
  const sentinel = trial({ success: true, merDb: 99, throughputKbps: 0.26 });
  const faster = trial({ success: true, merDb: 10, throughputKbps: 0.31 });
  expect(scoreTrial(faster)).toBeGreaterThan(scoreTrial(sentinel));
});

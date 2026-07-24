/**
 * MER/EVM diagnostic — verifies the demodulator's modulation-error readout:
 * a clean loopback should measure high MER (tight constellation), and adding
 * channel noise must lower it. This is the metric that gates whether a denser
 * constellation (16-QAM etc.) has SNR headroom.
 */
import { expect, test } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { ofdmToneFrequencies } from '../types';

const TONE_COUNT = 4;
const PILOT_FREQ = 1900;
const TONE_FREQS = ofdmToneFrequencies({ toneCount: TONE_COUNT });
const SAMPLE_RATE = 48000;

function makeMod() {
  return new OFDMQPSKModulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
    pilotAmplitude: 0.4,
  });
}

function makeTrainedPair() {
  const mod = makeMod();
  const demod = new OFDMQPSKDemodulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
  });
  mod.setSymbols(new Array(TONE_COUNT).fill(0));
  for (let s = 0; s < 12; s++) demod.trainOnSyncSymbol(mod.generateSymbol());
  return { mod, demod };
}

/** Deterministic LCG noise so the test is reproducible. */
function makeNoise(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

function measureMER(noiseAmp: number, seed: number): number {
  const { mod, demod } = makeTrainedPair();
  const noise = makeNoise(seed);
  // Fewer than the 64-symbol report window so accumulators don't reset.
  for (let s = 0; s < 50; s++) {
    const symbols = [s % 4, (s * 3) % 4, (s * 7) % 4, (s * 5) % 4];
    mod.setSymbols(symbols);
    const audio = mod.generateSymbol();
    if (noiseAmp > 0) for (let i = 0; i < audio.length; i++) audio[i] += noiseAmp * noise();
    demod.demodulate(audio);
  }
  const mer = demod.getMER();
  expect(mer).not.toBeNull();
  return mer!.merDb;
}

test('clean loopback measures high MER', () => {
  const merDb = measureMER(0, 1);
  // Noise-free loopback → constellation lands essentially dead-center.
  expect(merDb).toBeGreaterThan(25);
});

test('adding channel noise lowers MER', () => {
  const clean = measureMER(0, 1);
  const noisy = measureMER(0.15, 42);
  expect(noisy).toBeLessThan(clean);
  // Still a finite, sensible number (not NaN/Infinity).
  expect(Number.isFinite(noisy)).toBe(true);
});

test('getMER is null before any data symbols', () => {
  const { demod } = makeTrainedPair();
  expect(demod.getMER()).toBeNull();
});

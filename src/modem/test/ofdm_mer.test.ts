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
  // getMER() now reads committed stats only — fold this run's staged stats
  // in, as rxEngine would after a frame decodes successfully.
  demod.commitMER();
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

test('discardMER after a valid commit is unaffected by subsequent noise', () => {
  const { mod, demod } = makeTrainedPair();
  const cleanNoise = makeNoise(7);
  // Simulate a valid, successfully-decoded frame: demodulate clean-ish data,
  // then commit (as rxEngine does when decodeFrame().valid is true).
  for (let s = 0; s < 50; s++) {
    const symbols = [s % 4, (s * 3) % 4, (s * 7) % 4, (s * 5) % 4];
    mod.setSymbols(symbols);
    demod.demodulate(mod.generateSymbol());
  }
  demod.commitMER();
  const committed = demod.getMER();
  expect(committed).not.toBeNull();

  // Now simulate inter-send silence/garbage: demodulate heavily-noised windows
  // (as if a frame failed to decode) and discard instead of committing.
  const noise = makeNoise(99);
  for (let s = 0; s < 50; s++) {
    const symbols = [s % 4, (s * 3) % 4, (s * 7) % 4, (s * 5) % 4];
    mod.setSymbols(symbols);
    const audio = mod.generateSymbol();
    for (let i = 0; i < audio.length; i++) audio[i] += 0.5 * noise();
    demod.demodulate(audio);
  }
  demod.discardMER();

  const after = demod.getMER();
  expect(after).not.toBeNull();
  expect(after!.merDb).toBeCloseTo(committed!.merDb, 6);
  expect(after!.symbols).toBe(committed!.symbols);
});

test('per-tone MER differentiates a tone with injected narrowband noise', () => {
  const { mod, demod } = makeTrainedPair();
  const noise = makeNoise(123);
  const NOISY_TONE = 1;
  const noisyFreq = TONE_FREQS[NOISY_TONE];
  // Narrowband noise at exactly the target tone's frequency: since tones are
  // orthogonal over the FFT window, a sinusoid at this frequency (random
  // amplitude/phase per symbol) lands almost entirely in that tone's Goertzel
  // bin and leaves the others clean.
  for (let s = 0; s < 50; s++) {
    const symbols = [s % 4, (s * 3) % 4, (s * 7) % 4, (s * 5) % 4];
    mod.setSymbols(symbols);
    const audio = mod.generateSymbol();
    const amp = 0.3 * noise();
    const phase = Math.PI * noise();
    for (let i = 0; i < audio.length; i++) {
      audio[i] += amp * Math.sin((2 * Math.PI * noisyFreq * i) / SAMPLE_RATE + phase);
    }
    demod.demodulate(audio);
  }
  demod.commitMER();
  const perTone = demod.getPerToneMER();
  expect(perTone.length).toBe(TONE_COUNT);
  const cleanTones = perTone.filter((_v, t) => t !== NOISY_TONE);
  const bestClean = Math.max(...cleanTones);
  expect(perTone[NOISY_TONE]).toBeLessThan(bestClean);
});

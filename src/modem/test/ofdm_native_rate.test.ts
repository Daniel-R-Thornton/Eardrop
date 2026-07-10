import { expect, test } from 'vitest';
import {
  OFDM_SYMBOL_MS,
  OFDM_CP_MS,
  ofdmSamples,
  ofdmToneFrequencies,
  OFDM_DEFAULTS,
} from '../types';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { toneIQ } from '../pilot';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { encodeFrame } from '../protocol/atomicFrame';

test('ofdmSamples derives integer windows at both common hardware rates', () => {
  expect(ofdmSamples(48000)).toEqual({ fftSamples: 1920, cpSamples: 240, symSamples: 2160 });
  expect(ofdmSamples(44100)).toEqual({ fftSamples: 1764, cpSamples: 221, symSamples: 1985 });
});

test('tone frequencies are absolute, on the symbol-duration grid', () => {
  const freqs = ofdmToneFrequencies({ toneCount: 16 });
  expect(freqs.length).toBe(16);
  expect(freqs[0]).toBe(2000);
  expect(freqs[15]).toBe(2750);
  const grid = 1000 / OFDM_SYMBOL_MS; // 25 Hz
  for (const f of freqs) expect(f % grid).toBe(0);
});

test('defaults: pilot below tone band, on grid', () => {
  expect(OFDM_DEFAULTS.pilotFreqHz).toBe(1900);
  expect(OFDM_DEFAULTS.pilotFreqHz % (1000 / OFDM_SYMBOL_MS)).toBe(0);
  expect(OFDM_DEFAULTS.pilotAmplitude).toBe(2.0);
  expect(OFDM_CP_MS).toBe(5);
});

// ── Task 2: Modulator tests ──

function makeMod(sampleRate: number, toneCount = 16) {
  return new OFDMQPSKModulator({
    sampleRate,
    toneFrequencies: ofdmToneFrequencies({ toneCount }),
    pilotFreqHz: OFDM_DEFAULTS.pilotFreqHz,
    pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
  });
}

for (const rate of [48000, 44100]) {
  test(`synthesis @${rate}: correct length, QPSK phases recoverable per tone`, () => {
    const mod = makeMod(rate);
    const { fftSamples, cpSamples, symSamples } = ofdmSamples(rate);
    const sent = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
    mod.setSymbols(sent);
    const audio = mod.generateSymbol();
    expect(audio.length).toBe(symSamples);

    // Demodulate directly with toneIQ over the CP-stripped window
    const win = [...audio.slice(cpSamples, cpSamples + fftSamples)];
    const freqs = ofdmToneFrequencies({ toneCount: 16 });
    sent.forEach((sym, t) => {
      const { i, q } = toneIQ(win, freqs[t], rate);
      let phase = Math.atan2(q, i);
      if (phase < 0) phase += 2 * Math.PI;
      const got = Math.round(phase / (Math.PI / 2)) % 4;
      expect(got, `tone ${t}`).toBe(sym);
    });
  });
}

test('cross-tone leakage below -30 dB (orthogonality on the 25 Hz grid)', () => {
  const mod = makeMod(48000, 4); // tones 2000..2150
  mod.setSymbols([0, 0, 0, 0]);
  const { fftSamples, cpSamples } = ofdmSamples(48000);
  const audio = mod.generateSymbol();
  const win = [...audio.slice(cpSamples, cpSamples + fftSamples)];
  const on = toneIQ(win, 2000, 48000);
  const off = toneIQ(win, 2025, 48000); // grid neighbour, not transmitted
  const ratio = Math.hypot(off.i, off.q) / Math.hypot(on.i, on.q);
  expect(ratio).toBeLessThan(0.03);
});

// ── Task 3: Demodulator roundtrip tests ──

for (const rate of [48000, 44100]) {
  test(`mod→demod roundtrip with sync training @${rate}`, () => {
    const freqs = ofdmToneFrequencies({ toneCount: 16 });
    const mod = makeMod(rate);
    const demod = new OFDMQPSKDemodulator({
      sampleRate: rate,
      toneFrequencies: freqs,
      pilotFreqHz: OFDM_DEFAULTS.pilotFreqHz,
    });
    const { symSamples } = ofdmSamples(rate);

    // 12 sync symbols (all zeros) to train
    mod.setSymbols(new Array(16).fill(0));
    for (let s = 0; s < 12; s++) demod.trainOnSyncSymbol(mod.generateSymbol());
    expect(demod.isTraining()).toBe(false);

    const sent = Array.from({ length: 16 }, (_unused, t) => (t * 3) % 4);
    mod.setSymbols(sent);
    const audio = mod.generateSymbol();
    expect(audio.length).toBe(symSamples);
    const result = demod.demodulate(audio);
    const got = [];
    for (let t = 0; t < 16; t++) got.push((result.bits[t * 2] << 1) | result.bits[t * 2 + 1]);
    expect(got).toEqual(sent);
  });
}

// ── Task 4: OFDMEngine rate-aware test ──

test('engine @48k/16 tones: 2 bytes per symbol, sync burst sized in time', () => {
  const engine = new OFDMEngine({ sampleRate: 48000, toneCount: 16 });
  const { symSamples } = ofdmSamples(48000);
  const frame = encodeFrame({ type: 0x01, seqNum: 0, totalFrames: 1, crc: 0 }, new Uint8Array(40));
  const audio = engine.modulateFrame(frame); // 79 bytes / 4 blocks = 20 symbols
  expect(audio.length).toBe(Math.ceil(79 / 4) * symSamples);
  expect(engine.generateSyncBurst(24).length).toBe(24 * symSamples);
});

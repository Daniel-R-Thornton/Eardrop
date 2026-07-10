import { expect, test } from 'vitest';
import { OFDMQPSKModulator } from '../modem/modulation/OFDMQPSKModulator';
import { ofdmSamples } from '../modem/types';

const SAMPLE_RATE = 3200;
const { symSamples } = ofdmSamples(SAMPLE_RATE);

test('OFDMQPSKModulator generates correct length', () => {
  const mod = new OFDMQPSKModulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: new Float32Array([700, 800, 900, 1000]),
    pilotFreqHz: 600,
    pilotAmplitude: 0.4,
  });
  mod.setSymbols([0, 1, 2, 3]);
  const symbol = mod.generateSymbol();
  // Length = fftSamples + cpSamples
  expect(symbol.length).toBe(symSamples);
  // Output should not be all zeros
  let sumSq = 0;
  for (let i = 0; i < symbol.length; i++) sumSq += symbol[i] * symbol[i];
  expect(sumSq).toBeGreaterThan(0);
});

test('OFDMQPSKModulator accepts custom tone frequencies', () => {
  const mod = new OFDMQPSKModulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: new Float32Array([2000, 2050, 2100, 2150]),
    pilotFreqHz: 1900,
    pilotAmplitude: 0.4,
  });
  mod.setSymbols([0, 0, 0, 0]);
  const symbol = mod.generateSymbol();
  expect(symbol.length).toBe(symSamples);
});

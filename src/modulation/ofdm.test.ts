import { expect, test } from 'vitest';
import { OFDMQPSKModulator } from '../modem/modulation/OFDMQPSKModulator';

test('OFDMQPSKModulator generates correct length', () => {
  const cfg = {
    sampleRate: 3200,
    toneCount: 4,
    ifftSize: 256,
    amplitude: 0.5,
    pilotFreqHz: 600,
    pilotAmplitude: 0.4,
    toneFrequencies: new Float32Array([700, 800, 900, 1000]),
    cpLength: 0,
  };
  const mod = new OFDMQPSKModulator(cfg);
  // set 4 symbols (0‑3) arbitrarily
  mod.setSymbols([0, 1, 2, 3]);
  const symbol = mod.generateSymbol();
  // Expected length = ifftSize + cpLength (0)
  expect(symbol.length).toBe(cfg.ifftSize);
  // Output should not be all zeros
  let sumSq = 0;
  for (let i = 0; i < symbol.length; i++) sumSq += symbol[i] * symbol[i];
  expect(sumSq).toBeGreaterThan(0);
});

test('OFDMQPSKModulator validates power of two ifftSize', () => {
  expect(
    () =>
      new OFDMQPSKModulator({
        sampleRate: 3200,
        toneCount: 4,
        ifftSize: 100, // not power of two
        amplitude: 0.5,
        pilotFreqHz: 600,
        pilotAmplitude: 0.4,
        toneFrequencies: new Float32Array([700, 800, 900, 1000]),
        cpLength: 0,
      }),
  ).toThrow('power of two');
});

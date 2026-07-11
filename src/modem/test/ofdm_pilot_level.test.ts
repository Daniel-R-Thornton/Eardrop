/**
 * The pilot must stay well above the per-tone level after peak
 * normalization, at every tone count — the receiver's drift correction is
 * pilot-referenced and dies quietly when the pilot is buried.
 */
import { expect, test } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { toneIQ } from '../pilot';
import { ofdmSamples, ofdmToneFrequencies } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;

for (const toneCount of [8, 16, 32]) {
  test(`OFDM pilot ≥ 1.5× mean tone amplitude at ${toneCount} tones`, () => {
    const tx = new TxEngine({
      sampleRate: SAMPLE_RATE,
      pilotFreqHz: PILOT_FREQ,
      toneCount,
      useOFDM: true,
    } as ConstructorParameters<typeof TxEngine>[0]);

    // Sync burst = all tones at 0° — analyze one full FFT window past the CP
    const burst = (tx as unknown as {
      ofdmEngine: { generateSyncBurst(n: number): Float32Array };
    }).ofdmEngine.generateSyncBurst(2);
    const { fftSamples, cpSamples } = ofdmSamples(SAMPLE_RATE);
    const win = Array.from(burst.slice(cpSamples, cpSamples + fftSamples));

    const pilot = toneIQ(win, PILOT_FREQ, SAMPLE_RATE);
    const pilotAmp = Math.hypot(pilot.i, pilot.q);

    const freqs = ofdmToneFrequencies({ toneCount });
    let toneSum = 0;
    for (const f of freqs) {
      const iq = toneIQ(win, f, SAMPLE_RATE);
      toneSum += Math.hypot(iq.i, iq.q);
    }
    const meanTone = toneSum / toneCount;

    expect(pilotAmp).toBeGreaterThan(1.5 * meanTone);
  });
}

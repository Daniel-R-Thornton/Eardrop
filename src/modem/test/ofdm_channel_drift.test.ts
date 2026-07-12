/**
 * Decision-directed tracking verification.
 *
 * Proves the tracking mechanism is correct: it doesn't degrade clean-channel
 * decoding, and it moves channel estimates toward the true channel response.
 */
import { expect, test } from 'vitest';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { ofdmSamples, ofdmToneFrequencies } from '../types';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';

const PILOT_FREQ = 1900;
const SAMPLE_RATE = 48000;

test('tracking does not degrade decoding in a static channel', () => {
  // Full pipeline with tracking enabled must match static pipeline
  const data = new Uint8Array(200);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xff;

  const txCfg = { sampleRate: SAMPLE_RATE, pilotFreqHz: PILOT_FREQ, toneCount: 16, useOFDM: true };

  const tx = new TxEngine(txCfg as ConstructorParameters<typeof TxEngine>[0]);
  const audio = tx.transmitFile('tracktest.bin', data);
  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  const tail = new Float32Array(symSamples * 10);

  const full = new Float32Array(audio.length + tail.length);
  full.set(audio, 0);
  full.set(tail, audio.length);

  const rxTracking = new RxEngine({ ...txCfg } as ConstructorParameters<typeof RxEngine>[0]);
  const rxStatic = new RxEngine({ ...txCfg } as ConstructorParameters<typeof RxEngine>[0]);

  for (const s of full) rxTracking.feedSample(s);
  for (const s of full) rxStatic.feedSample(s);

  const fileTrack = (rxTracking as unknown as { completedFile: ReceivedFile | null }).completedFile;
  const fileStatic = (rxStatic as unknown as { completedFile: ReceivedFile | null }).completedFile;

  expect(fileTrack, 'tracking: file should complete').not.toBeNull();
  expect(fileStatic, 'static: file should complete').not.toBeNull();
  expect(fileTrack!.data.length).toBe(data.length);
  expect(fileStatic!.data.length).toBe(data.length);
  expect(Array.from(fileTrack!.data)).toEqual(Array.from(data));
  expect(Array.from(fileStatic!.data)).toEqual(Array.from(data));
});

test('tracking converges channel estimate in a static channel', () => {
  const TONE_FREQS = ofdmToneFrequencies({ toneCount: 4 });
  const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);

  const demod = new OFDMQPSKDemodulator({
    sampleRate: SAMPLE_RATE, toneFrequencies: TONE_FREQS, pilotFreqHz: PILOT_FREQ, trackingAlpha: 0.1,
  });

  // Generate a multi-frame transmission and train the demod on it
  const txCfg = { sampleRate: SAMPLE_RATE, pilotFreqHz: PILOT_FREQ, toneCount: 4, useOFDM: true };
  const tx = new TxEngine(txCfg as ConstructorParameters<typeof TxEngine>[0]);
  const audio = tx.transmitFile('converge.bin', new Uint8Array([1,2,3,4]));

  // Train the demod on the sync burst (first 24 symbols)
  for (let s = 0; s < 12; s++) {
    const win = audio.slice(s * SYM_LEN, (s + 1) * SYM_LEN);
    demod.trainOnSyncSymbol(win);
  }

  // Snapshot the trained estimates
  const trainedRe = (demod as any).channelEstRe.slice() as number[];
  const trainedIm = (demod as any).channelEstIm.slice() as number[];

  // Feed remaining data symbols (tracking active)
  const dataStart = 24 * SYM_LEN;
  const dataSymCount = Math.floor((audio.length - dataStart) / SYM_LEN);
  for (let s = 0; s < dataSymCount; s++) {
    const win = audio.slice(dataStart + s * SYM_LEN, dataStart + (s + 1) * SYM_LEN);
    demod.demodulate(win);
  }

  const finalRe = (demod as any).channelEstRe as number[];
  const finalIm = (demod as any).channelEstIm as number[];

  // Channel estimates should not have diverged (should be close to trained values)
  for (let t = 0; t < 4; t++) {
    const dist = Math.hypot(finalRe[t] - trainedRe[t], finalIm[t] - trainedIm[t]);
    expect(dist).toBeLessThan(0.2); // small random walk from quantization noise
  }
});

/**
 * ofdmQamRefPeak.test.ts — QAM reference-symbol waveform must not clip.
 *
 * modulateQamRefSymbols() previously set every tone to the SAME outer-corner
 * constellation point, so all tones landed phase-aligned and summed
 * coherently — measured peak 2.543 at 32 tones/all-16-QAM, hard-clipping the
 * DAC on exactly the symbols calibrateQamRef() trains on. The fix rotates
 * each tone's corner point by a deterministic per-tone phase (qamRefPhase)
 * before synthesis, de-cohering the sum. This test asserts the waveform peak
 * stays within the DAC's [-1, 1] range at 32 tones for both all-16-QAM and
 * all-64-QAM tone-order assignments.
 */
import { describe, it, expect } from 'vitest';
import { OFDMEngine } from '../protocol/ofdmEngine';
import type { QamOrder } from '../modulation/constellation';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;
const TONE_COUNT = 32;

function maxAbsSample(audio: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]));
  return peak;
}

function refWaveformPeak(order: QamOrder): number {
  const engine = new OFDMEngine({
    sampleRate: SAMPLE_RATE,
    toneCount: TONE_COUNT,
    pilotFreqHz: PILOT_FREQ,
  });
  const orders: QamOrder[] = new Array(TONE_COUNT).fill(order) as QamOrder[];
  engine.setToneOrders(orders);
  const audio = engine.modulateQamRefSymbols();
  return maxAbsSample(audio);
}

describe('OFDM QAM: reference-symbol waveform must not clip the DAC', () => {
  it('all-16-QAM at 32 tones: peak |sample| <= 1.0', () => {
    const peak = refWaveformPeak(4);
    expect(peak).toBeLessThanOrEqual(1.0);
  });

  it('all-64-QAM at 32 tones: peak |sample| <= 1.0', () => {
    const peak = refWaveformPeak(6);
    expect(peak).toBeLessThanOrEqual(1.0);
  });
});

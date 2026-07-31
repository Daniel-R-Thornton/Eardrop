/**
 * chirpLevelMatch.test.ts — the sync chirp must not be louder than the OFDM
 * symbols it precedes.
 *
 * Why this is worth a test rather than a constant: a chirp hotter than the data
 * compresses the transmitting chain for the full 600 ms burst, and the channel
 * training window sits in the 240 ms immediately after it. Measured on a real
 * acoustic run with a fixed 0.6 chirp against ~0.18-peak data, the received
 * pilot was 3.38x (10.6 dB) stronger during data than during training — the
 * same ratio as the level mismatch — and the pilot gain correction then drifted
 * monotonically to its clamp for the rest of the transmission. QPSK tolerates
 * that (phase-only decisions); 16-QAM does not.
 *
 * The correct level depends on toneCount, because the worst-case-peak qamScale
 * makes a 32-tone symbol far quieter per tone than an 8-tone one. So the match
 * is asserted across tone counts, not against a magic number.
 */
import { describe, it, expect } from 'vitest';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { OFDM_TUNING, OFDM_DEFAULTS, ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;

function rms(a: Float32Array): number {
  let sumSq = 0;
  for (let i = 0; i < a.length; i++) sumSq += a[i] * a[i];
  return Math.sqrt(sumSq / a.length);
}

function peak(a: Float32Array): number {
  let p = 0;
  for (let i = 0; i < a.length; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
}

function engineFor(toneCount: number): OFDMEngine {
  return new OFDMEngine({
    sampleRate: SAMPLE_RATE,
    toneCount,
    pilotFreqHz: 1850,
    toneStartHz: OFDM_DEFAULTS.toneStartHz,
  });
}

describe('chirp level matching', () => {
  for (const toneCount of [8, 16, 32]) {
    it(`${toneCount} tones: chirp level does not fall as tones are added`, () => {
      const engine = engineFor(toneCount);
      const { chirp } = engine.generateChirpBurst(OFDM_TUNING.syncBurstSymbols);
      // The regression this guards: RMS-matching tied the chirp to the OFDM RMS
      // (qamScale * sqrt(N) with qamScale ~ 1/N), so the chirp got quieter with
      // every tone added — 0.121 at 32 tones, 0.108 at 40 — and sync stopped
      // locking at 40. The chirp level must be INDEPENDENT of tone count:
      // OFDM_TUNING.chirpAmplitude is a fixed ceiling and the coherent peak it
      // is min'd with sits above it at every tone count, so the ceiling binds.
      //
      // The ceiling itself is a MEASUREMENT, not "as loud as fits": a 0.6 chirp
      // detected WORSE on the bench than 0.12 (2026-07-31, 32 tones — norm
      // 0.476-0.581 with the correlation peak pinned at the probe-window edge,
      // vs norm 0.686-0.703 and clean handoffs at 0.12). The detection score is
      // normalized by input RMS, so a hotter chirp buys nothing once the chain
      // starts compressing on it.
      expect(peak(chirp)).toBeCloseTo(OFDM_TUNING.chirpAmplitude, 2);
    });

    it(`${toneCount} tones: chirp stays inside the coherent peak budget`, () => {
      const engine = engineFor(toneCount);
      const { chirp } = engine.generateChirpBurst(OFDM_TUNING.syncBurstSymbols);
      // The chirp is DELIBERATELY louder than the de-cohered training burst it
      // precedes (measured 0.55 against 0.18 at 40 tones). That invariant was
      // "chirp never louder than the waveform behind it", and de-cohering the
      // burst dropped that waveform's peak ~11 dB — following it down took the
      // chirp with it and 40-tone sync stopped locking (norm 0.36 against a
      // 0.35 threshold).
      //
      // The real safety property is that the chirp cannot exceed the peak the
      // TX scale is budgeted for, which is the COHERENT sum. That is what it is
      // now sized from, so it cannot clip, and the settle period
      // (OFDM_TUNING.trainingSettleSymbols) is what absorbs the compression it
      // leaves behind — that being the reason the settle period exists.
      const coherent = engine.generateSyncBurst(1);
      // generateSyncBurst is de-cohered now, so compare against the budget
      // directly: 0.95 is the modulator's target peak.
      expect(peak(chirp)).toBeLessThanOrEqual(0.95);
      expect(peak(coherent)).toBeLessThanOrEqual(0.95);
    });

    it(`${toneCount} tones: training burst is de-cohered, not a coherent pulse`, () => {
      const engine = engineFor(toneCount);
      const training = engine.generateTrainingSymbols(OFDM_TUNING.trainingSymbols);
      // A phase-aligned burst's crest factor grows as sqrt(toneCount) — measured
      // 6.70 at 32 tones and 7.26 at 40, roughly 10 dB above the payload's ~2.6,
      // and that peak is what compressed the chain during the training window.
      // The received preamble-to-data level step reached 12 dB because of it.
      // De-cohered phases must hold the crest near the payload's at EVERY tone
      // count, since the failure scaled with tone count.
      const crest = peak(training) / rms(training);
      expect(crest).toBeLessThan(3.5);
    });
  }

  it('never exceeds the OFDM_TUNING.chirpAmplitude ceiling', () => {
    const engine = engineFor(8);
    const { chirp } = engine.generateChirpBurst(OFDM_TUNING.syncBurstSymbols);
    expect(peak(chirp)).toBeLessThanOrEqual(OFDM_TUNING.chirpAmplitude + 1e-6);
  });
});

/**
 * The TX preamble length must equal exactly what the RX consumes.
 *
 * The receiver finds the preamble/data boundary by counting windows and nothing
 * else, so any mismatch is silent and total. A 4-symbol "slack" term was added
 * to absorb boundary-alignment loss and instead left 4 training symbols in the
 * data stream: the first data symbol came out ~0 degrees on EVERY tone (a
 * training symbol equalized by an estimate trained on training symbols) and no
 * frame ever decoded, while sync, training and the profile frame all looked
 * perfect.
 */
describe('preamble length agreement', () => {
  it('TX emits exactly settle + training symbols after the chirp', () => {
    const { symSamples } = ofdmSamples(SAMPLE_RATE);
    const engine = engineFor(32);
    const expected = OFDM_TUNING.trainingSettleSymbols + OFDM_TUNING.trainingSymbols;
    const training = engine.generateTrainingSymbols(expected);
    expect(training.length).toBe(expected * symSamples);
  });
});

/**
 * The settle period must load the chain WITHOUT looking stationary.
 *
 * A stationary settle period is actively harmful: 400 ms of repeated identical
 * sync symbols before training produced random per-tone channel estimates over
 * the air (phases scattered rather than smooth) and nothing decoded, while
 * 200 ms did not. The mic reports channelCount 2 — an array whose adaptive DSP
 * `noiseSuppression: false` does not fully disable — and the envelope probe
 * measured it attenuating a sustained tone by 14 dB with a ~350 ms adaptation.
 * Varying data gives it nothing to lock onto.
 */
describe('settle period', () => {
  it('varies from symbol to symbol', () => {
    const { symSamples } = ofdmSamples(SAMPLE_RATE);
    const engine = engineFor(32);
    const settle = engine.generateSettleSymbols(8);
    expect(settle.length).toBe(8 * symSamples);

    // Compare consecutive symbols. Identical symbols would be a stationary
    // burst, which is the thing this must not be.
    let identicalPairs = 0;
    for (let k = 1; k < 8; k++) {
      const a = settle.subarray((k - 1) * symSamples, k * symSamples);
      const b = settle.subarray(k * symSamples, (k + 1) * symSamples);
      let same = true;
      for (let i = 0; i < a.length; i += 37) {
        if (Math.abs(a[i] - b[i]) > 1e-9) { same = false; break; }
      }
      if (same) identicalPairs++;
    }
    expect(identicalPairs).toBe(0);
  });

  it('matches the training symbols in level, so the chain stays loaded', () => {
    // The point of filling the settle period with signal rather than silence is
    // to hold the output stage in the same gain state the data will see.
    const engine = engineFor(32);
    const settle = engine.generateSettleSymbols(8);
    const training = engine.generateTrainingSymbols(OFDM_TUNING.trainingSymbols);
    const ratioDb = 20 * Math.log10(rms(settle) / rms(training));
    expect(Math.abs(ratioDb)).toBeLessThan(1.5);
  });

  it('does not clip', () => {
    for (const toneCount of [8, 16, 32, 40, 48]) {
      const engine = engineFor(toneCount);
      expect(peak(engine.generateSettleSymbols(8))).toBeLessThanOrEqual(1.0);
    }
  });
});

/**
 * The chirp must keep its own band, independent of where the pilot sits.
 *
 * Two independent constraints pull the pilot and the chirp in opposite
 * directions, and tying them together satisfies neither:
 *
 *  - The pilot wants to be CLOSE to the data band. Drift correction measures
 *    phase on the pilot and extrapolates by toneFreq/pilotFreq, so a pilot at
 *    1850 with tones at 8850 amplifies a two-sample timing error into ~148
 *    degrees. Moving the pilot to 6300 cut measured drift from -291 to -11.
 *
 *  - The chirp wants to be FAR from the data band. It is the loudest part of the
 *    transmission and the chain compresses per band, so a chirp beside the data
 *    band compresses that band and then releases across the frame — measured as
 *    the received pilot going 0.367 (training) to 2.67 (data), a 17 dB swing,
 *    with nothing decoding.
 */
describe('chirp band independence', () => {
  it('stays on OFDM_TUNING.chirpCenterHz regardless of the pilot', () => {
    const { symSamples } = ofdmSamples(SAMPLE_RATE);
    const dominantFreq = (audio: Float32Array): number => {
      // Coarse peak-pick over a window in the chirp's interior: the sweep spans
      // chirpSpanHz, so the dominant component sits near the centre frequency.
      const start = Math.floor(audio.length / 2);
      const len = symSamples;
      let bestF = 0;
      let bestMag = 0;
      for (let f = 500; f <= 9000; f += 25) {
        let re = 0;
        let im = 0;
        for (let n = 0; n < len; n++) {
          const ang = (2 * Math.PI * f * n) / SAMPLE_RATE;
          re += audio[start + n] * Math.cos(ang);
          im -= audio[start + n] * Math.sin(ang);
        }
        const mag = Math.hypot(re, im);
        if (mag > bestMag) {
          bestMag = mag;
          bestF = f;
        }
      }
      return bestF;
    };

    for (const pilotFreqHz of [1850, 6300]) {
      const engine = new OFDMEngine({
        sampleRate: SAMPLE_RATE,
        toneCount: 40,
        pilotFreqHz,
        toneStartHz: 600,
      });
      const { chirp } = engine.generateChirpBurst(OFDM_TUNING.chirpSymbols);
      // Within half a span of the configured centre, for BOTH pilots.
      expect(Math.abs(dominantFreq(chirp) - OFDM_TUNING.chirpCenterHz)).toBeLessThan(150);
    }
  });

  it('keeps the chirp clear of the data band at the pilot that needs it', () => {
    // The pilot at 6300 puts tones at 6900+. The chirp must not land in there.
    const engine = new OFDMEngine({
      sampleRate: SAMPLE_RATE,
      toneCount: 40,
      pilotFreqHz: 6300,
      toneStartHz: 600,
    });
    const { chirpCfg } = engine.generateChirpBurst(OFDM_TUNING.chirpSymbols);
    expect(chirpCfg.fEnd).toBeLessThan(6900);
  });
});

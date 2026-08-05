/**
 * handshakeGains — per-tone pre-emphasis for the fixed handshake band, from
 * the curve a peer reported hearing of our probe.
 */
import { describe, expect, it } from 'vitest';
import { handshakeToneGains, handshakeToneMags, handshakeToneHz } from '../chatter/handshakeGains';
import { REPORT_GRID, reportGridFreqs } from '../protocol/probeBurst';
import { OFDM_HANDSHAKE, OFDM_DEFAULTS } from '../types';

const flat = () => Array.from({ length: REPORT_GRID.points }, () => 1);

describe('handshakeToneGains', () => {
  it('leaves a flat channel alone', () => {
    const gains = handshakeToneGains(flat())!;
    expect(gains).toHaveLength(OFDM_HANDSHAKE.toneCount);
    gains.forEach((g) => expect(g).toBeCloseTo(1, 5));
  });

  it('attenuates strong tones toward the weak ones, never boosting past unity', () => {
    // Response falling across the handshake band: the low tones are strong,
    // the high ones weak. Correction must pull the strong ones DOWN — boosting
    // the weak ones above unity would clip the output stage, and a clipped
    // burst decodes worse than a quiet one.
    const freqs = reportGridFreqs();
    const first = OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz;
    const grid = freqs.map((f) => (f < first ? 1 : Math.max(0.05, 1 - (f - first) / 400)));

    const gains = handshakeToneGains(grid)!;
    expect(Math.max(...gains)).toBeLessThanOrEqual(1);
    // Tone 0 sits where the response is strongest, so it takes the attenuation.
    expect(gains[0]).toBeLessThan(gains[gains.length - 1]);
  });

  it('does not chase a deep notch all the way down', () => {
    // One dead tone must not drag every other tone to silence with it.
    const freqs = reportGridFreqs();
    const notchHz = OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz
      + 2 * OFDM_DEFAULTS.toneSpacingHz;
    const grid = freqs.map((f) => (Math.abs(f - notchHz) < 60 ? 1e-4 : 1));
    const gains = handshakeToneGains(grid)!;
    expect(Math.min(...gains)).toBeGreaterThanOrEqual(0.25);
  });

  it('returns undefined when there is nothing to go on', () => {
    expect(handshakeToneGains(undefined)).toBeUndefined();
    expect(handshakeToneGains([1, 2, 3])).toBeUndefined();          // wrong shape
    expect(handshakeToneGains(flat().map(() => 0))).toBeUndefined(); // silence
  });

  it('never emits a non-finite gain', () => {
    const grid = flat().map((_v, i) => (i % 3 === 0 ? 0 : 1));
    const gains = handshakeToneGains(grid)!;
    gains.forEach((g) => expect(Number.isFinite(g)).toBe(true));
  });
});

describe('handshakeToneMags', () => {
  // The band MEAN cannot answer "is one control tone in a null", and that is
  // the case that breaks a 12-chunk REPORT while leaving a 1-chunk ACK alone.
  it('reports one value per control tone', () => {
    expect(handshakeToneMags(flat())).toHaveLength(OFDM_HANDSHAKE.toneCount);
    expect(handshakeToneMags(undefined)).toBeUndefined();
    expect(handshakeToneMags([1, 2, 3])).toBeUndefined();
  });

  it('exposes a single-tone null that the band mean hides', () => {
    const freqs = reportGridFreqs();
    const notchHz = handshakeToneHz(5);
    const grid = freqs.map((f) => (Math.abs(f - notchHz) < 60 ? 1e-3 : 1));

    const mags = handshakeToneMags(grid)!;
    const worst = Math.min(...mags);
    const best = Math.max(...mags);
    const mean = mags.reduce((s, m) => s + m, 0) / mags.length;
    const worstDb = 20 * Math.log10(worst / best);
    const meanDb = 20 * Math.log10(mean / best);

    // The null is plainly visible per-tone.
    expect(worstDb).toBeLessThan(-20);
    // The band mean barely registers it — that GAP is the whole point. A
    // reading of a few dB down looks like an ordinary quiet band, while the
    // tone actually carrying two bits of every symbol is 30+ dB below its
    // neighbours.
    expect(meanDb - worstDb).toBeGreaterThan(30);
  });

  it('places the tones on the real 50 Hz grid', () => {
    expect(handshakeToneHz(0)).toBe(OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz);
    expect(handshakeToneHz(OFDM_HANDSHAKE.toneCount - 1))
      .toBe(OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz
        + (OFDM_HANDSHAKE.toneCount - 1) * OFDM_DEFAULTS.toneSpacingHz);
  });
});

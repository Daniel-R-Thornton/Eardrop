import { describe, expect, it } from 'vitest';
import { pickSettings, FLOOR_SETTINGS } from '../chatter/settingsPick';
import { reportGridFreqs } from '../protocol/probeBurst';

const freqs = reportGridFreqs();
const gridWhere = (fn: (hz: number) => number) => freqs.map(fn);

describe('settingsPick', () => {
  it('one strong flat peer → widest band, dense QAM', () => {
    const s = pickSettings([{ deviceId: 1, grid: gridWhere(() => 1) }]);
    expect(s.floor).toBe(false);
    expect(s.toneCount).toBe(32);
    expect(s.qamMap.every((q) => q === 6)).toBe(true);
  });

  it('a deaf-above-4kHz peer forces the band low for everyone', () => {
    const strong = { deviceId: 1, grid: gridWhere(() => 1) };
    const lowOnly = { deviceId: 2, grid: gridWhere((hz) => (hz < 4000 ? 1 : 0.001)) };
    const s = pickSettings([strong, lowOnly]);
    expect(s.floor).toBe(false);
    expect(s.toneStartHz + s.toneCount * 50).toBeLessThanOrEqual(4000 + 100);
  });

  it('disjoint peers → floor settings', () => {
    const lowOnly = { deviceId: 1, grid: gridWhere((hz) => (hz < 2500 ? 1 : 1e-4)) };
    const highOnly = { deviceId: 2, grid: gridWhere((hz) => (hz > 6500 ? 1 : 1e-4)) };
    const s = pickSettings([lowOnly, highOnly]);
    expect(s.floor).toBe(true);
    expect(s).toMatchObject({ toneCount: FLOOR_SETTINGS.toneCount });
  });

  it('gains attenuate strong tones, never exceed 1', () => {
    const tilted = { deviceId: 1, grid: gridWhere((hz) => 1 / (1 + hz / 2000)) };
    const s = pickSettings([tilted]);
    expect(Math.max(...s.toneGains)).toBeCloseTo(1, 5);
    expect(Math.min(...s.toneGains)).toBeGreaterThan(0);
  });

  it('zero reports → floor', () => {
    expect(pickSettings([]).floor).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { pickSettings, FLOOR_SETTINGS, MAX_PILOT_RATIO } from '../chatter/settingsPick';
import { reportGridFreqs, REPORT_GRID } from '../protocol/probeBurst';
import { MIN_TONE_START_HZ, ofdmToneFrequencies } from '../types';
import type { PickedSettings } from '../chatter/settingsPick';

const freqs = reportGridFreqs();
const gridWhere = (fn: (hz: number) => number) => freqs.map(fn);

describe('settingsPick', () => {
  it('one strong flat peer → widest band, still QPSK', () => {
    const s = pickSettings([{ deviceId: 1, grid: gridWhere(() => 1) }]);
    expect(s.floor).toBe(false);
    expect(s.toneCount).toBe(32);
    // A perfectly flat grid must NOT buy dense QAM. The grid is peak-relative,
    // so it measures flatness, not signal-to-noise — and this exact input (a
    // room measuring -0.7 dB across the band) previously earned 64-QAM, after
    // which a receiver locked on at 0.985 and decoded nothing at all.
    expect(s.qamMap.every((q) => q === 2)).toBe(true);
  });

  it('a deaf-above-4kHz peer forces the band low for everyone', () => {
    const strong = { deviceId: 1, grid: gridWhere(() => 1) };
    const lowOnly = { deviceId: 2, grid: gridWhere((hz) => (hz < 4000 ? 1 : 0.001)) };
    const s = pickSettings([strong, lowOnly]);
    expect(s.floor).toBe(false);
    // toneStartHz is an OFFSET above the pilot (not absolute) — same
    // semantics as ofdmToneFrequencies()/BandCard — so the first tone's
    // absolute frequency is pilotFreqHz + toneStartHz.
    expect(s.pilotFreqHz + s.toneStartHz + s.toneCount * 50).toBeLessThanOrEqual(4000 + 100);
  });

  it('toneStartHz is an offset (>= 50) and both frequencies are band-card-expressible (multiples of 50)', () => {
    const s = pickSettings([{ deviceId: 1, grid: gridWhere(() => 1) }]);
    expect(s.toneStartHz).toBeGreaterThanOrEqual(50);
    expect(s.pilotFreqHz % 50).toBe(0);
    expect(s.toneStartHz % 50).toBe(0);
  });

  /**
   * The allocation invariants, asserted against what actually goes on the
   * air rather than what the picker returns.
   *
   * These exist because of a real transfer that failed with every earlier
   * assertion in this file passing. The picker emitted toneStartHz 200; the
   * modem's global floor (MIN_TONE_START_HZ = 600, applied by
   * ofdmToneFrequencies to TX and RX alike) silently raised it, so a window
   * scored at 1500-3050 Hz was transmitted at 1900-3450 Hz with the pilot at
   * 1300 — below the measured grid entirely, and 2.65x below its own top
   * tone. The receiver hopped, locked on the chirp at handoff score 0.904,
   * and decoded not one frame in 601 windows.
   *
   * A window is only admissible if the WHOLE allocation fits: pilot at the
   * modem's floor spacing, every tone inside the measured grid, and a pilot
   * close enough below the top tone to serve as its phase reference.
   */
  const allocations = (): Array<[string, PickedSettings]> => [
    ['flat', pickSettings([{ deviceId: 1, grid: gridWhere(() => 1) }])],
    ['bottom-heavy', pickSettings([{ deviceId: 1, grid: gridWhere((hz) => 1 / (1 + (hz - 1500) / 500)) }])],
    ['deaf above 4k', pickSettings([{ deviceId: 1, grid: gridWhere((hz) => (hz < 4000 ? 1 : 0.001)) }])],
    ['top-heavy', pickSettings([{ deviceId: 1, grid: gridWhere((hz) => (hz > 6000 ? 1 : 0.01)) }])],
    ['floor', FLOOR_SETTINGS],
  ];

  it('emits a tone offset the modem will not clamp, so the band it scores is the band it sends', () => {
    for (const [name, s] of allocations()) {
      // Anything below MIN_TONE_START_HZ is raised by ofdmToneFrequencies,
      // moving every tone without moving the pilot.
      expect(`${name}: ${s.toneStartHz}`).toBe(`${name}: ${MIN_TONE_START_HZ}`);
      const sent = ofdmToneFrequencies({
        toneCount: s.toneCount, pilotFreqHz: s.pilotFreqHz, startHz: s.toneStartHz,
      });
      expect(`${name}: ${sent[0]}`).toBe(`${name}: ${s.pilotFreqHz + s.toneStartHz}`);
    }
  });

  it('places the pilot inside the measured grid — it is never scored otherwise', () => {
    for (const [name, s] of allocations()) {
      expect(`${name}: ${s.pilotFreqHz >= REPORT_GRID.startHz}`).toBe(`${name}: true`);
    }
  });

  it('keeps the pilot close enough below the top tone to demodulate it', () => {
    for (const [name, s] of allocations()) {
      const top = s.pilotFreqHz + s.toneStartHz + (s.toneCount - 1) * 50;
      const ratio = top / s.pilotFreqHz;
      expect(`${name}: ${ratio <= MAX_PILOT_RATIO} (${ratio.toFixed(2)})`)
        .toBe(`${name}: true (${ratio.toFixed(2)})`);
    }
  });

  it('drops to a narrower band rather than emit an undemodulable low-frequency one', () => {
    // 32 tones (1550 Hz wide) low in the band cannot satisfy the ratio with
    // the pilot 600 Hz under the first tone — the fallback down the toneCount
    // ladder is what makes the constraint survivable instead of fatal.
    const s = pickSettings([{ deviceId: 1, grid: gridWhere((hz) => (hz < 3200 ? 1 : 1e-4)) }]);
    expect(s.floor).toBe(false);
    expect(s.toneCount).toBeLessThan(32);
    const top = s.pilotFreqHz + s.toneStartHz + (s.toneCount - 1) * 50;
    expect(top / s.pilotFreqHz).toBeLessThanOrEqual(MAX_PILOT_RATIO);
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

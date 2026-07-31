// @vitest-environment jsdom
/**
 * configPresets.test.ts — named "known-good" config snapshots.
 *
 * The bench iterates through many pilot/tone/cal combinations; when one
 * works, the operator needs a one-click way back to it. A preset captures
 * the same configuration fields the store already persists (including the
 * per-device calibration gains) under a user-chosen name, survives reload
 * via localStorage, and loading one applies it through the normal setState
 * path so the modem reconfigures exactly as if the controls were moved by
 * hand.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getState,
  setState,
  saveConfigPreset,
  loadConfigPreset,
  deleteConfigPreset,
} from './Store';

describe('config presets', () => {
  beforeEach(() => {
    // Isolate: drop any presets a previous test saved.
    for (const name of Object.keys(getState().configPresets)) {
      deleteConfigPreset(name);
    }
  });

  it('save -> mutate -> load restores the saved configuration', () => {
    setState({
      pilotFreqHz: 1850,
      toneStartHz: 5050,
      toneCount: 32,
      dataQamBits: 4,
      micGain: 12,
      toneGainsByDevice: { micA: { '1850:5050:32': [1, 2, 3] } },
    });
    saveConfigPreset('good-32');

    setState({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 40, micGain: 6 });
    expect(getState().pilotFreqHz).toBe(6300);

    loadConfigPreset('good-32');
    const s = getState();
    expect(s.pilotFreqHz).toBe(1850);
    expect(s.toneStartHz).toBe(5050);
    expect(s.toneCount).toBe(32);
    expect(s.micGain).toBe(12);
    expect(s.toneGainsByDevice.micA['1850:5050:32']).toEqual([1, 2, 3]);
  });

  it('presets survive in localStorage under the persist key', () => {
    setState({ pilotFreqHz: 1850, toneCount: 32 });
    saveConfigPreset('keeper');

    const raw = localStorage.getItem('eardrop_ui_state');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { configPresets?: Record<string, unknown> };
    expect(parsed.configPresets).toBeDefined();
    expect(Object.keys(parsed.configPresets!)).toContain('keeper');
  });

  it('deleteConfigPreset removes it; loading a missing preset is a no-op', () => {
    setState({ pilotFreqHz: 1850 });
    saveConfigPreset('gone');
    deleteConfigPreset('gone');
    expect(Object.keys(getState().configPresets)).not.toContain('gone');

    setState({ pilotFreqHz: 4444 });
    loadConfigPreset('gone');
    expect(getState().pilotFreqHz).toBe(4444);
  });

  it('a preset is a snapshot, not a live reference', () => {
    setState({ toneGainsByDevice: { micA: { k: [1, 1] } } });
    saveConfigPreset('frozen');
    // Mutating state afterwards must not rewrite the preset's contents.
    setState({ toneGainsByDevice: { micA: { k: [9, 9] } } });
    loadConfigPreset('frozen');
    expect(getState().toneGainsByDevice.micA.k).toEqual([1, 1]);
  });
});

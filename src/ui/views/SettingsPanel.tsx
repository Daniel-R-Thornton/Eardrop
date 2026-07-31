/**
 * SettingsPanel.tsx — real, usable controls wired to the Store.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  useStore, setState, saveConfigPreset, loadConfigPreset, deleteConfigPreset,
} from '../Store';
import { enumerateDevices, type DeviceInfo } from '../../audio';
import { Panel } from '../components/instrument/Panel';
import { Toggle } from '../components/instrument/Toggle';
import { Slider } from '../components/instrument/Slider';
import { Select } from '../components/instrument/Select';
import { Button } from '../components/instrument/Button';

function deviceOptions(list: DeviceInfo[], defaultLabel: string) {
  return [
    { value: '', label: defaultLabel },
    ...list
      .filter((d) => d.id !== 'default' && d.id !== 'communications')
      .map((d) => ({ value: d.id, label: d.label })),
  ];
}

export function SettingsPanel() {
  const s = useStore((x) => x);
  const [inputs, setInputs] = useState<DeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<DeviceInfo[]>([]);
  const [presetName, setPresetName] = useState('');
  const presetNames = Object.keys(s.configPresets);

  const refreshDevices = useCallback(async () => {
    try {
      const { inputs: ins, outputs: outs } = await enumerateDevices();
      setInputs(ins);
      setOutputs(outs);
    } catch {
      /* permission/enumeration failed — keep defaults */
    }
  }, []);

  useEffect(() => {
    refreshDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refreshDevices);
    return () => md?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);
  useEffect(() => {
    if (s.isListening) refreshDevices();
  }, [s.isListening, refreshDevices]);

  return (
    <Panel title="SETTINGS">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Toggle
          label="OFDM mode"
          checked={s.useOFDM}
          onChange={(v) => setState({
            useOFDM: v,
            // BPSK caps tones at 8; OFDM auto-snap (pilot + tones) is handled by
            // the effect in BenchApp so it also corrects a bad persisted state.
            ...(v ? {} : { toneCount: Math.min(8, s.toneCount) }),
          })}
        />
        <Select
          label="TONES"
          value={String(s.toneCount)}
          onChange={(v) => setState({ toneCount: parseInt(v, 10) })}
          options={(s.useOFDM
            // Must stay multiples of 4 — OFDMEngine groups tones in 4-tone
            // blocks and silently collapses to 4 otherwise. 40 and 48 exist
            // because the channel sweep found 6850-9000 Hz flat within 1-2 dB
            // across every run, which is 2150 Hz — room for 43 tones on the
            // 50 Hz grid, not just 32. At tone start 5000 (band low 6900),
            // 40 tones reach 8850 and stay inside the measured region; 48
            // reach 9250, i.e. 250 Hz past anything the sweep has looked at.
            ? [8, 16, 32, 40, 48]
            : [2, 4, 8]
          ).map((n) => ({ value: String(n), label: `${n} tones` }))}
        />
        {/* Pilot placement matters more than it looks. The drift correction
            measures phase on the PILOT and extrapolates it linearly to each data
            tone (driftPerHz * toneFreq), so the extrapolation factor is
            toneFreq/pilotFreq. At pilot 1850 with tones at 6900-8850 that is
            ~4.8x: a two-sample timing error on the pilot becomes ~148 degrees of
            rotation at the top tone, which no amount of channel estimation
            survives. Raising the ceiling to 7000 allows the pilot to sit just
            below the band, where the factor approaches 1. */}
        <Slider
          label="PILOT" unit="Hz"
          min={s.useOFDM ? 500 : 300} max={s.useOFDM ? 7000 : 1500} step={10}
          value={s.pilotFreqHz}
          onChange={(v) => setState({ pilotFreqHz: v })}
        />
        <Slider
          label="SETTLE" unit=" sym"
          min={0} max={16} step={4}
          value={s.trainingSettleSymbols}
          onChange={(v) => setState({ trainingSettleSymbols: v })}
        />
        <Slider
          label="MIC GAIN" unit="×"
          min={1} max={20} step={1}
          value={s.micGain}
          onChange={(v) => setState({ micGain: v })}
        />
        <Slider
          label="PLAY VOL" unit="×"
          min={1} max={10} step={1}
          value={s.playbackVolume}
          onChange={(v) => setState({ playbackVolume: v })}
        />
        <Select
          label="MIC"
          value={s.selectedInputId}
          onChange={(v) => setState({
            selectedInputId: v,
            // Store the label alongside the id — the id rotates, the label does
            // not, and a stale id silently becomes "browser default".
            selectedInputLabel: inputs.find((d) => d.id === v)?.label ?? '',
          })}
          options={deviceOptions(inputs, 'Default Mic')}
        />
        <Select
          label="SPEAKER"
          value={s.selectedOutputId}
          onChange={(v) => setState({ selectedOutputId: v })}
          options={deviceOptions(outputs, 'Default Speaker')}
        />

        {/* Named config presets — snapshot every persisted config field
            (band, tone count, QAM, gains, devices, calibration) under a name
            so a known-good state is one click away after experimenting. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="lab-panel__title" style={{ padding: 0, background: 'transparent', border: 0 }}>
            CONFIG PRESETS
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              className="lab-select"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="preset name"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
            <Button
              primary
              disabled={!presetName.trim()}
              onClick={() => {
                saveConfigPreset(presetName);
                setPresetName('');
              }}
            >
              SAVE
            </Button>
          </div>
          {presetNames.map((name) => (
            <div key={name} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {name}
              </span>
              <Button onClick={() => loadConfigPreset(name)}>LOAD</Button>
              <Button onClick={() => deleteConfigPreset(name)}>DEL</Button>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

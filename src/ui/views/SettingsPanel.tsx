/**
 * SettingsPanel.tsx — real, usable controls wired to the Store.
 */
import { useCallback, useEffect, useState } from 'react';
import { useStore, setState } from '../Store';
import { enumerateDevices, type DeviceInfo } from '../../audio';
import { Panel } from '../components/instrument/Panel';
import { Toggle } from '../components/instrument/Toggle';
import { Slider } from '../components/instrument/Slider';
import { Select } from '../components/instrument/Select';

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
          onChange={(v) => setState({ useOFDM: v })}
        />
        <Select
          label="TONES"
          value={String(s.toneCount)}
          onChange={(v) => setState({ toneCount: parseInt(v, 10) })}
          options={[
            { value: '2', label: '2 tones' },
            { value: '4', label: '4 tones' },
            { value: '8', label: '8 tones' },
          ]}
        />
        <Slider
          label="PILOT" unit="Hz"
          min={s.useOFDM ? 500 : 300} max={s.useOFDM ? 4000 : 1500} step={10}
          value={s.pilotFreqHz}
          onChange={(v) => setState({ pilotFreqHz: v })}
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
          onChange={(v) => setState({ selectedInputId: v })}
          options={deviceOptions(inputs, 'Default Mic')}
        />
        <Select
          label="SPEAKER"
          value={s.selectedOutputId}
          onChange={(v) => setState({ selectedOutputId: v })}
          options={deviceOptions(outputs, 'Default Speaker')}
        />
      </div>
    </Panel>
  );
}

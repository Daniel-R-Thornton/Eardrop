/**
 * TxPanel.tsx — the real transmit controls: pick a file and send it as sound,
 * send a built-in test, export/load WAV. Reuses the existing app.ts event bus,
 * so this actually plays audio (unlike the DEMO capture, which only visualises).
 */
import { useCallback } from 'react';
import { useStore, setState } from '../Store';
import { formatSize } from '../lib';
import { T } from '../theme/labaccent/tokens';
import { Panel } from '../components/instrument/Panel';
import { Button } from '../components/instrument/Button';
import { StatusBadge } from '../components/StatusBadge';

const dispatch = (type: string, detail?: unknown) =>
  window.dispatchEvent(new CustomEvent(type, { detail }));

export function TxPanel() {
  const s = useStore((x) => x);

  const pickFile = useCallback((f: File | undefined) => {
    if (!f) return;
    setState({ selectedFile: { name: f.name, size: f.size } });
    dispatch('eardrop-file', { file: f });
  }, []);

  return (
    <Panel title="TRANSMIT">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); pickFile(e.dataTransfer.files?.[0]); }}
        onClick={() => document.getElementById('bench-file')?.click()}
        style={{
          border: `2px dashed ${T.panelEdge}`,
          borderRadius: T.radius,
          padding: 14,
          textAlign: 'center',
          cursor: 'pointer',
          fontFamily: T.mono,
          fontSize: 12,
          color: s.selectedFile ? T.panelInk : '#6b6355',
          marginBottom: 8,
        }}
      >
        {s.selectedFile
          ? `${s.selectedFile.name} (${formatSize(s.selectedFile.size)})`
          : 'Drop a file or click to browse'}
        <input
          id="bench-file"
          type="file"
          hidden
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Button
          primary
          disabled={!s.selectedFile || s.isSending}
          onClick={() => dispatch('eardrop-send')}
        >
          {s.isSending ? 'SENDING…' : '▶ TRANSMIT'}
        </Button>
        <Button
          onClick={() => dispatch('eardrop-test-frequency')}
        >
          Test Frequency
        </Button>
        <Button onClick={() => dispatch('eardrop-send-test')} disabled={s.isSending}>
          🔊 SEND TEST
        </Button>
        {s.isPlaying && (
          <Button onClick={() => dispatch('eardrop-stop-playback')}>■ STOP</Button>
        )}
        {s.selectedFile && (
          <Button onClick={() => dispatch('eardrop-export-wav')}>⬇ WAV</Button>
        )}
        <Button onClick={() => dispatch('eardrop-load-wav')}>⬆ FROM WAV</Button>
      </div>

      <div style={{ marginTop: 10 }}>
        <div style={{ fontFamily: T.mono, fontSize: 11, color: '#6b6355', marginBottom: 4 }}>
          DATA CONSTELLATION
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {([
            { bits: 2, label: 'QPSK' },
            { bits: 4, label: '16-QAM' },
            { bits: 6, label: '64-QAM' },
          ] as const).map((opt) => (
            <Button
              key={opt.bits}
              primary={s.dataQamBits === opt.bits}
              onClick={() => setState({ dataQamBits: opt.bits })}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        {s.dataQamBits === 4 && (
          <div style={{ fontFamily: T.mono, fontSize: 11, color: '#a08050', marginTop: 4 }}>
            ⚠ needs a clean signal
          </div>
        )}
        {s.dataQamBits === 6 && (
          <div style={{ fontFamily: T.mono, fontSize: 11, color: '#a08050', marginTop: 4 }}>
            ⚠ needs strong signal
          </div>
        )}
        {s.useOFDM && s.dataQamBits > 2 && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
            <span className="lab-panel__title" style={{ padding: 0, background: 'transparent', border: 0 }}>
              QAM SCALE: {s.qamScaleOverride ? s.qamScaleOverride.toFixed(3) : 'Auto'}
            </span>
            <input
              type="range"
              className="lab-slider"
              min={0}
              max={0.3}
              step={0.005}
              value={s.qamScaleOverride ?? 0}
              onChange={(e) => {
                const v = Number(e.target.value);
                setState({ qamScaleOverride: v > 0 ? v : undefined });
              }}
            />
          </label>
        )}
      </div>

      {s.isSending && (
        <div style={{ marginTop: 8, height: 6, background: T.panelEdge, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ width: `${s.progress}%`, height: '100%', background: T.phosphor, transition: 'width .2s' }} />
        </div>
      )}
      {s.sendStatus && <div style={{ marginTop: 8 }}><StatusBadge {...s.sendStatus} /></div>}
    </Panel>
  );
}

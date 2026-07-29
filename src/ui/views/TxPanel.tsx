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
        <Button
          onClick={() => dispatch('eardrop-speed-test')}
          disabled={!s.useOFDM || s.isSending || s.speedTestRunning}
        >
          {s.speedTestRunning && s.speedTestProgress
            ? `TEST ${s.speedTestProgress.current}/${s.speedTestProgress.total}`
            : 'TEST SPEED'}
        </Button>
      </div>

      {s.useOFDM && (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 8,
            fontFamily: T.mono,
            fontSize: 11,
            color: '#6b6355',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={s.speedTestLoopback}
            onChange={(e) => setState({ speedTestLoopback: e.target.checked })}
          />
          Speed test: software loopback (bypass speaker/mic)
        </label>
      )}

      {s.useOFDM && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontFamily: T.mono, fontSize: 11, color: '#6b6355' }}>
          <span>SEARCH</span>
          {([
            ['hunt', 'hunt', 'Climb one variable to its local max, then the next'],
            ['grid', 'grid', 'Exhaustively try every combination'],
          ] as const).map(([mode, label, hint]) => (
            <button
              key={mode}
              type="button"
              title={hint}
              onClick={() => setState({ speedTestMode: mode })}
              disabled={s.speedTestRunning}
              style={{
                fontFamily: T.mono,
                fontSize: 11,
                padding: '2px 8px',
                cursor: s.speedTestRunning ? 'default' : 'pointer',
                border: `1px solid ${s.speedTestMode === mode ? '#3b7d4f' : '#c9c1b0'}`,
                background: s.speedTestMode === mode ? '#e2f0e4' : 'transparent',
                color: '#6b6355',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

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

      {s.speedTestResults.length > 0 && (
        <div
          style={{
            marginTop: 10,
            maxHeight: 220,
            overflow: 'auto',
            fontFamily: T.mono,
            fontSize: 11,
            border: `1px solid ${T.panelEdge}`,
            borderRadius: T.radius,
            padding: 8,
          }}
        >
          {s.speedTestBest && (
            <div style={{ color: T.phosphor, marginBottom: 6 }}>
              BEST: {s.speedTestBest.qamBits === 2 ? 'QPSK' : `${s.speedTestBest.qamBits}-QAM`}
              {' @ '}{s.speedTestBest.pilotFreqHz.toFixed(0)}Hz
              {' · scale '}{s.speedTestBest.qamScale.toFixed(3)}
              {' · gain '}{s.speedTestBest.micGain}
              {' · '}{s.speedTestBest.toneCount} tones
              {' · '}{s.speedTestBest.throughputKbps.toFixed(1)} kbps
              {s.speedTestBest.merDb !== null && ` · MER ${s.speedTestBest.merDb.toFixed(1)}dB`}
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#6b6355', textAlign: 'left' }}>
                <th>QAM</th>
                <th>Hz</th>
                <th>Scale</th>
                <th>Gain</th>
                <th>Tones</th>
                <th>OK</th>
                <th>Frames</th>
                <th>MER</th>
                <th>kbps</th>
              </tr>
            </thead>
            <tbody>
              {s.speedTestResults.map((r, i) => (
                <tr
                  key={i}
                  style={{
                    color: r.success ? '#a0c0a0' : '#c08080',
                    background: r === s.speedTestBest ? 'rgba(0,255,0,0.08)' : 'transparent',
                  }}
                >
                  <td>{r.qamBits === 2 ? 'QPSK' : `${r.qamBits}-QAM`}</td>
                  <td>{r.pilotFreqHz.toFixed(0)}</td>
                  <td>{r.qamScale.toFixed(3)}</td>
                  <td>{r.micGain}</td>
                  <td>{r.toneCount}</td>
                  <td>{r.success ? 'OK' : 'FAIL'}</td>
                  <td>{r.framesOk}/{r.framesTotal}</td>
                  <td>{r.merDb !== null ? r.merDb.toFixed(1) : '—'}</td>
                  <td>{r.throughputKbps.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

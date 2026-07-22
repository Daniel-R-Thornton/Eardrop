/**
 * RxPipeline.tsx — the receive side as a mirror of the TX pipeline: incoming
 * audio → sync → channel/equalise → spectrum → decode → assemble → file.
 * Driven by live worker telemetry (level, pilot amplitude, tone energy,
 * spectrum, decode progress) + received files, so it reflects the real decode
 * as it happens (DEMO software loopback or acoustic LISTEN).
 */
import type { ReactNode } from 'react';
import { useStore } from '../Store';
import { useTelemetry } from '../telemetryStore';
import { T } from '../theme/labaccent/tokens';
import { Panel } from '../components/instrument/Panel';
import { LED } from '../components/instrument/LED';
import { Button } from '../components/instrument/Button';
import { Trace } from '../components/scopes/Trace';
import { Spectrum } from '../components/scopes/Spectrum';
import { Waterfall } from '../components/scopes/Waterfall';
import { ToneBars } from '../components/scopes/ToneBars';

const EMPTY = new Float32Array(0);
const W = 240;
const H = 96;

function Row({ k, v, hot }: { k: string; v: string; hot?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: T.mono, fontSize: 11, padding: '1px 0' }}>
      <span style={{ color: T.panelInk, opacity: 0.7 }}>{k}</span>
      <span style={{ color: hot ? T.phosphor : T.panelInk }}>{v}</span>
    </div>
  );
}

function Stage({ n, title, active, children }: { n: number; title: string; active?: boolean; children: ReactNode }) {
  return (
    <div
      style={{
        flex: `1 1 ${W}px`, maxWidth: W + 40,
        border: `2px solid ${active ? T.phosphor : T.panelEdge}`,
        borderRadius: T.radius,
        boxShadow: active ? `0 0 12px ${T.phosphor}` : 'none',
      }}
    >
      <Panel title={`R${n}. ${title}`}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 14 }}><LED on={!!active} /></div>
        {children}
      </Panel>
    </div>
  );
}

const RX_STATE_LABELS: Record<number, string> = { 0: 'idle', 1: 'searching', 2: 'sync', 3: 'training', 4: 'receiving', 5: 'done' };

export function RxPipeline() {
  const s = useStore((x) => x);
  const tel = useTelemetry((t) => t);
  const spectrum = tel?.spectrum ?? s.fftSpectrum ?? EMPTY;
  const maxHz = tel?.spectrumMaxHz ?? 4000;
  const tones = tel?.toneEnergies ?? s.toneEnergies;
  const micDb = tel?.rmsDb ?? s.micLevel;
  const pilotAmp = tel?.pilotAmplitude ?? 0;
  const prog = tel?.progress;
  const mic = s.debugSamples ?? EMPTY;
  const listening = s.isListening;
  const synced = pilotAmp > 0.02;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: 1, color: T.panelInk }}>DECODE PIPELINE</span>
        <Button onClick={() => window.dispatchEvent(new CustomEvent('eardrop-record'))}>
          {listening ? '■ STOP' : '● LISTEN'}
        </Button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'stretch' }}>
        <Stage n={1} title="RX IN" active={listening}>
          <Row k="level" v={`${micDb.toFixed(0)} dB`} hot={micDb > -60} />
          <Trace data={mic} color={T.cyan} width={W} height={H} />
        </Stage>

        <Stage n={2} title="SYNC" active={synced}>
          <Row k="pilot amp" v={pilotAmp.toFixed(3)} hot={synced} />
          <Row k="state" v={prog ? (RX_STATE_LABELS[prog.state] ?? String(prog.state)) : '—'} hot={synced} />
          <Row k="locked" v={synced ? 'YES' : 'no'} hot={synced} />
        </Stage>

        <Stage n={3} title="CHANNEL / TONES">
          <ToneBars energies={tones} width={W} height={H} />
        </Stage>

        <Stage n={4} title="SPECTRUM">
          <Spectrum bins={spectrum} maxHz={maxHz} width={W} height={H - 24} />
          <div style={{ marginTop: 3 }}><Waterfall bins={spectrum} width={W} height={40} /></div>
        </Stage>

        <Stage n={5} title="DECODE FRAMES" active={!!prog && prog.framesReceived > 0}>
          <Row k="frames" v={prog ? `${prog.framesReceived}/${prog.totalFrames || '?'}` : '—'} hot={(prog?.framesReceived ?? 0) > 0} />
          <Row k="file" v={prog?.fileName || '—'} />
        </Stage>

        <Stage n={6} title="ASSEMBLE" active={!!prog && prog.bytesAssembled > 0}>
          <Row k="bytes" v={prog ? `${prog.bytesAssembled}${prog.fileSize ? '/' + prog.fileSize : ''} B` : '—'} hot={(prog?.bytesAssembled ?? 0) > 0} />
        </Stage>

        <Stage n={7} title="FILE OUT" active={s.receivedFiles.length > 0}>
          {s.receivedFiles.length === 0 ? (
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6 }}>(nothing received yet)</div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontFamily: T.mono, fontSize: 11 }}>
              {s.receivedFiles.map((f, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  <a href={f.url} download={f.name} style={{ color: T.phosphor }}>{f.name}</a>{' '}
                  <span style={{ color: T.panelInk, opacity: 0.6 }}>({f.size} B)</span>
                </li>
              ))}
            </ul>
          )}
        </Stage>
      </div>
    </div>
  );
}

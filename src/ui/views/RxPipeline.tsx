/**
 * RxPipeline.tsx — the receive side as a mirror of the TX pipeline: incoming
 * audio → sync → channel/equalise → spectrum → decode → assemble → file.
 * Driven by live worker telemetry (level, pilot amplitude, tone energy,
 * spectrum, decode progress) + received files.
 *
 * Has its own transport (play/step/reset) that walks a highlight through the
 * decode stages for explanation, and an enlarge-focused toggle.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../Store';
import { useTelemetry } from '../telemetryStore';
import { T } from '../theme/labaccent/tokens';
import { Panel } from '../components/instrument/Panel';
import { LED } from '../components/instrument/LED';
import { Button } from '../components/instrument/Button';
import { Toggle } from '../components/instrument/Toggle';
import { Trace } from '../components/scopes/Trace';
import { Spectrum } from '../components/scopes/Spectrum';
import { Waterfall } from '../components/scopes/Waterfall';
import { ToneBars } from '../components/scopes/ToneBars';

const EMPTY = new Float32Array(0);
const BW = 300;
const BH = 150;
const STAGE_COUNT = 7;

function Row({ k, v, hot }: { k: string; v: string; hot?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: T.mono, fontSize: 12, padding: '2px 0' }}>
      <span style={{ color: T.panelInk, opacity: 0.7 }}>{k}</span>
      <span style={{ color: hot ? T.phosphor : T.panelInk }}>{v}</span>
    </div>
  );
}

function Stage(
  { n, title, live, focus, w, children }:
  { n: number; title: string; live?: boolean; focus?: boolean; w: number; children: ReactNode },
) {
  return (
    <div
      style={{
        flex: `1 1 ${w}px`, maxWidth: w + 40,
        border: `2px solid ${focus ? T.phosphor : T.panelEdge}`,
        borderRadius: T.radius,
        boxShadow: focus ? `0 0 14px ${T.phosphor}` : 'none',
        transition: 'border-color .2s, box-shadow .2s, flex-basis .2s',
      }}
    >
      <Panel title={`R${n}. ${title}`}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', minHeight: 14 }}><LED on={!!live} /></div>
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

  // Local transport: walk a highlight through the decode stages.
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [enlarge, setEnlarge] = useState(false);
  const stepRef = useRef(0);
  useEffect(() => { stepRef.current = step; }, [step]);
  useEffect(() => {
    if (!playing) return undefined;
    const id = window.setInterval(() => {
      const next = stepRef.current + 1;
      if (next >= STAGE_COUNT) { setPlaying(false); return; }
      setStep(next);
    }, 900);
    return () => clearInterval(id);
  }, [playing]);

  const size = (i: number) => {
    const big = enlarge && i === step;
    return big ? Math.round(BW * 1.6) : BW;
  };
  const focus = (i: number) => i === step;

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontFamily: T.mono, fontSize: 12, letterSpacing: 1, color: T.panelInk, marginRight: 4 }}>DECODE PIPELINE</span>
        <Button onClick={() => window.dispatchEvent(new CustomEvent('eardrop-record'))}>
          {listening ? '■ STOP' : '● LISTEN'}
        </Button>
        <Button onClick={() => setPlaying((p) => !p)}>{playing ? '❚❚ PAUSE' : '▶ PLAY'}</Button>
        <Button onClick={() => setStep((i) => Math.min(STAGE_COUNT - 1, i + 1))}>⇥ STEP</Button>
        <Button onClick={() => { setPlaying(false); setStep(0); }}>↺ RESET</Button>
        <Toggle label="enlarge focused" checked={enlarge} onChange={setEnlarge} />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'stretch' }}>
        <Stage n={1} title="RX IN" live={listening} focus={focus(0)} w={size(0)}>
          <Row k="level" v={`${micDb.toFixed(0)} dB`} hot={micDb > -60} />
          <Trace data={mic} color={T.cyan} width={size(0)} height={focus(0) && enlarge ? Math.round(BH * 1.6) : BH} />
        </Stage>

        <Stage n={2} title="SYNC" live={synced} focus={focus(1)} w={size(1)}>
          <Row k="pilot amp" v={pilotAmp.toFixed(3)} hot={synced} />
          <Row k="state" v={prog ? (RX_STATE_LABELS[prog.state] ?? String(prog.state)) : '—'} hot={synced} />
          <Row k="locked" v={synced ? 'YES' : 'no'} hot={synced} />
        </Stage>

        <Stage n={3} title="CHANNEL / TONES" focus={focus(2)} w={size(2)}>
          <ToneBars energies={tones} width={size(2)} height={focus(2) && enlarge ? Math.round(BH * 1.6) : BH} />
        </Stage>

        <Stage n={4} title="SPECTRUM" focus={focus(3)} w={size(3)}>
          <Spectrum bins={spectrum} maxHz={maxHz} width={size(3)} height={(focus(3) && enlarge ? Math.round(BH * 1.6) : BH) - 46} />
          <div style={{ marginTop: 3 }}><Waterfall bins={spectrum} width={size(3)} height={40} /></div>
        </Stage>

        <Stage n={5} title="DECODE FRAMES" live={!!prog && prog.framesReceived > 0} focus={focus(4)} w={size(4)}>
          <Row k="frames" v={prog ? `${prog.framesReceived}/${prog.totalFrames || '?'}` : '—'} hot={(prog?.framesReceived ?? 0) > 0} />
          <Row k="file" v={prog?.fileName || '—'} />
        </Stage>

        <Stage n={6} title="ASSEMBLE" live={!!prog && prog.bytesAssembled > 0} focus={focus(5)} w={size(5)}>
          <Row k="bytes" v={prog ? `${prog.bytesAssembled}${prog.fileSize ? '/' + prog.fileSize : ''} B` : '—'} hot={(prog?.bytesAssembled ?? 0) > 0} />
        </Stage>

        <Stage n={7} title="FILE OUT" live={s.receivedFiles.length > 0} focus={focus(6)} w={size(6)}>
          {s.receivedFiles.length === 0 ? (
            <div style={{ fontFamily: T.mono, fontSize: 12, color: T.panelInk, opacity: 0.6 }}>(nothing received yet)</div>
          ) : (
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontFamily: T.mono, fontSize: 12 }}>
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

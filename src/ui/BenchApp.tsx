/**
 * BenchApp.tsx — the signal bench. Assembles settings, transport, the pipeline
 * hero and the RX view. Owns the pipeline playhead and mirrors its state + the
 * chosen speed into the Store.
 */
import { useEffect, useState } from 'react';
import { useStore, setState } from './Store';
import { Toggle } from './components/instrument/Toggle';
import { usePipelinePlayhead } from './views/usePipelinePlayhead';
import { PipelineView } from './views/PipelineView';
import { FrameTimeline } from './views/FrameTimeline';
import { RxPipeline } from './views/RxPipeline';
import { PresentationMode } from './views/PresentationMode';
import { SettingsPanel } from './views/SettingsPanel';
import { TxPanel } from './views/TxPanel';
import { Panel } from './components/instrument/Panel';
import { LED } from './components/instrument/LED';
import { T } from './theme/labaccent/tokens';
import { OFDM_DEFAULTS } from '../modem/types';
import './theme/labaccent/labaccent.css';

/** Acoustically-reliable OFDM pilot — tones land ~5-7 kHz, which survives a real
 *  speaker->mic path far better than the 1900 Hz codebase default. */
const ACOUSTIC_OFDM_PILOT_HZ = 3150;

export function BenchApp() {
  const s = useStore((x) => x);
  const ph = usePipelinePlayhead(s.demoRun, s.demoSpeed);
  const [enlargeFocused, setEnlargeFocused] = useState(false);
  const [presenting, setPresenting] = useState(false);

  // Mirror playhead position into the Store so any panel can read it.
  useEffect(() => {
    setState({ demoFrameIndex: ph.frameIndex, demoStageIndex: ph.stageIndex });
  }, [ph.frameIndex, ph.stageIndex]);

  // When a fresh capture arrives, walk the pipeline automatically (unless stepping).
  useEffect(() => {
    if (s.demoRun && s.demoSpeed !== 'step') {
      ph.reset();
      ph.play();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.demoRun]);

  // OFDM needs a pilot up in its band and >=8 tones — snap defaults when OFDM is
  // on (also corrects a stale persisted config, e.g. a BPSK pilot at 600/700 Hz
  // that never decodes). Mirrors the modem's OFDM_DEFAULTS.
  useEffect(() => {
    if (!s.useOFDM) return;
    const updates: { pilotFreqHz?: number; toneCount?: number } = {};
    // 3150 Hz puts the OFDM tones up around 5-7 kHz, which carries far more
    // reliably over a real speaker->mic path than the lower 1900 Hz default.
    if (s.pilotFreqHz < 1500) updates.pilotFreqHz = ACOUSTIC_OFDM_PILOT_HZ;
    if (s.toneCount < 8) updates.toneCount = OFDM_DEFAULTS.toneCount;
    if (Object.keys(updates).length) setState(updates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.useOFDM]);

  const dispatch = (type: string) => window.dispatchEvent(new CustomEvent(type));

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#c9c3b3',
        padding: 16,
        fontFamily: T.mono,
        color: T.panelInk,
      }}
    >
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 22, letterSpacing: 2, fontWeight: 800 }}>◢◤ EARDROP</h1>
          <span style={{ fontSize: 11, opacity: 0.7 }}>signal bench · sound ↔ data</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => setPresenting((p) => !p)}
            style={{
              fontFamily: T.mono, fontSize: 12, padding: '5px 12px', borderRadius: T.radius, cursor: 'pointer',
              border: `1px solid ${presenting ? T.phosphor : T.panelEdge}`,
              background: presenting ? T.phosphorDim : 'rgba(0,0,0,0.04)',
              color: presenting ? T.phosphor : T.panelInk,
            }}
          >
            {presenting ? '◱ bench' : '▶ presentation'}
          </button>
          <LED on={s.isPlaying || s.isListening} label={s.isPlaying ? 'TX' : s.isListening ? 'RX' : 'IDLE'} />
        </div>
      </div>

      {presenting && <PresentationMode onExit={() => setPresenting(false)} />}

      {!presenting && (
      <>
      {/* transport */}
      <div style={{ marginBottom: 12 }}>
        <FrameTimeline
          run={s.demoRun}
          frameIndex={ph.frameIndex}
          playing={ph.playing}
          speed={s.demoSpeed}
          onDemo={() => dispatch('eardrop-demo-encode')}
          onFocus={ph.focusFrame}
          onPlay={ph.play}
          onPause={ph.pause}
          onStep={ph.step}
          onReset={ph.reset}
          onSpeedChange={(sp) => setState({ demoSpeed: sp })}
        />
      </div>

      {/* pipeline hero */}
      <div style={{ marginBottom: 12 }}>
        <Panel title="SIGNAL PIPELINE">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
            <Toggle label="enlarge focused stage" checked={enlargeFocused} onChange={setEnlargeFocused} />
          </div>
          <PipelineView run={s.demoRun} frameIndex={ph.frameIndex} stageIndex={ph.stageIndex} enlarge={enlargeFocused} />
        </Panel>
      </div>

      {/* tx + settings */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 12, alignItems: 'start', marginBottom: 12 }}>
        <TxPanel />
        <SettingsPanel />
      </div>

      {/* rx decode pipeline */}
      <Panel title="RECEIVE">
        <RxPipeline />
      </Panel>
      </>
      )}
    </div>
  );
}

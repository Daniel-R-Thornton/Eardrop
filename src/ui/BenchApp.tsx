/**
 * BenchApp.tsx — the signal bench. Assembles settings, transport, the pipeline
 * hero and the RX view. Owns the pipeline playhead and mirrors its state + the
 * chosen speed into the Store.
 */
import { useEffect } from 'react';
import { useStore, setState } from './Store';
import { usePipelinePlayhead } from './views/usePipelinePlayhead';
import { PipelineView } from './views/PipelineView';
import { FrameTimeline } from './views/FrameTimeline';
import { RxView } from './views/RxView';
import { SettingsPanel } from './views/SettingsPanel';
import { TxPanel } from './views/TxPanel';
import { Panel } from './components/instrument/Panel';
import { LED } from './components/instrument/LED';
import { T } from './theme/labaccent/tokens';
import './theme/labaccent/labaccent.css';

export function BenchApp() {
  const s = useStore((x) => x);
  const ph = usePipelinePlayhead(s.demoRun, s.demoSpeed);

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
        <LED on={s.isPlaying || s.isListening} label={s.isPlaying ? 'TX' : s.isListening ? 'RX' : 'IDLE'} />
      </div>

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
          <PipelineView run={s.demoRun} frameIndex={ph.frameIndex} stageIndex={ph.stageIndex} />
        </Panel>
      </div>

      {/* tx + settings + rx */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 12, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <TxPanel />
          <SettingsPanel />
        </div>
        <RxView />
      </div>
    </div>
  );
}

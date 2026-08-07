/**
 * BenchApp.tsx — the signal bench. Assembles settings, transport, the pipeline
 * hero and the RX view. Owns the pipeline playhead and mirrors its state + the
 * chosen speed into the Store.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { dlogDump, dlogRecords, DLOG_RING_MAX } from '../lib/debug/dlog';
import { LogShare } from './views/LogShare';
import { compressRecords } from '../lib/debug/llmDump';
import { useStore, setState } from './Store';
import { Toggle } from './components/instrument/Toggle';
import { usePipelinePlayhead } from './views/usePipelinePlayhead';
import { PipelineView } from './views/PipelineView';
import { FrameTimeline } from './views/FrameTimeline';
import { RxPipeline } from './views/RxPipeline';
import { PresentationMode } from './views/PresentationMode';
import { RoomMode } from './views/RoomMode';
import { SettingsPanel } from './views/SettingsPanel';
import { TxPanel } from './views/TxPanel';
import { ChatterPanel } from './views/ChatterPanel';
import { Panel } from './components/instrument/Panel';
import { LED } from './components/instrument/LED';
import { FrequencySweep } from './views/FrequencySweep';
import { ChannelSweep } from './views/ChannelSweep';
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
  const [inRoom, setInRoom] = useState(false);
  const [showFrequencySweep, setShowFrequencySweep] = useState(false);
  const [showChannelSweep, setShowChannelSweep] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [copiedLlm, setCopiedLlm] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);

  const copyLlmDump = useCallback(() => {
    navigator.clipboard.writeText(compressRecords(dlogRecords())).then(() => {
      setCopiedLlm(true);
      setTimeout(() => setCopiedLlm(false), 1200);
    });
  }, []);
  const copyRawLog = useCallback(() => {
    navigator.clipboard.writeText(dlogDump(DLOG_RING_MAX)).then(() => {
      setCopiedRaw(true);
      setTimeout(() => setCopiedRaw(false), 1200);
    });
  }, []);

  // Event listener for frequency sweep
  useEffect(() => {
    const handleFrequencySweep = () => setShowFrequencySweep(true);
    const handleChannelSweep = () => setShowChannelSweep(true);
    window.addEventListener('eardrop-test-frequency', handleFrequencySweep);
    window.addEventListener('eardrop-channel-sweep', handleChannelSweep);
    return () => {
      window.removeEventListener('eardrop-test-frequency', handleFrequencySweep);
      window.removeEventListener('eardrop-channel-sweep', handleChannelSweep);
    };
  }, []);

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

  /**
   * The header's action buttons. Extracted because all five repeated the same
   * base declaration, and the one thing they all got wrong had to be fixed five
   * times: `padding: '5px 12px'` at fontSize 12 rendered them 28px tall, well
   * under the 44px touch floor the room page honours throughout. This header is
   * on screen in room mode too — the surface that is actually driven from a
   * phone — so `◎ room mode` and `▤ log` were thumb targets all along.
   *
   * `active` drives the highlighted state the toggles and the copy buttons share.
   */
  const headerBtn = (active: boolean): CSSProperties => ({
    fontFamily: T.mono, fontSize: 12, minHeight: 44, padding: '0 12px',
    borderRadius: T.radius, cursor: 'pointer', whiteSpace: 'nowrap',
    border: `1px solid ${active ? T.phosphor : T.panelEdge}`,
    background: active ? T.phosphorDim : 'rgba(0,0,0,0.04)',
    color: active ? T.phosphor : T.panelInk,
  });

  return (
    <div
      style={{
        minHeight: '100vh',
        // Room mode is capped to exactly the viewport (no page-level scroll)
        // so the node graph can fill genuinely available space and the
        // packet/roster panels handle their own internal scrolling instead
        // of the whole page growing taller. Every other mode keeps the
        // original "grow with content" page scroll unchanged.
        //
        // dvh, not vh. On mobile 100vh is the LARGE viewport — the height the
        // page would have with the URL bar retracted — so with overflow hidden
        // the bottom of the room column sat off-screen with no page scroll left
        // to reach it. dvh tracks the height actually visible. Where it is
        // unsupported the declaration is dropped and behaviour falls back to
        // minHeight: 100vh above, i.e. exactly what this did before.
        height: inRoom ? '100dvh' : undefined,
        overflow: inRoom ? 'hidden' : undefined,
        display: 'flex',
        flexDirection: 'column',
        background: '#c9c3b3',
        padding: 16,
        fontFamily: T.mono,
        color: T.panelInk,
        boxSizing: 'border-box',
      }}
    >
      {/* header — WRAPS. Unwrapped, the five action buttons plus the wordmark
          ran 215px off the right edge of a 390px phone, and `space-between`
          cannot recover from that: with no room to distribute, the last buttons
          simply leave the screen. The room page reaches its own log and back
          controls from its own header, but this bar is what is on screen
          everywhere else. flexWrap plus `marginLeft: auto` on the button group
          keeps one row on a desktop and stacks on a phone. */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, rowGap: 8,
        marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontSize: 22, letterSpacing: 2, fontWeight: 800 }}>◢◤ EARDROP</h1>
          <span style={{ fontSize: 11, opacity: 0.7 }}>signal bench · sound ↔ data</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginLeft: 'auto' }}>
          {/* Session export. Lives in the main header rather than the
              Ctrl+Shift+D debug overlay, because that overlay is not where the
              work happens and a diagnostic nobody can find is a diagnostic
              nobody uses. */}
          <button
            onClick={copyLlmDump}
            title="Compressed session digest for an LLM — per-tone arrays reduced to stats (docs/dump-format.md)"
            style={headerBtn(copiedLlm)}
          >
            {copiedLlm ? '✓ copied' : '⧉ LLM dump'}
          </button>
          <button
            onClick={copyRawLog}
            title="Copy the raw human-readable session log"
            style={headerBtn(copiedRaw)}
          >
            {copiedRaw ? '✓ copied' : '⧉ raw log'}
          </button>
          <button
            onClick={() => setShowLog(true)}
            title="Read, share or download the session log — the only way to see it on a phone"
            style={headerBtn(false)}
          >
            ▤ log
          </button>
          <button
            onClick={() => { setPresenting((p) => !p); setInRoom(false); }}
            style={headerBtn(presenting)}
          >
            {presenting ? '◱ bench' : '▶ presentation'}
          </button>
          <button
            onClick={() => { setInRoom((r) => !r); setPresenting(false); }}
            style={headerBtn(inRoom)}
          >
            {inRoom ? '◱ bench' : '◎ room mode'}
          </button>
          <LED on={s.isPlaying || s.isListening} label={s.isPlaying ? 'TX' : s.isListening ? 'RX' : 'IDLE'} />
        </div>
      </div>

      {presenting && <PresentationMode onExit={() => setPresenting(false)} />}
      {!presenting && inRoom && (
        <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <RoomMode onExit={() => setInRoom(false)} />
        </div>
      )}

      {!presenting && !inRoom && (
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

      {/* tx + settings + chatter room */}
      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr 260px', gap: 12, alignItems: 'start', marginBottom: 12 }}>
        <TxPanel />
        <SettingsPanel />
        <ChatterPanel />
      </div>

      {/* rx decode pipeline */}
      <Panel title="RECEIVE">
        <RxPipeline />
      </Panel>
      </>
      )}

      {showLog && <LogShare onClose={() => setShowLog(false)} />}
      {showFrequencySweep && <FrequencySweep />}
      {showChannelSweep && <ChannelSweep onClose={() => setShowChannelSweep(false)} />}
    </div>
  );
}

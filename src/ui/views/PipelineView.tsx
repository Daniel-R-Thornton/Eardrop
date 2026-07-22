/**
 * PipelineView.tsx — the hero: a file becoming sound, stage by stage.
 * Renders the 8 pipeline stages left→right from the active captured frame,
 * highlights the current stage, and animates a "frame in flight" token across.
 */
import { STAGES } from './usePipelinePlayhead';
import type { Run } from '../../modem/protocol/captureTypes';
import { T, TONE_TRACE } from '../theme/labaccent/tokens';
import { Panel } from '../components/instrument/Panel';
import { LED } from '../components/instrument/LED';
import { ByteMap } from '../components/protocol/ByteMap';
import { BitStream } from '../components/protocol/BitStream';
import { FrameAnatomy } from '../components/protocol/FrameAnatomy';
import { EccView } from '../components/protocol/EccView';
import { Constellation } from '../components/scopes/Constellation';
import { MultiTrace } from '../components/scopes/MultiTrace';
import { Trace } from '../components/scopes/Trace';

const STAGE_LABELS: Record<string, string> = {
  payload: 'PAYLOAD',
  frame: 'FRAME',
  ecc: 'ECC',
  symbols: 'SYMBOLS',
  channels: 'CHANNELS',
  combined: 'COMBINED',
  sync: 'SYNC',
  txout: 'TX OUT',
};

const SW = 340;
const SH = 180;

export interface PipelineViewProps {
  run: Run | null;
  frameIndex: number;
  stageIndex: number;
  /** Enlarge the currently-active stage panel. */
  enlarge?: boolean;
}

export function PipelineView({ run, frameIndex, stageIndex, enlarge = false }: PipelineViewProps) {
  const bundle = run?.frames[frameIndex] ?? null;

  const renderStage = (stage: string, w: number, h: number) => {
    if (!bundle) {
      return <div style={{ width: w, height: h, opacity: 0.3 }} />;
    }
    switch (stage) {
      case 'payload':
        return (
          <div style={{ width: w }}>
            {bundle.payloadBytes.length === 0 ? (
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6, padding: '8px 0' }}>
                no payload — {bundle.frameKind} frame (metadata only)
              </div>
            ) : (
              <>
                <ByteMap bytes={bundle.payloadBytes} />
                <BitStream bytes={bundle.payloadBytes} max={128} />
              </>
            )}
          </div>
        );
      case 'frame':
        return <div style={{ width: w }}><FrameAnatomy fields={bundle.frameFields} /></div>;
      case 'ecc':
        return (
          <div style={{ width: w }}>
            <EccView
              before={bundle.eccBefore}
              after={bundle.eccAfter}
              scheme={bundle.eccScheme}
              capacity={bundle.correctionCapacity}
            />
          </div>
        );
      case 'symbols':
        return <Constellation points={bundle.symbols} width={w} height={h} />;
      case 'channels': {
        // 32 tones won't fit legibly — show the first few + the pilot.
        const MAX_SHOWN = 6;
        const shown = bundle.toneWaves.slice(0, MAX_SHOWN);
        const traces = shown.map((data, i) => ({
          data,
          color: TONE_TRACE[i % TONE_TRACE.length],
          label: `CH${i + 1}`,
        }));
        traces.push({ data: bundle.pilotWave, color: T.amber, label: 'PILOT' });
        const more = bundle.toneWaves.length - shown.length;
        return (
          <div>
            <MultiTrace traces={traces} width={w} height={h} />
            {more > 0 && (
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.panelInk, opacity: 0.6, marginTop: 2 }}>
                +{more} more tones ({bundle.toneWaves.length} total)
              </div>
            )}
          </div>
        );
      }
      case 'combined':
        return <Trace data={bundle.combined} width={w} height={h} />;
      case 'sync':
        return <Trace data={bundle.preamble.length ? bundle.preamble : bundle.combined} color={T.cyan} width={w} height={h} />;
      case 'txout':
        return <Trace data={bundle.txFinal} color={T.phosphor} width={w} height={h} />;
      default:
        return null;
    }
  };

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'stretch' }}>
      {STAGES.map((stage, i) => {
        const active = i === stageIndex;
        const big = active && enlarge;
        const w = big ? Math.round(SW * 1.7) : SW;
        const h = big ? Math.round(SH * 1.7) : SH;
        return (
          <div
            key={stage}
            style={{
              flex: `1 1 ${w}px`,
              maxWidth: w + 40,
              border: `2px solid ${active ? T.phosphor : T.panelEdge}`,
              borderRadius: T.radius,
              boxShadow: active ? `0 0 14px ${T.phosphor}` : 'none',
              transition: 'border-color .2s, box-shadow .2s, flex-basis .2s',
            }}
          >
            <Panel title={`${i + 1}. ${STAGE_LABELS[stage] ?? stage.toUpperCase()}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, minHeight: 16 }}>
                {active && bundle ? (
                  <span
                    style={{
                      background: T.phosphor, color: T.screenBg, fontFamily: T.mono,
                      fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 9,
                      boxShadow: `0 0 8px ${T.phosphor}`,
                    }}
                  >
                    ▸ {bundle.frameKind}#{bundle.frameIndex}
                  </span>
                ) : <span />}
                <LED on={active} />
              </div>
              {renderStage(stage, w, h)}
            </Panel>
          </div>
        );
      })}
    </div>
  );
}

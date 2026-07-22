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

const SW = 240;
const SH = 96;

export interface PipelineViewProps {
  run: Run | null;
  frameIndex: number;
  stageIndex: number;
}

export function PipelineView({ run, frameIndex, stageIndex }: PipelineViewProps) {
  const bundle = run?.frames[frameIndex] ?? null;

  const renderStage = (stage: string) => {
    if (!bundle) {
      return <div style={{ width: SW, height: SH, opacity: 0.3 }} />;
    }
    switch (stage) {
      case 'payload':
        return (
          <div style={{ width: SW }}>
            <ByteMap bytes={bundle.payloadBytes} />
            <BitStream bytes={bundle.payloadBytes} max={128} />
          </div>
        );
      case 'frame':
        return <div style={{ width: SW }}><FrameAnatomy fields={bundle.frameFields} /></div>;
      case 'ecc':
        return (
          <div style={{ width: SW }}>
            <EccView
              before={bundle.eccBefore}
              after={bundle.eccAfter}
              scheme={bundle.eccScheme}
              capacity={bundle.correctionCapacity}
            />
          </div>
        );
      case 'symbols':
        return <Constellation points={bundle.symbols} width={SW} height={SH} />;
      case 'channels': {
        const traces = bundle.toneWaves.map((data, i) => ({
          data,
          color: TONE_TRACE[i % TONE_TRACE.length],
          label: `CH${i + 1}`,
        }));
        traces.push({ data: bundle.pilotWave, color: T.amber, label: 'PILOT' });
        return <MultiTrace traces={traces} width={SW} height={SH} />;
      }
      case 'combined':
        return <Trace data={bundle.combined} width={SW} height={SH} />;
      case 'sync':
        return <Trace data={bundle.preamble.length ? bundle.preamble : bundle.combined} color={T.cyan} width={SW} height={SH} />;
      case 'txout':
        return <Trace data={bundle.txFinal} color={T.phosphor} width={SW} height={SH} />;
      default:
        return null;
    }
  };

  const pct = STAGES.length > 1 ? (stageIndex / (STAGES.length - 1)) * 100 : 0;

  return (
    <div style={{ position: 'relative' }}>
      {/* frame-in-flight token */}
      {bundle && (
        <div
          style={{
            position: 'absolute',
            top: -10,
            left: `calc(${pct}% - 30px)`,
            transition: 'left 0.35s cubic-bezier(.4,0,.2,1)',
            background: T.phosphor,
            color: T.screenBg,
            fontFamily: T.mono,
            fontSize: 10,
            fontWeight: 700,
            padding: '2px 8px',
            borderRadius: 10,
            zIndex: 2,
            whiteSpace: 'nowrap',
            boxShadow: `0 0 8px ${T.phosphor}`,
          }}
        >
          ▸ {bundle.frameKind}#{bundle.frameIndex}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingTop: 12, alignItems: 'stretch' }}>
        {STAGES.map((stage, i) => {
          const active = i === stageIndex;
          return (
            <div
              key={stage}
              style={{
                flex: '0 0 auto',
                border: `1px solid ${active ? T.phosphor : 'transparent'}`,
                borderRadius: T.radius,
                boxShadow: active ? `0 0 10px ${T.phosphorDim}` : 'none',
                transition: 'border-color .2s, box-shadow .2s',
              }}
            >
              <Panel title={STAGE_LABELS[stage] ?? stage.toUpperCase()}>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
                  <LED on={active} />
                </div>
                {renderStage(stage)}
              </Panel>
            </div>
          );
        })}
      </div>
    </div>
  );
}

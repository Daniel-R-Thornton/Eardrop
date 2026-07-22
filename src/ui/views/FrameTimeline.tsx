/**
 * FrameTimeline.tsx — transport row + per-frame chips.
 * Pick a frame to focus/replay it through the pipeline; control pace.
 */
import type { Run } from '../../modem/protocol/captureTypes';
import { T } from '../theme/labaccent/tokens';
import { Button } from '../components/instrument/Button';
import { Select } from '../components/instrument/Select';

export interface FrameTimelineProps {
  run: Run | null;
  frameIndex: number;
  playing: boolean;
  speed: 'realtime' | 'slow' | 'step';
  onDemo: () => void;
  onFocus: (i: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onStep: () => void;
  onReset: () => void;
  onSpeedChange: (s: 'realtime' | 'slow' | 'step') => void;
}

export function FrameTimeline({
  run, frameIndex, playing, speed,
  onDemo, onFocus, onPlay, onPause, onStep, onReset, onSpeedChange,
}: FrameTimelineProps) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
      <Button onClick={onDemo} primary>▶ DEMO</Button>
      <Button onClick={playing ? onPause : onPlay} disabled={!run}>
        {playing ? '❚❚ PAUSE' : '▶ PLAY'}
      </Button>
      <Button onClick={onStep} disabled={!run}>⇥ STEP</Button>
      <Button onClick={onReset} disabled={!run}>↺ RESET</Button>
      <Select
        label="SPEED"
        value={speed}
        onChange={(v) => onSpeedChange(v as 'realtime' | 'slow' | 'step')}
        options={[
          { value: 'realtime', label: 'real-time' },
          { value: 'slow', label: 'slow' },
          { value: 'step', label: 'step' },
        ]}
      />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {(run?.frames ?? []).map((f, i) => {
          const active = i === frameIndex;
          return (
            <button
              key={i}
              onClick={() => onFocus(i)}
              title={`frame ${i}: ${f.frameKind}`}
              style={{
                fontFamily: T.mono,
                fontSize: 10,
                padding: '3px 8px',
                borderRadius: 10,
                cursor: 'pointer',
                border: `1px solid ${active ? T.phosphor : T.panelEdge}`,
                background: active ? T.phosphorDim : 'transparent',
                color: active ? T.phosphor : T.panelInk,
              }}
            >
              {f.frameKind}#{i}
            </button>
          );
        })}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * usePipelinePlayhead.ts — Pipeline playhead hook for advancing through
 * stages and frames with configurable playback speed.
 */

export const STAGES = [
  'payload',
  'frame',
  'ecc',
  'symbols',
  'channels',
  'combined',
  'sync',
  'txout',
] as const;

export interface PlayheadState {
  frameIndex: number;
  stageIndex: number;
}

/**
 * Pure reducer: advances to next stage or wraps to next frame.
 * Stops at the final stage of the final frame.
 */
export function nextStage(
  state: PlayheadState,
  frameCount: number
): PlayheadState {
  const lastStageIndex = STAGES.length - 1;

  // If at last stage of last frame, stop (return same state)
  if (state.frameIndex === frameCount - 1 && state.stageIndex === lastStageIndex) {
    return state;
  }

  // If at last stage (but not last frame), wrap to next frame at stage 0
  if (state.stageIndex === lastStageIndex) {
    return { frameIndex: state.frameIndex + 1, stageIndex: 0 };
  }

  // Otherwise advance to next stage
  return { frameIndex: state.frameIndex, stageIndex: state.stageIndex + 1 };
}

export interface UsePipelinePlayheadReturn {
  frameIndex: number;
  stageIndex: number;
  playing: boolean;
  play: () => void;
  pause: () => void;
  step: () => void;
  reset: () => void;
  focusFrame: (index: number) => void;
}

/**
 * Hook for managing pipeline playhead state with auto-advance on speed.
 * @param run - Run object (expected to have frameCount property)
 * @param speed - 'realtime' (~180ms per stage), 'slow' (~900ms), or 'step' (manual)
 */
export function usePipelinePlayhead(
  run: { frameCount?: number } | null | undefined,
  speed: 'realtime' | 'slow' | 'step'
): UsePipelinePlayheadReturn {
  const [frameIndex, setFrameIndex] = useState(0);
  const [stageIndex, setStageIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Use refs to capture current state for interval callback
  const frameIndexRef = useRef(0);
  const stageIndexRef = useRef(0);

  // Keep refs in sync with state
  useEffect(() => {
    frameIndexRef.current = frameIndex;
  }, [frameIndex]);

  useEffect(() => {
    stageIndexRef.current = stageIndex;
  }, [stageIndex]);

  const getInterval = useCallback((): number | null => {
    if (speed === 'realtime') return 180;
    if (speed === 'slow') return 900;
    return null; // 'step' never auto-advances
  }, [speed]);

  // Auto-advance effect
  useEffect(() => {
    if (!playing) {
      return;
    }

    const interval = getInterval();
    if (interval === null) {
      // 'step' mode doesn't auto-advance
      return;
    }

    const frameCountVal = run?.frameCount ?? 1;

    const timerId = window.setInterval(() => {
      const newState = nextStage(
        {
          frameIndex: frameIndexRef.current,
          stageIndex: stageIndexRef.current,
        },
        frameCountVal
      );
      setFrameIndex(newState.frameIndex);
      setStageIndex(newState.stageIndex);
    }, interval);

    return () => {
      clearInterval(timerId);
    };
  }, [playing, speed, getInterval, run?.frameCount]);

  const play = useCallback(() => setPlaying(true), []);
  const pause = useCallback(() => setPlaying(false), []);

  const step = useCallback(() => {
    const frameCountVal = run?.frameCount ?? 1;
    const newState = nextStage(
      { frameIndex, stageIndex },
      frameCountVal
    );
    setFrameIndex(newState.frameIndex);
    setStageIndex(newState.stageIndex);
  }, [frameIndex, stageIndex, run?.frameCount]);

  const reset = useCallback(() => {
    setFrameIndex(0);
    setStageIndex(0);
  }, []);

  const focusFrame = useCallback((index: number) => {
    setFrameIndex(index);
    setStageIndex(0);
  }, []);

  return {
    frameIndex,
    stageIndex,
    playing,
    play,
    pause,
    step,
    reset,
    focusFrame,
  };
}

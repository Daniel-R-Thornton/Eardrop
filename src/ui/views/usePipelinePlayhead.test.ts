import { describe, it, expect } from 'vitest';
import { nextStage, STAGES } from './usePipelinePlayhead';

describe('nextStage', () => {
  it('advances stage then wraps to next frame', () => {
    const last = STAGES.length - 1;
    expect(nextStage({ frameIndex: 0, stageIndex: last }, 2)).toEqual({ frameIndex: 1, stageIndex: 0 });
  });
  it('stops at the final stage of the final frame', () => {
    const last = STAGES.length - 1;
    expect(nextStage({ frameIndex: 1, stageIndex: last }, 2)).toEqual({ frameIndex: 1, stageIndex: last });
  });
});

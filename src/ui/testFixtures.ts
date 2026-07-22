/**
 * testFixtures.ts — Hand-crafted fixture data for UI component tests and Storybook-free previews.
 * Provides a small sample Run with 2 frames (header, eof) for isolated testing.
 */

import type { Run, StageBundle, FrameField } from '../modem/protocol/captureTypes';

/**
 * Create a minimal fixture Run with 2 frames for testing the pipeline bench UI.
 * Each frame includes short tone waveforms and a valid frameFields array (235 bytes total).
 */
export function makeFixtureRun(): Run {
  const SAMPLE_RATE = 3200;
  const TONE_COUNT = 2;
  const SAMPLES_PER_TONE = 64;

  /**
   * Helper: Create a frame's tone waveforms (toneWaves, pilotWave, combined, preamble, txFinal).
   * All are short Float32Arrays suitable for testing.
   */
  function createWaveforms(
    frameIndex: number,
  ): {
    toneWaves: Float32Array[];
    pilotWave: Float32Array;
    combined: Float32Array;
    preamble: Float32Array;
    txFinal: Float32Array;
  } {
    // Each tone wave: 64 samples of mild sine
    const toneWaves = Array.from({ length: TONE_COUNT }, () =>
      new Float32Array(SAMPLES_PER_TONE).map((_, i) => {
        const phase = (i / SAMPLES_PER_TONE) * Math.PI * 2;
        return Math.sin(phase) * 0.3;
      }),
    );

    // Pilot: 64 samples
    const pilotWave = new Float32Array(SAMPLES_PER_TONE).map((_, i) => {
      const phase = (i / SAMPLES_PER_TONE) * Math.PI * 2;
      return Math.sin(phase * 2) * 0.2;
    });

    // Combined: sum of tone waves + pilot (mix all)
    const combined = new Float32Array(SAMPLES_PER_TONE);
    for (let i = 0; i < SAMPLES_PER_TONE; i++) {
      combined[i] = pilotWave[i];
      for (const tw of toneWaves) {
        combined[i] += tw[i];
      }
      combined[i] *= 0.3; // normalize to avoid clipping
    }

    // Preamble: empty for non-first frames, short for frame 0
    const preamble = frameIndex === 0 ? new Float32Array(SAMPLES_PER_TONE / 2) : new Float32Array(0);

    // txFinal: combined + preamble
    const txFinal = new Float32Array(preamble.length + combined.length);
    txFinal.set(preamble);
    txFinal.set(combined, preamble.length);

    return { toneWaves, pilotWave, combined, preamble, txFinal };
  }

  /**
   * Helper: Create the frameFields array summing to exactly 235 bytes.
   * Layout:
   *  - sentinel: offset 0, length 3
   *  - bch-header: offset 3, length 24
   *  - rs-payload: offset 27, length 208
   *  Total: 235 bytes
   */
  function createFrameFields(): FrameField[] {
    return [
      {
        name: 'sentinel',
        offset: 0,
        length: 3,
        bytes: new Array(3).fill(0),
      },
      {
        name: 'bch-header',
        offset: 3,
        length: 24,
        bytes: new Array(24).fill(0),
      },
      {
        name: 'rs-payload',
        offset: 27,
        length: 208,
        bytes: new Array(208).fill(0),
      },
    ];
  }

  /**
   * Helper: Create a single frame (StageBundle).
   */
  function createFrame(frameIndex: number, frameKind: 'header' | 'eof'): StageBundle {
    const waveforms = createWaveforms(frameIndex);

    return {
      frameKind,
      frameIndex,
      payloadBytes: [0x00, 0x01, 0x02],
      frameFields: createFrameFields(),
      eccBefore: new Array(16).fill(0),
      eccAfter: new Array(235).fill(0),
      eccScheme: 'bch3116+rs',
      correctionCapacity: 8,
      symbols: [
        { i: 0.5, q: 0.2 },
        { i: -0.3, q: 0.6 },
        { i: 0.1, q: -0.4 },
      ],
      toneWaves: waveforms.toneWaves,
      pilotWave: waveforms.pilotWave,
      combined: waveforms.combined,
      preamble: waveforms.preamble,
      txFinal: waveforms.txFinal,
      sampleRate: SAMPLE_RATE,
    };
  }

  // Create two frames: header and eof
  const frames: StageBundle[] = [
    createFrame(0, 'header'),
    createFrame(1, 'eof'),
  ];

  // Calculate totalSamples as sum of combined lengths across all frames
  const totalSamples = frames.reduce((sum, frame) => sum + frame.txFinal.length, 0);

  return {
    fileName: 'fixture.txt',
    totalSamples,
    sampleRate: SAMPLE_RATE,
    frames,
  };
}

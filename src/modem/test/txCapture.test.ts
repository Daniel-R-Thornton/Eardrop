import { describe, it, expect } from 'vitest';
import { captureTransmit } from '../protocol/txCapture';
import { DEFAULT_CONFIG } from '../types';
import { FRAME_SIZE, SENTINEL_SIZE, BCH_HEADER_SIZE } from '../protocol/atomicFrame';

describe('captureTransmit', () => {
  const cfg = { ...DEFAULT_CONFIG, useOFDM: false };
  const data = new TextEncoder().encode('EARDROP ✓ 2026');

  it('produces at least header + data + eof frames', () => {
    const run = captureTransmit(cfg, 'demo.txt', data);
    expect(run.frames.length).toBeGreaterThanOrEqual(3);
    expect(run.frames.map((f) => f.frameKind)).toContain('header');
    expect(run.frames.map((f) => f.frameKind)).toContain('eof');
  });

  it('each frame carries a full wire-frame field map summing to FRAME_SIZE', () => {
    const run = captureTransmit(cfg, 'demo.txt', data);
    for (const f of run.frames) {
      const total = f.frameFields.reduce((n, x) => n + x.length, 0);
      expect(total).toBe(FRAME_SIZE);
      expect(f.frameFields[0]).toMatchObject({ name: 'sentinel', offset: 0, length: SENTINEL_SIZE });
      expect(f.frameFields[1]).toMatchObject({ name: 'bch-header', offset: SENTINEL_SIZE, length: BCH_HEADER_SIZE });
    }
  });

  it('captures one tone wave per data tone plus a pilot and combined wave', () => {
    const run = captureTransmit(cfg, 'demo.txt', data);
    const f = run.frames[0];
    expect(f.toneWaves.length).toBe(cfg.toneCount);
    expect(f.pilotWave.length).toBeGreaterThan(0);
    expect(f.combined.length).toBe(f.toneWaves[0].length);
  });

  it('downsamples display buffers to <= 2048 points', () => {
    const run = captureTransmit(cfg, 'demo.txt', data);
    for (const f of run.frames) {
      expect(f.combined.length).toBeLessThanOrEqual(2048);
      expect(f.txFinal.length).toBeLessThanOrEqual(2048);
    }
  });
});

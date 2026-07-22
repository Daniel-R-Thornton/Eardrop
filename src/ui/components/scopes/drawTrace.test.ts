import { describe, it, expect, vi } from 'vitest';
import { drawWave } from './drawTrace';

describe('drawWave', () => {
  it('maps samples to a polyline within bounds', () => {
    const calls: [number, number][] = [];
    const ctx = {
      beginPath: vi.fn(), moveTo: (x: number, y: number) => calls.push([x, y]),
      lineTo: (x: number, y: number) => calls.push([x, y]), stroke: vi.fn(),
      set strokeStyle(_v: string) {}, set lineWidth(_v: number) {},
    } as unknown as CanvasRenderingContext2D;
    drawWave(ctx, 100, 40, new Float32Array([-1, 0, 1]), '#0f0');
    expect(calls.length).toBe(3);
    for (const [x, y] of calls) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(100); expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(40); }
  });
});

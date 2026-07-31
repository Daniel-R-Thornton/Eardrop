/**
 * coordinateDescent — the auto-tune hunt's search strategy.
 * Scored landscapes are hand-built so the expected local maximum is known.
 */
import { describe, expect, it } from 'vitest';
import { coordinateDescent, type DescentAxis } from './coordinateDescent';

interface P { x: number; y: number }

const xAxis: DescentAxis<P> = {
  name: 'x',
  values: [0, 1, 2, 3, 4, 5],
  get: (p) => p.x,
  set: (p, v) => ({ ...p, x: v }),
};
const yAxis: DescentAxis<P> = {
  name: 'y',
  values: [0, 1, 2, 3, 4, 5],
  get: (p) => p.y,
  set: (p, v) => ({ ...p, y: v }),
};

/** Separable peak at (4, 2) — coordinate descent should find it exactly. */
const peak = (p: P) => -Math.abs(p.x - 4) - Math.abs(p.y - 2);

it('walks a single axis to its local maximum, not just one step', async () => {
  const calls: number[] = [];
  const r = await coordinateDescent<P>({
    axes: [xAxis],
    start: { x: 0, y: 2 },
    budget: 50,
    evaluate: async (p) => { calls.push(p.x); return peak(p); },
  });
  expect(r.best.x).toBe(4);
  // Stepped 1,2,3,4 then probed 5 and stopped — a one-step-per-pass search
  // would have needed multiple passes to get here.
  expect(calls).toContain(5);
  expect(r.passes).toBeGreaterThanOrEqual(1);
});

it('finds the optimum across multiple axes and reports convergence', async () => {
  const r = await coordinateDescent<P>({
    axes: [xAxis, yAxis],
    start: { x: 0, y: 5 },
    budget: 100,
    evaluate: async (p) => peak(p),
  });
  expect(r.best).toEqual({ x: 4, y: 2 });
  expect(r.converged).toBe(true);
  expect(r.score).toBeCloseTo(0, 10);
});

it('costs far fewer evaluations than the full grid', async () => {
  const r = await coordinateDescent<P>({
    axes: [xAxis, yAxis],
    start: { x: 0, y: 5 },
    budget: 100,
    evaluate: async (p) => peak(p),
  });
  expect(r.evaluations).toBeLessThan(xAxis.values.length * yAxis.values.length);
});

it('stays put when the start is already a local maximum', async () => {
  let evaluations = 0;
  const r = await coordinateDescent<P>({
    axes: [xAxis, yAxis],
    start: { x: 4, y: 2 },
    budget: 100,
    evaluate: async (p) => { evaluations++; return peak(p); },
  });
  expect(r.best).toEqual({ x: 4, y: 2 });
  expect(r.converged).toBe(true);
  // Start + two probes per axis and nothing more.
  expect(evaluations).toBe(5);
});

it('never exceeds the evaluation budget', async () => {
  let evaluations = 0;
  const r = await coordinateDescent<P>({
    axes: [xAxis, yAxis],
    start: { x: 0, y: 0 },
    budget: 4,
    evaluate: async (p) => { evaluations++; return peak(p); },
  });
  expect(evaluations).toBeLessThanOrEqual(5); // budget is checked before each step
  expect(r.converged).toBe(false);
});

it('ignores single-valued axes', async () => {
  const fixed: DescentAxis<P> = { name: 'fixed', values: [7], get: (p) => p.y, set: (p, v) => ({ ...p, y: v }) };
  let evaluations = 0;
  const r = await coordinateDescent<P>({
    axes: [fixed],
    start: { x: 0, y: 7 },
    budget: 20,
    evaluate: async () => { evaluations++; return 0; },
  });
  // Only the initial evaluation happens — there is nothing to step to.
  expect(evaluations).toBe(1);
  expect(r.converged).toBe(true);
});

it('reports the axis it settled on, for progress logging', async () => {
  const settled: Array<[string, number]> = [];
  await coordinateDescent<P>({
    axes: [xAxis, yAxis],
    start: { x: 0, y: 5 },
    budget: 100,
    evaluate: async (p) => peak(p),
    onAxisSettled: (name, at) => settled.push([name, at]),
  });
  expect(settled.find(([n]) => n === 'x')?.[1]).toBe(4);
  expect(settled.find(([n]) => n === 'y')?.[1]).toBe(2);
});

describe('coupled variables (probeVariants)', () => {
  // Models the modem's qamBits/qamScale coupling: `order` only pays off at its
  // own matching `scale`, and the scale that suits order 0 is wrong for order 1.
  interface Q { order: number; scale: number }
  const best: Record<number, number> = { 0: 0, 1: 5, 2: 9 };
  // Score rises with order, but only when the scale matches that order's.
  const coupled = (p: Q) => (Math.abs(p.scale - best[p.order]) <= 1 ? p.order * 100 : -50);

  const orderAxis = (withVariants: boolean): DescentAxis<Q> => ({
    name: 'order',
    values: [0, 1, 2],
    get: (p) => p.order,
    set: (p, v) => ({ ...p, order: v }),
    ...(withVariants
      ? { probeVariants: (p, v) => [0, 3, 5, 7, 9].map((scale) => ({ ...p, order: v, scale })) }
      : {}),
  });

  it('without variants, a step up is rejected because the coupled value is stale', async () => {
    const r = await coordinateDescent<Q>({
      axes: [orderAxis(false)],
      start: { order: 0, scale: 0 },
      budget: 50,
      evaluate: async (p) => coupled(p),
    });
    // order 1 probed at scale 0 scores -50, so the climb refuses to leave 0.
    expect(r.best.order).toBe(0);
  });

  it('with variants, the step is judged at its own best coupled value', async () => {
    const r = await coordinateDescent<Q>({
      axes: [orderAxis(true)],
      start: { order: 0, scale: 0 },
      budget: 50,
      evaluate: async (p) => coupled(p),
    });
    expect(r.best.order).toBe(2);
    expect(r.best.scale).toBe(9);
    expect(r.score).toBe(200);
  });
});

describe('known limitation', () => {
  it('can stop at a local maximum and miss a better distant one', async () => {
    // Two humps along x: a small one at 1, a taller one at 5. Starting at 0
    // climbs the near hump and stops — documented behaviour, not a bug.
    const twoHumps = (p: P) => (p.x <= 2 ? 10 - Math.abs(p.x - 1) : 20 - Math.abs(p.x - 5) - 8);
    const r = await coordinateDescent<P>({
      axes: [xAxis],
      start: { x: 0, y: 0 },
      budget: 100,
      evaluate: async (p) => twoHumps(p),
    });
    expect(r.best.x).toBe(1);
  });
});

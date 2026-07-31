/**
 * coordinateDescent — generic compass/pattern search over discrete axes.
 *
 * Used by the modem auto-tune sweep to hunt for a working link configuration
 * instead of brute-forcing the full grid: probe one step either side of the
 * incumbent on one axis, and if a probe scores better, keep stepping that same
 * direction until it stops improving (the local maximum on that axis) before
 * moving to the next axis. Repeat passes until a whole pass moves nothing.
 *
 * Kept free of modem and DOM concepts so it can be unit-tested: the caller
 * supplies the axes and an async `evaluate` that scores one point.
 */

/** One searchable dimension: an ordered ladder of values, plus get/set on the point. */
export interface DescentAxis<P> {
  name: string;
  /** Ordered candidate values. Neighbours must be adjacent — the walk steps by index. */
  values: number[];
  get: (point: P) => number;
  set: (point: P, value: number) => P;
  /**
   * Optional: the candidate points to try when probing `value`, instead of the
   * single `set(point, value)`. The best-scoring one becomes the candidate.
   *
   * This exists for COUPLED variables, which plain coordinate descent handles
   * badly: if variable B is only meaningful at certain values of A, probing A
   * while B is stuck at the incumbent's (irrelevant, possibly absurd) setting
   * judges A on a config that was never worth testing. Expanding the probe lets
   * A be judged at its own best B.
   */
  probeVariants?: (point: P, value: number) => P[];
}

export interface DescentOptions<P> {
  axes: Array<DescentAxis<P>>;
  start: P;
  /** Score a point; higher is better. Must be deterministic per point for the walk to terminate. */
  evaluate: (point: P, axisName: string) => Promise<number>;
  /** Hard cap on evaluate() calls. Cached repeats do not count — the caller's cache decides. */
  budget: number;
  /** Max full passes over every axis (default 3). */
  maxPasses?: number;
  /** Called after each axis settles, for progress logging. */
  onAxisSettled?: (axisName: string, value: number, score: number) => void;
}

export interface DescentResult<P> {
  best: P;
  score: number;
  /** Number of evaluate() calls made. */
  evaluations: number;
  /** True if a full pass completed without moving — i.e. a local maximum on every axis. */
  converged: boolean;
  passes: number;
}

/**
 * Walk to a local maximum, one axis at a time.
 *
 * Note the limits, which are inherent to coordinate descent and not bugs:
 * it finds a LOCAL maximum, so a deceptive score landscape can trap it; and it
 * assumes `evaluate` is repeatable, so noisy measurements (a marginal acoustic
 * config winning a probe by luck) can anchor the rest of the climb.
 */
export async function coordinateDescent<P>(opts: DescentOptions<P>): Promise<DescentResult<P>> {
  const { axes, evaluate, budget, maxPasses = 3, onAxisSettled } = opts;
  let point = opts.start;
  let evaluations = 0;

  const score = async (p: P, axisName: string): Promise<number> => {
    evaluations++;
    return evaluate(p, axisName);
  };

  let best = await score(point, 'start');
  let converged = false;
  let passes = 0;
  // Running out of budget is not the same as finding a local maximum — without
  // this an exhausted search would claim it converged.
  let exhausted = false;

  const climbable = axes.filter((a) => a.values.length > 1);

  /**
   * Score one step along an axis, expanding coupled variants if the axis
   * declares them, and return the best variant with its score.
   */
  const probe = async (axis: DescentAxis<P>, from: P, value: number): Promise<{ point: P; score: number }> => {
    const variants = axis.probeVariants?.(from, value) ?? [axis.set(from, value)];
    let bestPoint = variants[0];
    let bestScore = -Infinity;
    for (const v of variants) {
      if (evaluations >= budget) { exhausted = true; break; }
      const s = await score(v, axis.name);
      if (s > bestScore) { bestScore = s; bestPoint = v; }
    }
    return { point: bestPoint, score: bestScore };
  };

  for (let pass = 1; pass <= maxPasses; pass++) {
    passes = pass;
    let moved = false;

    for (const axis of climbable) {
      if (evaluations >= budget) { exhausted = true; break; }
      let idx = axis.values.indexOf(axis.get(point));
      if (idx < 0) idx = 0;

      // Probe both neighbours; take the better one only if it beats the incumbent.
      let dir = 0;
      let bestIdx = idx;
      let bestScore = best;
      let bestPoint = point;
      for (const d of [-1, 1] as const) {
        if (evaluations >= budget) { exhausted = true; break; }
        const j = idx + d;
        if (j < 0 || j >= axis.values.length) continue;
        const p = await probe(axis, point, axis.values[j]);
        if (p.score > bestScore) { bestScore = p.score; bestIdx = j; bestPoint = p.point; dir = d; }
      }

      if (dir === 0) {
        onAxisSettled?.(axis.name, axis.values[idx], best);
        continue; // already a local max along this axis
      }

      idx = bestIdx;
      best = bestScore;
      point = bestPoint;
      moved = true;

      // Keep going the winning way until it stops paying off.
      for (;;) {
        if (evaluations >= budget) { exhausted = true; break; }
        const j = idx + dir;
        if (j < 0 || j >= axis.values.length) break;
        const p = await probe(axis, point, axis.values[j]);
        if (p.score <= best) break;
        idx = j;
        best = p.score;
        ({ point } = p);
      }

      onAxisSettled?.(axis.name, axis.values[idx], best);
    }

    if (exhausted) break;
    if (!moved) { converged = true; break; }
  }

  return { best: point, score: best, evaluations, converged, passes };
}

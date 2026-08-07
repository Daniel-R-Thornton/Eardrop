import { beforeEach, describe, expect, it } from 'vitest';
import { dlog, dlogReset, dlogSince, DLOG_RING_MAX } from './dlog';

describe('dlogSince', () => {
  beforeEach(() => dlogReset());

  it('returns lines emitted after the cursor, and a cursor that resumes', () => {
    dlog('T1', { a: 1 });
    dlog('T1', { a: 2 });
    const first = dlogSince(0);
    expect(first.lines).toHaveLength(2);

    dlog('T1', { a: 3 });
    const second = dlogSince(first.next);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toContain('a=3');
    expect(dlogSince(second.next).lines).toHaveLength(0);
  });

  it('clamps a cursor that predates lines the ring already evicted', () => {
    for (let i = 0; i < DLOG_RING_MAX + 20; i++) dlog('T1', { i });
    const { lines } = dlogSince(0);
    expect(lines).toHaveLength(DLOG_RING_MAX); // the 20 evicted lines are gone, not re-invented
  });

  it('reports how many lines the ring evicted before the cursor could read them', () => {
    // The evicted lines are unrecoverable, but a reader that is not TOLD they
    // existed reads a log with a hole in it as a complete one. That is how an
    // absent [TX-COMP] became "the sender never transmitted" — the tail of a
    // burst had simply been dropped between two 5 s pushes, and nothing in the
    // delivered rows said so.
    for (let i = 0; i < DLOG_RING_MAX + 20; i++) dlog('T1', { i });
    expect(dlogSince(0).dropped).toBe(20);
  });

  it('reports no drop when the cursor is still inside the ring', () => {
    for (let i = 0; i < 5; i++) dlog('T1', { i });
    expect(dlogSince(0).dropped).toBe(0);
    expect(dlogSince(dlogSince(0).next).dropped).toBe(0);
  });

  it('reports no drop for a cursor stranded past a dlogReset', () => {
    // Snapping a beyond-the-end cursor back to floor is a reset, not an
    // eviction — the generation stamp already tells that story, and a bogus
    // negative-turned-positive drop count here would cry wolf on every reset.
    for (let i = 0; i < 5; i++) dlog('T1', { i });
    const { next } = dlogSince(0);
    dlogReset();
    dlog('T1', { fresh: true });
    expect(dlogSince(next).dropped).toBe(0);
  });

  it('clamps a cursor from before a dlogReset instead of stalling forever', () => {
    for (let i = 0; i < 5; i++) dlog('T1', { i });
    const { next } = dlogSince(0);
    dlogReset();
    dlog('T1', { fresh: true });
    // Old cursor is now beyond totalEmitted. Adopting `next` must converge on
    // the fresh line within one further call rather than returning empty forever.
    const after = dlogSince(next);
    const recovered = dlogSince(after.next);
    expect([...after.lines, ...recovered.lines].join('\n')).toContain('fresh=true');
  });

  it('reports a new generation after dlogReset even when the new run is longer than the cursor', () => {
    // The reset case the seq>totalEmitted clamp CANNOT see: app.ts resets per
    // speed-test trial, and if the next trial emits at least as many lines as
    // the last cursor, seq <= totalEmitted and the clamp reads it as "already
    // caught up" — silently dropping the whole trial. Only a generation stamp
    // distinguishes "caught up" from "different ring".
    for (let i = 0; i < 10; i++) dlog('T1', { i });
    const first = dlogSince(0);
    expect(first.lines).toHaveLength(10);

    dlogReset();
    for (let i = 0; i < 10; i++) dlog('T2', { i });

    const after = dlogSince(first.next);
    expect(after.generation).not.toBe(first.generation);
    // And a reader that restarts at 0 on a generation change sees the new run.
    expect(dlogSince(0).lines.join('\n')).toContain('i=9');
  });
});

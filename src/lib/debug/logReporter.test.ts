// src/lib/debug/logReporter.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dlog, dlogReset, DLOG_RING_MAX } from './dlog';
import {
  flushLogReporter, logReporterEnabled, onLogReporterChange, startLogReporter, stopLogReporter,
} from './logReporter';

/** fetch stub: GET probe → probeStatus; POST → shift the next scripted status. */
function makeFetch(probeStatus: number, postStatuses: number[]) {
  const posts: { rows: string[] }[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (!init || init.method !== 'POST') return new Response(null, { status: probeStatus });
    posts.push(JSON.parse(String(init.body)));
    return new Response(null, { status: postStatuses.shift() ?? 204 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, posts };
}

const settle = async () => { await vi.runOnlyPendingTimersAsync(); };

describe('logReporter', () => {
  beforeEach(() => { vi.useFakeTimers(); dlogReset(); });
  afterEach(() => { stopLogReporter(); vi.useRealTimers(); });

  it('stays permanently off when the probe fails (the Pages case)', async () => {
    const { fetchFn, posts } = makeFetch(404, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    expect(logReporterEnabled()).toBe(false);
    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(posts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0); // no tick was ever armed
  });

  it('pushes each new line exactly once across ticks', async () => {
    const { fetchFn, posts } = makeFetch(204, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    expect(logReporterEnabled()).toBe(true);

    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    dlog('T', { x: 2 });
    dlog('T', { x: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000); // nothing new: no third POST

    expect(posts).toHaveLength(2);
    expect(posts[0].rows.join()).toContain('x=1');
    expect(posts[1].rows).toHaveLength(2);
  });

  it('marks the gap when a burst outran the ring between two ticks', async () => {
    // A phone mid-transfer emits far more than DLOG_RING_MAX lines in one 5 s
    // window. Those lines are unrecoverable, but delivering the survivors with
    // no marker hands back a log that READS complete — which is how an absent
    // [TX-COMP] was taken as proof the sender never transmitted.
    const { fetchFn, posts } = makeFetch(204, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { first: 1 });
    await vi.advanceTimersByTimeAsync(5000);

    for (let i = 0; i < DLOG_RING_MAX + 20; i++) dlog('T', { i });
    await vi.advanceTimersByTimeAsync(5000);

    const { rows } = posts[1];
    // 1 line already delivered + 520 new = 521 emitted; the ring keeps the last
    // 500, so lines 2..21 (20 of them) were evicted before this tick read them.
    expect(rows[0]).toContain('linesDropped=20');
    expect(rows).toHaveLength(DLOG_RING_MAX + 1); // marker + everything that survived
  });

  it('does not mark a gap on an ordinary tick', async () => {
    const { fetchFn, posts } = makeFetch(204, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts[0].rows.join()).not.toContain('linesDropped');
  });

  it('keeps the cursor on a failed POST and re-sends those lines next tick', async () => {
    const { fetchFn, posts } = makeFetch(204, [500, 204]);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(5000); // 500
    await vi.advanceTimersByTimeAsync(5000); // retry, 204
    expect(posts).toHaveLength(2);
    expect(posts[1].rows.join()).toContain('x=1');
  });

  it('backs off to 30 s after 3 consecutive failures, recovers on success', async () => {
    const { fetchFn, posts } = makeFetch(204, [500, 500, 500, 204]);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(15000); // 3 ticks, 3 failures
    expect(posts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5000); // inside backoff: nothing
    expect(posts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(25000); // backoff expires → 4th push, 204
    expect(posts).toHaveLength(4);
  });

  it('flushLogReporter pushes immediately', async () => {
    const { fetchFn, posts } = makeFetch(204, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { x: 1 });
    await flushLogReporter();
    expect(posts).toHaveLength(1);
  });

  it('a flush that arrives while a tick push is still in flight does not double the timer or duplicate rows', async () => {
    const posts: { rows: string[] }[] = [];
    let resolvePost: ((res: Response) => void) | undefined;
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return new Response(null, { status: 204 });
      posts.push(JSON.parse(String(init.body)));
      // Never resolves on its own — the test controls exactly when the
      // in-flight POST completes, so it can land a flush mid-request.
      return new Promise<Response>((resolve) => { resolvePost = resolve; });
    });
    startLogReporter({ device: 'd', fetchFn: fetchFn as unknown as typeof fetch });
    await settle();

    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(5000); // tick fires; POST is now pending
    expect(posts).toHaveLength(1);

    // Flush arrives while that POST is still in flight (e.g. a double-tap of
    // the panel button, or the panel button during a live tick).
    const flushPromise = flushLogReporter();
    await Promise.resolve(); // let flushLogReporter's synchronous prefix run
    expect(posts).toHaveLength(1); // must join the in-flight push, not start a second

    if (resolvePost) resolvePost(new Response(null, { status: 204 }));
    await flushPromise;
    await settle();

    expect(posts).toHaveLength(1); // the same row never went out twice
    expect(vi.getTimerCount()).toBe(1); // exactly one live timer remains armed
  });

  it('stays permanently off when the probe answers 200 with an SPA fallback page', async () => {
    // `npm run preview` (and any static host with an index.html fallback)
    // answers GET /api/log with 200 index.html. Accepting that would light the
    // "PC: connected" chip and advance the cursor while nothing reaches disk —
    // the worst outcome for a debug tool. Only the endpoint's own 204 counts.
    const { fetchFn, posts } = makeFetch(200, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    expect(logReporterEnabled()).toBe(false);
    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(posts).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(flushLogReporter()).resolves.toBe(false); // manual send stays inert too
    expect(posts).toHaveLength(0);
  });

  it('treats a 200 POST reply as a failure and re-sends those lines', async () => {
    const { fetchFn, posts } = makeFetch(204, [200, 204]);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(5000); // 200 = not our endpoint: a failure
    await vi.advanceTimersByTimeAsync(5000); // retry, 204
    expect(posts).toHaveLength(2);
    expect(posts[1].rows.join()).toContain('x=1');
  });

  it('re-sends a whole fresh ring after a mid-session dlogReset', async () => {
    // app.ts calls dlogReset() per speed-test trial. If the new trial emits at
    // least as many lines as the old cursor, the cursor is <= totalEmitted and
    // looks "caught up" — the exact run being debugged would be dropped.
    const { fetchFn, posts } = makeFetch(204, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    for (let i = 0; i < 3; i++) dlog('T', { trial1: i });
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts).toHaveLength(1);

    dlogReset();
    for (let i = 0; i < 3; i++) dlog('T', { trial2: i });
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts).toHaveLength(2);
    expect(posts[1].rows).toHaveLength(3);
    expect(posts[1].rows.join()).toContain('trial2=2');
  });

  it('flushLogReporter reports whether the push actually landed', async () => {
    const { fetchFn } = makeFetch(204, [500]);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { x: 1 });
    await expect(flushLogReporter()).resolves.toBe(false); // POST 500
    await expect(flushLogReporter()).resolves.toBe(true); // retry, 204
  });

  it('abandons a POST that never settles instead of wedging the reporter forever', async () => {
    // Pushes are coalesced through one in-flight promise, so a fetch that
    // never settles would block every later tick AND the manual button.
    vi.useRealTimers();
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return new Response(null, { status: 204 });
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    startLogReporter({
      device: 'd', fetchFn: fetchFn as unknown as typeof fetch, intervalMs: 60000, timeoutMs: 20,
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    dlog('T', { x: 1 });
    await expect(flushLogReporter()).resolves.toBe(false);
    // Not wedged: a second flush runs rather than joining a dead promise.
    await expect(flushLogReporter()).resolves.toBe(false);
    expect(fetchFn.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST'))
      .toHaveLength(2);
  });

  it('a throwing subscriber does not kill the reporter or propagate out of flushLogReporter', async () => {
    const { fetchFn, posts } = makeFetch(204, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    onLogReporterChange(() => { throw new Error('boom'); });

    dlog('T', { x: 1 });
    await expect(flushLogReporter()).resolves.toBe(true); // resolved, not thrown
    expect(posts).toHaveLength(1);
    expect(logReporterEnabled()).toBe(true);

    dlog('T', { x: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts).toHaveLength(2);
  });

  it('a throwing subscriber registered before the probe resolves does not leave the reporter enabled-but-unarmed', async () => {
    const { fetchFn, posts } = makeFetch(204, []);
    onLogReporterChange(() => { throw new Error('boom'); });
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    expect(logReporterEnabled()).toBe(true);

    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts).toHaveLength(1);
  });
});

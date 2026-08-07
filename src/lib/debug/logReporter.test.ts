// src/lib/debug/logReporter.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dlog, dlogReset } from './dlog';
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

  it('a throwing subscriber does not kill the reporter or propagate out of flushLogReporter', async () => {
    const { fetchFn, posts } = makeFetch(204, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    onLogReporterChange(() => { throw new Error('boom'); });

    dlog('T', { x: 1 });
    await expect(flushLogReporter()).resolves.toBeUndefined();
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

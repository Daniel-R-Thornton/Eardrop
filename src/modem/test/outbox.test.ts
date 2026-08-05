import { describe, expect, it } from 'vitest';
import { Outbox, type OutboxEntry } from '../chatter/outbox';
import { ControlType, type ControlMessage } from '../protocol/controlFrame';

function makeHarness(opts: { busy?: () => boolean; canTransmit?: () => boolean } = {}) {
  let t = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const sent: ControlMessage[] = [];
  const events: string[] = [];
  const outbox = new Outbox({
    now: () => t,
    rng: () => 0,
    schedule: (fn, d) => {
      const rec = { at: t + d, fn, dead: false };
      timers.push(rec);
      return () => { rec.dead = true; };
    },
    isAirBusy: async () => opts.busy?.() ?? false,
    sendMessage: async (m) => { sent.push(m); },
    canTransmit: () => opts.canTransmit?.() ?? true,
    replySlots: 6,
    replySlotMs: 300,
    onSent: (e: OutboxEntry) => events.push(`sent:${e.kind}:${e.id}`),
    onFailed: (e: OutboxEntry) => events.push(`failed:${e.kind}:${e.id}`),
  });
  const tick = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    t = end;
  };
  return { outbox, tick, sent, events };
}

const textMsg = (targetId: number): ControlMessage => ({
  type: ControlType.Text, senderId: 1, targetId, payload: new Uint8Array([0]),
});

describe('outbox', () => {
  it('sends a queued entry on drain', async () => {
    const h = makeHarness();
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(1);
    expect(h.events).toContain('sent:text:1');
    expect(h.outbox.size).toBe(0);
  });

  it('dedupes by dedupKey while an entry is unsent', async () => {
    const h = makeHarness();
    const a = h.outbox.enqueue({ kind: 'ack', targetId: 5, dedupKey: 'ack:5:9', build: () => textMsg(5) });
    const b = h.outbox.enqueue({ kind: 'ack', targetId: 5, dedupKey: 'ack:5:9', build: () => textMsg(5) });
    expect(b).toBe(a);
    expect(h.outbox.size).toBe(1);
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(1);
  });

  it('does not send while the transmitter is unavailable, and sends once it frees', async () => {
    let free = false;
    const h = makeHarness({ canTransmit: () => free });
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    await h.tick(2000);
    expect(h.sent).toHaveLength(0);
    expect(h.outbox.size).toBe(1); // held, not dropped

    free = true;
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(1);
  });

  it('holds an entry whose slot fires after the transmitter became unavailable', async () => {
    // The hold-don't-drop path INSIDE the timer callback — dropping here was
    // the original reply bug in a new costume.
    let free = true;
    const h = makeHarness({ canTransmit: () => free });
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    free = false;
    await h.tick(2000);
    expect(h.sent).toHaveLength(0);
    expect(h.outbox.size).toBe(1);

    free = true;
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(1);
  });

  it('re-rolls among later slots while the air is busy', async () => {
    let busy = true;
    const h = makeHarness({ busy: () => busy });
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(0);
    busy = false;
    await h.tick(6 * 300);
    expect(h.sent).toHaveLength(1);
  });

  it('gives up and reports failure when every slot was busy', async () => {
    const h = makeHarness({ busy: () => true });
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    await h.tick(6 * 300 + 500);
    expect(h.sent).toHaveLength(0);
    expect(h.events).toContain('failed:text:1');
    expect(h.outbox.size).toBe(0);
  });

  it('reports failure when sendMessage throws', async () => {
    let t = 0;
    const timers: { at: number; fn: () => void; dead: boolean }[] = [];
    const events: string[] = [];
    const outbox = new Outbox({
      now: () => t,
      rng: () => 0,
      schedule: (fn, d) => {
        const rec = { at: t + d, fn, dead: false };
        timers.push(rec);
        return () => { rec.dead = true; };
      },
      isAirBusy: async () => false,
      sendMessage: async () => { throw new Error('audio glitch'); },
      canTransmit: () => true,
      replySlots: 6,
      replySlotMs: 300,
      onFailed: (e, err) => events.push(`failed:${e.kind}:${(err as Error).message}`),
    });
    outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    outbox.drain();
    for (;;) {
      const due = timers.filter((x) => !x.dead).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    expect(events).toContain('failed:text:audio glitch');
    expect(outbox.size).toBe(0);
  });

  it('clear() empties the queue and nothing fires afterwards', async () => {
    const h = makeHarness();
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    h.outbox.clear();
    expect(h.outbox.size).toBe(0);
    await h.tick(5000);
    expect(h.sent).toHaveLength(0);
  });

  it('a stale send does not delete a newer entry with the same dedupKey', async () => {
    // The identity-guard the predecessor branch had to add: a send is seconds
    // of audio, and clear()+re-enqueue during it must not be discarded by the
    // old closure completing.
    let release: (() => void) | undefined;
    let t = 0;
    const timers: { at: number; fn: () => void; dead: boolean }[] = [];
    const outbox = new Outbox({
      now: () => t,
      rng: () => 0,
      schedule: (fn, d) => {
        const rec = { at: t + d, fn, dead: false };
        timers.push(rec);
        return () => { rec.dead = true; };
      },
      isAirBusy: async () => false,
      sendMessage: () => new Promise<void>((res) => { release = res; }),
      canTransmit: () => true,
      replySlots: 6,
      replySlotMs: 300,
    });
    outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    outbox.drain();
    const fire = async () => {
      const due = timers.filter((x) => !x.dead).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      t = due.at; due.dead = true; due.fn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    await fire(); // now suspended inside sendMessage

    outbox.clear();
    const freshId = outbox.enqueue({
      kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0),
    });
    release!();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(outbox.size).toBe(1);
    expect(outbox.has('text:1')).toBe(true);
    expect(freshId).not.toBe(0);
  });
});

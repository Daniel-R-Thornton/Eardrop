import { describe, expect, it } from 'vitest';
import { Outbox, type OutboxEntry } from '../chatter/outbox';
import { ControlType, type ControlMessage } from '../protocol/controlFrame';

function makeHarness(opts: {
  busy?: () => boolean;
  canTransmit?: () => boolean;
  /** Dead time before slot 0. Defaults to 0 so the tests below measure SLOT
   *  behaviour on its own; the turnaround has its own test, and that the real
   *  ROOM_TIMING value reaches this dep is asserted in roomProtocol.test.ts. */
  turnaroundMs?: number;
  rng?: () => number;
} = {}) {
  let t = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const sent: ControlMessage[] = [];
  const events: string[] = [];
  const outbox = new Outbox({
    now: () => t,
    rng: opts.rng ?? (() => 0),
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
    turnaroundMs: opts.turnaroundMs ?? 0,
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
  it('holds every entry until the turnaround has passed', async () => {
    // An owed reply is queued the instant the transmission it answers finishes
    // decoding — which is the instant that transmission ENDED. Drawing slot 0
    // from zero therefore meant "start talking the moment they stop", while
    // the peer being answered is still muted for its own playback, about to
    // re-arm, and sitting in its own reverb. Our sync chirp landed there.
    const h = makeHarness({ turnaroundMs: 500 });
    h.outbox.enqueue({ kind: 'reply', targetId: 3, dedupKey: 'reply:3', build: () => textMsg(3) });
    h.outbox.drain();

    await h.tick(450);
    expect(h.sent, 'silent through the turnaround').toHaveLength(0);

    await h.tick(200); // past 500 ms, into slot 0
    expect(h.sent).toHaveLength(1);
  });

  it('offsets every slot by the turnaround, not just the first', async () => {
    // rng picks an index into the remaining slots; 0.99 lands on the last one,
    // which must sit at turnaround + 5 * slotMs rather than 5 * slotMs.
    const h = makeHarness({ turnaroundMs: 500, rng: () => 0.99 });
    h.outbox.enqueue({ kind: 'reply', targetId: 3, dedupKey: 'reply:3', build: () => textMsg(3) });
    h.outbox.drain();

    await h.tick(500 + 5 * 300 - 50);
    expect(h.sent).toHaveLength(0);
    await h.tick(100);
    expect(h.sent).toHaveLength(1);
  });

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
      turnaroundMs: 0,
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
    // A send is seconds of audio, and a clear()+re-enqueue during it must not
    // be discarded by the old closure completing.
    //
    // Note what this does NOT prove. `nextId` is monotonic and survives
    // clear(), so the stale closure's id (1) can never be reoccupied by the
    // fresh entry (2): replacing the guarded delete with a plain
    // `entries.delete(entry.id)` leaves this green, because deleting 1 is a
    // no-op. The guard is still right — it is what makes "a stale closure
    // cannot reach a live entry" true rather than incidental — but the half
    // that a bypass would actually break is the onSent gate below.
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
      turnaroundMs: 0,
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

  it('does not call onSent for a send that resolves after clear()', async () => {
    // The load-bearing half of the identity guard, and the only test that
    // fails if onSent escapes it.
    //
    // onSent is where the owner arms follow-up work. A send that resolves after
    // the owner tore its room down must arm nothing: in roomProtocol an escaped
    // onSent here sets awaitingAck for a peer and starts a retry timer, and one
    // slot window later a freshly rejoined session transmits ~3 s of
    // unsolicited WELCOME to a peer that never probed it — from joinWait, which
    // is transmit-eligible, so possibly straight into another device's collect
    // window. Nothing errors; the room just talks over someone.
    let release: (() => void) | undefined;
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
      sendMessage: () => new Promise<void>((res) => { release = res; }),
      canTransmit: () => true,
      replySlots: 6,
      replySlotMs: 300,
      turnaroundMs: 0,
      onSent: (e: OutboxEntry) => events.push(`sent:${e.kind}:${e.id}`),
      onFailed: (e: OutboxEntry) => events.push(`failed:${e.kind}:${e.id}`),
    });
    outbox.enqueue({ kind: 'reply', targetId: 9, dedupKey: 'reply:9', build: () => textMsg(9) });
    outbox.drain();

    const due = timers.filter((x) => !x.dead).sort((a, b) => a.at - b.at)[0];
    t = due.at; due.dead = true; due.fn();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    // Suspended inside sendMessage, mid-transmission.
    expect(release).toBeDefined();
    expect(events).toEqual([]);

    // The room is torn down while the audio is still playing out.
    outbox.clear();
    release!();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(events).toEqual([]); // nothing armed for a room that no longer exists
    expect(outbox.size).toBe(0);
  });
});

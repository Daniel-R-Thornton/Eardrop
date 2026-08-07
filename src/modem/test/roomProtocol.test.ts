import { describe, expect, it } from 'vitest';
import { RoomProtocol, ROOM_TIMING, ROOM_STALL_MS, BAND_CACHE_TTL_MS } from '../chatter/roomProtocol';
import {
  ControlType, packReport, packWelcome, packFileComing,
  packText, packAck, parseText, parseAck, TEXT_MAX_BYTES,
} from '../protocol/controlFrame';
import { PROBE_PURPOSE } from '../protocol/probeBurst';

/** Manual clock + timer wheel so every test is deterministic. */
function makeHarness(
  deviceId: number,
  opts: {
    busy?: () => boolean;
    playProbe?: () => Promise<void>;
    rng?: () => number;
    isAirBusy?: () => Promise<boolean>;
    sendMessage?: (m: any) => Promise<void>;
  } = {},
) {
  let t = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const sent: any[] = [];
  const calls: string[] = [];
  const textReceived: any[] = [];
  const textAcked: any[] = [];
  const textStates: any[] = [];
  const deps = {
    deviceId,
    now: () => t,
    rng: opts.rng ?? (() => 0), // slot 0 always — collisions forced by `busy`
    schedule: (fn: () => void, d: number) => {
      const rec = { at: t + d, fn, dead: false };
      timers.push(rec);
      return () => { rec.dead = true; };
    },
    playProbe: opts.playProbe ?? (async () => { calls.push('probe'); }),
    sendMessage: opts.sendMessage ?? (async (m: any) => { sent.push(m); }),
    isAirBusy: opts.isAirBusy ?? (async () => opts.busy?.() ?? false),
    startFileTx: () => calls.push('fileTx'),
    armFileRx: () => calls.push('fileRx'),
    onTextReceived: (msg: any) => textReceived.push(msg),
    onTextAcked: (msgId: number, byDeviceId: number) => textAcked.push({ msgId, by: byDeviceId }),
    onTextStateChange: (msgId: number, state: string, ackedBy: number[]) => textStates.push({ msgId, state, ackedBy }),
  };
  const room = new RoomProtocol(deps as any);
  /** advance the clock, firing due timers in order */
  const tick = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
      // Drain generously. A timer callback can chain several awaits before it
      // registers its own follow-up timer — sendFileComingAndTransmit now
      // awaits isAirBusy AND sendMessage before arming fileComingLeadMs — and
      // each `await asyncFn()` costs two microtask turns. Too few drains here
      // and the follow-up timer simply isn't registered yet when the loop looks
      // for the next due one, so the chain silently stalls mid-tick.
      for (let k = 0; k < 8; k++) await Promise.resolve();
    }
    t = end;
  };
  return {
    room, tick, sent, calls, textReceived, textAcked, textStates,
  };
}

/** How long until an owed reply has certainly gone out: the dead time before
 *  slot 0 plus the whole slot span. Every `tick` that waits for a reply uses
 *  this, so adding a turnaround does not mean editing sixty call sites. */
const REPLY_SPAN = ROOM_TIMING.replyTurnaroundMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs;

/** When the earliest slot actually fires: the turnaround, then slot 0. */
const SLOT_0 = ROOM_TIMING.replyTurnaroundMs + ROOM_TIMING.replySlotMs;

const flatGrid = Array.from({ length: 64 }, () => 1);

/**
 * The reply queue lives in the Outbox now (see outbox.ts), keyed on a
 * monotonic entry id rather than on the prober — a TEXT broadcast is not keyed
 * by a peer. `reply:<proberId>` is the dedup key that restores the old
 * one-chain-per-peer rule, so these two stand in for what used to be
 * `(room as any).replyQueue.get(id)` and `.size`.
 */
const queuedReply = (room: any, proberId: number): any => room.outbox.peek(`reply:${proberId}`);
const replyQueueSize = (room: any): number => room.outbox.size;

describe('room protocol', () => {
  it('joins an empty room: listen → announce → joinWait → idle', async () => {
    const h = makeHarness(1);
    h.room.start();
    expect(h.room.state).toBe('listening');
    await h.tick(ROOM_TIMING.listenMs + 50);
    expect(h.calls).toContain('probe');
    await h.tick(REPLY_SPAN + ROOM_TIMING.collectExtraMs + 100);
    expect(h.room.state).toBe('idle');
    expect(h.room.members.size).toBe(0);
  });

  it('member replies WELCOME when it hears a probe', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.onProbeHeard(9, flatGrid);
    await h.tick(SLOT_0 + 100); // slot 0 fires
    const welcome = h.sent.find((m) => m.type === ControlType.Welcome);
    expect(welcome).toBeDefined();
    expect(welcome.targetId).toBe(9);
    expect(h.room.members.get(9)).toBeDefined();
  });

  it('re-rolls the reply slot when the air is busy', async () => {
    let busy = true;
    const h = makeHarness(2, { busy: () => busy });
    h.room.start();
    // air busy: listening extends, then cap forces announce
    await h.tick(ROOM_TIMING.listenCapMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 500);
    expect(h.room.state).toBe('idle');
    h.room.onProbeHeard(9, flatGrid);
    await h.tick(SLOT_0 + 50); // slot 0 blocked
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
    busy = false;
    await h.tick(REPLY_SPAN);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('roll call with one report → FILE_COMING + startFileTx', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + 100); // carrier-sense + probe
    h.room.onMessage({ type: ControlType.Report, senderId: 5, targetId: 1, payload: packReport(flatGrid) });
    await h.tick(REPLY_SPAN + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
    expect(h.sent.some((m) => m.type === ControlType.FileComing)).toBe(true);
    expect(h.calls).toContain('fileTx');
    expect(h.room.state).toBe('sending');
  });

  it('roll call counts a WELCOME reply as a report', async () => {
    // A peer whose member table lost us answers a roll call with WELCOME
    // instead of REPORT (the reply type is inferred from whether it knows the
    // prober). Its payload carries the same measured grid, so the roll call
    // must accept it — otherwise a peer that is audibly replying reads as
    // "nobody home", which is what happened on hardware.
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + 100); // carrier-sense + probe
    h.room.onMessage({
      type: ControlType.Welcome,
      senderId: 5,
      targetId: 1,
      payload: packWelcome({ claim: { lowHz: 1500, highHz: 7800, maxQamOrder: 6 }, grid: flatGrid }),
    });
    await h.tick(REPLY_SPAN + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
    expect(h.room.lastError).toBeNull();
    expect(h.sent.some((m) => m.type === ControlType.FileComing)).toBe(true);
    expect(h.calls).toContain('fileTx');
  });

  it('roll call with zero reports aborts to idle with lastError', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 500);
    expect(h.calls).not.toContain('fileTx');
    expect(h.room.state).toBe('idle');
    expect(h.room.lastError).toMatch(/no.*report|nobody/i);
  });

  it('ignores a FILE_COMING addressed to someone else', async () => {
    // Everyone in earshot demodulates the announcement; only the addressee
    // acts. Without this a bystander arms its receiver and sits in
    // 'receiving' for the whole transfer, deaf to the room, for a file it
    // will never assemble.
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.FileComing, senderId: 8, targetId: 9, // not us (3)
      payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
    });
    expect(h.calls).not.toContain('fileRx');
    expect(h.room.state).toBe('idle');
  });

  it('an addressed roll call negotiates against the addressee alone', async () => {
    // A report from a device that is not the recipient must not drag the
    // settings down — it is not receiving this transfer.
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000, 5); // addressed to 5
    await h.tick(ROOM_TIMING.listenMs + 100);
    // Only a bystander answers.
    h.room.onMessage({ type: ControlType.Report, senderId: 7, targetId: 1, payload: packReport(flatGrid) });
    await h.tick(REPLY_SPAN + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
    expect(h.calls).not.toContain('fileTx');
    expect(h.room.lastError).toMatch(/not reachable/);
  });

  it('an addressed FILE_COMING carries the target id', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000, 5);
    await h.tick(ROOM_TIMING.listenMs + 100);
    h.room.onMessage({ type: ControlType.Report, senderId: 5, targetId: 1, payload: packReport(flatGrid) });
    await h.tick(REPLY_SPAN + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
    const fc = h.sent.find((m) => m.type === ControlType.FileComing);
    expect(fc).toBeDefined();
    expect(fc.targetId).toBe(5);
    expect(h.calls).toContain('fileTx');
  });

  it('FILE_COMING while idle arms RX and times back out to idle', async () => {
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.FileComing, senderId: 8, targetId: 0,
      payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
    });
    expect(h.calls).toContain('fileRx');
    expect(h.room.state).toBe('receiving');
    await h.tick(2000 + 5000 + 100);
    expect(h.room.state).toBe('idle');
  });

  it('stop() from any state cancels timers and goes cold', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 10);
    h.room.stop();
    expect(h.room.state).toBe('cold');
    await h.tick(60000); // nothing should fire/throw
    expect(h.room.state).toBe('cold');
  });

  it('a rejected playProbe during join is caught and routes to cold with lastError (no unhandled rejection)', async () => {
    const h = makeHarness(1, { playProbe: async () => { throw new Error('audio glitch'); } });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 100);
    expect(h.room.state).toBe('cold');
    expect(h.room.lastError).toMatch(/audio glitch/);
  });

  it('a rejected playProbe during a roll call is caught and routes to idle with lastError', async () => {
    // First playProbe (join's announce) succeeds so the room reaches idle;
    // the second (the roll call's own announce) rejects, exercising the
    // 'rollCall' -> idle branch of the same catch as the join test above.
    let probeCalls = 0;
    const h = makeHarness(1, {
      playProbe: async () => {
        probeCalls += 1;
        if (probeCalls > 1) throw new Error('audio glitch');
      },
    });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.state).toBe('idle');

    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + 100);
    expect(h.room.state).toBe('idle');
    expect(h.room.lastError).toMatch(/audio glitch/);
  });

  it('a REPORT received while in joinWait refreshes the member but is not counted toward roll call', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 50);
    expect(h.room.state).toBe('joinWait'); // rejoin gap: still pre-idle when the REPORT arrives

    h.room.onMessage({ type: ControlType.Report, senderId: 5, targetId: 2, payload: packReport(flatGrid) });

    const member = h.room.members.get(5);
    expect(member).toBeDefined();
    expect(member?.lastHeardMs).toBe(ROOM_TIMING.listenMs + 50);
    expect(member?.theirViewOfUs).toEqual(flatGrid);
    // Must be a member refresh only — never fed to the roll-call collection
    // that pickSettings later reads from.
    expect((h.room as any).collectedReports.size).toBe(0);

    await h.tick(REPLY_SPAN + ROOM_TIMING.collectExtraMs + 100);
    expect(h.room.state).toBe('idle');
  });

  it('onProbeHeard twice for the same prober while idle only schedules one WELCOME chain', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.onProbeHeard(9, flatGrid);
    h.room.onProbeHeard(9, flatGrid); // duplicate, same prober, reply chain already pending
    // Measured over a window shorter than one slot window: the retry arms
    // only after the first WELCOME actually sends, so this still isolates
    // "one chain per prober" from the retry behaviour covered separately
    // below (a window covering a full slot window would let a retry fire
    // too, which is correct but not what this test is checking).
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('replies to a probe heard while in joinWait', async () => {
    // The bug this covers: reply duty used to exist only in 'idle'. Two
    // devices joining within a few seconds of each other are BOTH in joinWait
    // when the other's probe lands, so each recorded the other and neither
    // welcomed — both then declared an empty room.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 50);
    expect(h.room.state).toBe('joinWait');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(SLOT_0 + 100);

    const welcome = h.sent.find((m) => m.type === ControlType.Welcome);
    expect(welcome).toBeDefined();
    expect(welcome.targetId).toBe(9);
  });

  it('holds a probe heard while listening and replies once the transmitter frees up', async () => {
    // 'listening' precedes drainReplyQueue ever registering a timer for this
    // entry — canTransmitReply() is false at the top of drainReplyQueue, so
    // the entry sits queued (scheduled: false) with no chain in flight until
    // a later setState (into joinWait) drains it. This is the queuing half of
    // the fix; the in-timer HOLD branch is covered separately below.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs - 10);
    expect(h.room.state).toBe('listening');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);

    // A window shorter than one slot window after the send: long enough to
    // catch listening finish through the (slot-0, rng fixed to 0) send, short
    // of the Task-4 retry that arms one slot window after it.
    await h.tick(SLOT_0 + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('two devices in joinWait each welcome the other', async () => {
    // The reported symptom, as a test: neither device is idle, both hear the
    // other, both must welcome.
    const a = makeHarness(1);
    const b = makeHarness(2);
    a.room.start();
    b.room.start();
    await a.tick(ROOM_TIMING.listenMs + 50);
    await b.tick(ROOM_TIMING.listenMs + 50);
    expect(a.room.state).toBe('joinWait');
    expect(b.room.state).toBe('joinWait');

    a.room.onProbeHeard(2, flatGrid, PROBE_PURPOSE.joining);
    b.room.onProbeHeard(1, flatGrid, PROBE_PURPOSE.joining);
    await a.tick(SLOT_0 + 100);
    await b.tick(SLOT_0 + 100);

    expect(a.sent.find((m) => m.type === ControlType.Welcome)?.targetId).toBe(2);
    expect(b.sent.find((m) => m.type === ControlType.Welcome)?.targetId).toBe(1);
  });

  it('replies with the type the newest probe asked for', async () => {
    // A queued reply's purpose is overwritten by a fresh probe, because the
    // newest announcement is the true one: a device that ran a roll call and
    // then refreshed and rejoined needs a WELCOME, not the REPORT its earlier
    // probe queued.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs - 10); // 'listening' — transmitter held

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    // Shorter than one slot window after the send, for the same reason as
    // above: the Task-4 retry arms one slot window after this send and would
    // otherwise fire inside a longer window.
    await h.tick(SLOT_0 + 200);

    expect(h.sent.filter((m) => m.type === ControlType.Report)).toHaveLength(0);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('does not reply while sending or receiving', async () => {
    // Our transmitter is genuinely occupied by a file. Queue, do not talk
    // over it.
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.FileComing, senderId: 8, targetId: 0,
      payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
    });
    expect(h.room.state).toBe('receiving');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    const elapsedSoFarMs = REPLY_SPAN + 200;
    await h.tick(elapsedSoFarMs);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);

    // ...but once the transfer's deadline returns us to idle, it goes out.
    // The transfer arms its own deadline at durationMs (2000) +
    // TRANSFER_TAIL_MARGIN_MS (5000) = 7000ms after the FILE_COMING above.
    // Stop the clock just past that deadline — accounting for what the tick
    // above already consumed — rather than well past it: that leaves a full
    // slot window of headroom before the Task-4 retry (armed one slot window
    // after the send this deadline triggers) would also land inside this
    // tick and change what's being measured here.
    // + SLOT_0: returning to idle re-drains the outbox, and the held reply is
    // scheduled from THAT moment — so it goes out a turnaround plus a slot
    // later, not the instant the state flips.
    const transferDeadlineMs = 2000 + 5000;
    await h.tick(transferDeadlineMs - elapsedSoFarMs + SLOT_0 + 200);
    expect(h.room.state).toBe('idle');
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('holds a chain already in flight when the transmitter goes busy mid-slot-wait, and resumes once free', async () => {
    // The hazard the brief calls out explicitly: "dropping it here is the old
    // bug". This reaches the HOLD branch INSIDE the timer callback (entry
    // already scheduled=true, chain in flight) rather than the earlier gate
    // at the top of drainReplyQueue — a custom rng forces a late slot so the
    // chain is still waiting when a FILE_COMING arrives and steals the
    // transmitter out from under it.
    const rng = () => 0.99; // picks the last of 6 slots every time
    const h = makeHarness(2, { rng });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 50);
    expect(h.room.state).toBe('joinWait');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    // Entry is scheduled and mid-slot-wait; nothing sent yet.
    expect(queuedReply(h.room, 9)?.scheduled).toBe(true);

    // Steal the transmitter: a FILE_COMING lands while we're still waiting
    // out the slot, and joinWait accepts it (handleFileComing allows
    // idle/joinWait), moving us to 'receiving'.
    h.room.onMessage({
      type: ControlType.FileComing, senderId: 8, targetId: 0,
      payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
    });
    expect(h.room.state).toBe('receiving');

    // Let the slot timer (5 * replySlotMs after the probe) fire while we're
    // still 'receiving' — this is the in-timer canTransmitReply() check, not
    // the gate at the top of drainReplyQueue.
    await h.tick(REPLY_SPAN + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
    // HELD, not dropped: the entry is still queued, and `scheduled` was
    // cleared so a later setState re-drains it.
    const held = queuedReply(h.room, 9);
    expect(held).toBeDefined();
    expect(held.scheduled).toBe(false);

    // The transfer's own deadline (durationMs + 5000) returns us to idle,
    // which re-drains the queue and finally sends the WELCOME.
    await h.tick(2000 + 5000 + REPLY_SPAN + 200);
    expect(h.room.state).toBe('idle');
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('does not send a reply if the transmitter becomes busy during the isAirBusy check itself', async () => {
    // Covers the SECOND canTransmitReply() re-check in scheduleReply, after
    // `await this.deps.isAirBusy()` — state can change across that await even
    // though it was fine when the timer fired. A custom isAirBusy triggers
    // that transition (a FILE_COMING arrives) before resolving.
    // Guard on state, not a one-shot flag: beginListening's own carrier-sense
    // also calls isAirBusy, and that happens first (while still 'listening'),
    // so a plain "first call" flag would fire — and get silently ignored by
    // handleFileComing's idle/joinWait check — before the reply's own
    // isAirBusy call ever runs.
    const h = makeHarness(2, {
      isAirBusy: async () => {
        if (h.room.state === 'joinWait') {
          h.room.onMessage({
            type: ControlType.FileComing, senderId: 8, targetId: 0,
            payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
          });
        }
        return false;
      },
    });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 50);
    expect(h.room.state).toBe('joinWait');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(SLOT_0 + 100); // slot 0 fires, isAirBusy steals the transmitter mid-await
    expect(h.room.state).toBe('receiving');
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
    const held = queuedReply(h.room, 9);
    expect(held).toBeDefined();
    expect(held.scheduled).toBe(false);

    await h.tick(2000 + 5000 + SLOT_0 + 200);
    expect(h.room.state).toBe('idle');
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('stop() mid-chain clears the queue and sends nothing afterward', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.state).toBe('idle');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    expect(replyQueueSize(h.room)).toBe(1);

    h.room.stop(); // cancels the pending slot timer before it fires
    expect(h.room.state).toBe('cold');
    expect(replyQueueSize(h.room)).toBe(0);

    await h.tick(60000); // nothing left to fire
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
  });

  it('answers a roll-call probe with a REPORT even from a device it has never seen', async () => {
    // The reply type now comes from the purpose bit, not from whether we
    // already know the prober. A never-seen device running a roll call needs
    // a channel measurement, not a welcome.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.state).toBe('idle');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    await h.tick(SLOT_0 + 100);

    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
    const report = h.sent.find((m) => m.type === ControlType.Report);
    expect(report).toBeDefined();
    expect(report.targetId).toBe(9);
  });

  it('answers a joining probe with a WELCOME even from a device it already knows', async () => {
    // The mirror case: a device rejoining with the same id (page refresh)
    // is already in _members, and used to receive a REPORT while sitting in
    // joinWait — so it finished joining knowing nothing about this peer.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    await h.tick(REPLY_SPAN + 200);
    expect(h.room.members.get(9)).toBeDefined();

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining); // 9 refreshed and rejoined
    await h.tick(SLOT_0 + 100);

    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('sends a joining reply twice when nothing at all is heard from the prober', async () => {
    // NOT "retries on loss": nothing in RoomProtocol transmits in response to
    // a WELCOME, so there is no path on which the prober answers unprompted.
    // The ack clears only if the prober independently sends something (a fresh
    // probe, a REPORT, a FILE_COMING, a BYE) inside the window — so in the
    // ordinary two-device flow this second send happens every time. Asserted
    // as the behaviour it actually is, not as loss recovery.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // Nothing heard back within one slot window → one more attempt.
    await h.tick(REPLY_SPAN + SLOT_0 + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(2);
  });

  it('never arms a retry for a roll-call reply', async () => {
    // A REPORT retry fires ~4950 ms after the roll-call probe's slot window
    // opened, which is outside the prober's collect window (5800 ms measured
    // from the same origin, minus the slot offsets) often enough to be a
    // routine collision: the prober is then transmitting FILE_COMING while
    // this device is transmitting a redundant REPORT with its own RX muted, so
    // it never arms its receiver and the whole file goes to nobody. A REPORT's
    // loss costs one negotiation; the retry can cost a transfer.
    //
    // Deliberately paired with the joining case below, which must still retry
    // — the two purposes are the only difference between them.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Report)).toHaveLength(1);

    // Well past every retry deadline, and nothing was ever heard from 9.
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Report)).toHaveLength(1);
    expect((h.room as any).awaitingAck.size).toBe(0);
  });

  it('still arms a retry for a joining reply', async () => {
    // The mirror of the test above: same silence, same clock, only the probe's
    // purpose differs — so a change that stopped arming retries at all, rather
    // than only for roll calls, fails here.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
    expect((h.room as any).awaitingAck.get(9)).toBeDefined();

    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(2);
  });

  it('does not send FILE_COMING while the air is busy — the roll call aborts with lastError', async () => {
    // FILE_COMING was the one transmit path with no carrier sense, and it is
    // the announcement that arms every receiver: transmitting it over someone
    // else's burst means nobody arms, and the sender then broadcasts an entire
    // file to a room that never listened, finishing with lastError === null.
    // Busy air must abort visibly instead.
    let busy = false;
    const h = makeHarness(1, { busy: () => busy });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + 100); // carrier-sense (still quiet) + probe
    h.room.onMessage({ type: ControlType.Report, senderId: 5, targetId: 1, payload: packReport(flatGrid) });

    // Someone starts talking during the collect window — e.g. a peer that drew
    // a late reply slot, or another device's own roll call.
    busy = true;
    await h.tick(REPLY_SPAN + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 500);

    expect(h.sent.some((m) => m.type === ControlType.FileComing)).toBe(false);
    expect(h.calls).not.toContain('fileTx');
    expect(h.room.state).toBe('idle');
    expect(h.room.lastError).toMatch(/busy/i);
  });

  it('stops after two attempts', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(2);
  });

  it('does not retry once the prober is heard from', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // 9 answers — a REPORT addressed to us proves it heard the welcome.
    h.room.onMessage({ type: ControlType.Report, senderId: 9, targetId: 2, payload: packReport(flatGrid) });
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('does not let a stale in-flight send discard a fresh reply queued under the same prober id', async () => {
    // A fresh reply queued while an earlier send is still in flight must
    // survive that send completing (sendMessage is ~3s of audio, and
    // stop()/start()/a fresh probe can all happen inside that window).
    //
    // This test no longer pins the identity check it was written for. When the
    // queue was keyed by proberId, a plain delete-by-key here would have
    // discarded the fresh entry; now that the outbox keys on a monotonic id
    // that survives clear(), the stale closure's id is simply absent and a
    // plain delete would be a harmless no-op. So this passes either way — it
    // pins the OUTCOME (the fresh reply is not lost and does go out), not the
    // mechanism. The half of the guard that is still load-bearing is the one
    // around onSent, pinned in outbox.test.ts.
    let resolveSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => { resolveSend = resolve; });
    const h = makeHarness(2, {
      sendMessage: async (m: any) => {
        h.sent.push(m);
        await sendGate; // hangs until the test releases it
      },
    });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.state).toBe('idle');

    // First probe: slot 0 fires, scheduleReply's timer calls sendMessage,
    // which is now hung awaiting sendGate. The original PendingReply object
    // is captured in that timer's closure but no longer sits in replyQueue —
    // it's "in flight".
    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // Leave and rejoin while that send is still in flight, then hear a new
    // probe from the same prober id (9). This creates a DISTINCT PendingReply
    // object under the same key, queued and drained fresh in the new room.
    h.room.stop();
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.state).toBe('idle');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    expect(queuedReply(h.room, 9)).toBeDefined();
    const freshEntry = queuedReply(h.room, 9);

    // Now let the original, stale sendMessage resolve. Its closure holds the
    // first entry, which is no longer in the queue, so it must not touch the
    // fresh one — and must not arm an ack for a send this room never made.
    resolveSend();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(queuedReply(h.room, 9)).toBe(freshEntry);

    // And it does eventually go out.
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(2);
  });

  it('does not retry once the prober is heard from via a WELCOME', async () => {
    // Mirror of "does not retry once the prober is heard from" (which covers
    // handleReport), for handleWelcome. The reply we owe must be a WELCOME —
    // a REPORT arms no ack at all now (see 'never arms a retry for a roll-call
    // reply'), so pinning handleWelcome's clear on a roll-call reply would be
    // vacuous. Two devices joining within a few seconds of each other is the
    // real case: we welcome 9, and 9's own WELCOME to us is proof the link
    // works even though it is not a response to ours.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining); // we owe a WELCOME
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    h.room.onMessage({
      type: ControlType.Welcome,
      senderId: 9,
      targetId: 2,
      payload: packWelcome({ claim: { lowHz: 1500, highHz: 7800, maxQamOrder: 6 }, grid: flatGrid }),
    });
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('a BYE from the prober clears the pending ack', async () => {
    // awaitingAck's invariant is "anything at all heard from that prober"
    // clears it, and a BYE is traffic from that prober. Without this, a peer
    // that heard our WELCOME and then left still earned a ~3 s retransmission
    // aimed at a device that has announced it is gone.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    h.room.onMessage({ type: ControlType.Bye, senderId: 9, targetId: 0, payload: new Uint8Array(0) });
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('a FILE_COMING from the prober clears the pending ack', async () => {
    // The one that matters most: without it a receiver holds a pending ack
    // across an ENTIRE transfer, and the retry timer fires the moment the
    // transfer's own deadline drops it back to idle — long after the WELCOME
    // could still be useful, and while the sender may still be finishing.
    // Cleared ahead of handleFileComing's own state/address guards, so it
    // holds even for a transfer we are not the addressee of.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // Addressed to a third device (7), so we neither arm RX nor leave idle.
    h.room.onMessage({
      type: ControlType.FileComing,
      senderId: 9,
      targetId: 7,
      payload: packFileComing({
        pilotFreqHz: 2000, toneStartHz: 600, toneCount: 8,
        settleSymbols: 8, fileBytes: 100, durationMs: 4000,
      }),
    });
    expect(h.room.state).toBe('idle');
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('a fresh probe clears the pending ack, so a stale retry timer does not fire a redundant send', async () => {
    // Regression pin for the awaitingAck.delete in onProbeHeard. Unlike
    // handleWelcome/handleReport (pure acks, no reply of their own), a fresh
    // probe ALSO queues and drains its own reply — so to isolate the delete's
    // effect from that second send's own (legitimate) re-arm, the air is held
    // busy from the second probe onward: the second reply then exhausts every
    // slot and gives up without ever sending, so nothing else touches
    // awaitingAck before the FIRST send's retry timer (armed one slot window
    // earlier) fires. Un-blocking the air afterward reveals whether that
    // timer found a stale ack to redundantly re-send (bug) or nothing (fixed,
    // because onProbeHeard already cleared it on contact).
    let busy = false;
    const h = makeHarness(2, { busy: () => busy });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(SLOT_0); // slot 0, rng fixed to 0 — sends as soon as the turnaround is up
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // Fresh contact from 9, air busy from here: this reply will exhaust every
    // slot and give up rather than send.
    busy = true;
    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);

    // Past the first send's retry deadline (one slot window after it) — by
    // now the busy-blocked second reply has already exhausted its own slots
    // and given up, so a still-pending stale ack would find nothing left in
    // replyQueue to defer to and would re-queue itself here.
    await h.tick(REPLY_SPAN + 100);

    // Let the air clear: if the stale ack wrongly re-queued above, this is
    // where it would actually transmit.
    busy = false;
    await h.tick(2000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('sends a broadcast TEXT from idle', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('hello room');
    await h.tick(SLOT_0 + 100);
    const sent = h.sent.find((m) => m.type === ControlType.Text);
    expect(sent).toBeDefined();
    expect(sent.targetId).toBe(0);
    expect(parseText(sent.payload)).toEqual({ msgId, text: 'hello room' });
  });

  it('addresses a DM to one device', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendText('just you', 7);
    await h.tick(SLOT_0 + 100);
    expect(h.sent.find((m) => m.type === ControlType.Text).targetId).toBe(7);
  });

  /**
   * Membership from ordinary traffic.
   *
   * A joiner probes, every existing member replies WELCOME, and the joiner
   * learns the room from those replies. Lose the WELCOME — one collision, one
   * bad moment on a half-duplex acoustic link — and the gap is permanent in
   * one direction: the member heard the join probe so it knows the joiner,
   * but the joiner has an empty roster and no reason to probe again. Any
   * frame that decodes from that peer is proof it exists and is in earshot,
   * so it is enough to close the gap without spending airtime.
   */
  it('registers an unknown sender on a received TEXT', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.members.get(9)).toBeUndefined();

    h.room.onMessage({
      type: ControlType.Text, senderId: 9, targetId: 0, payload: packText(3, 'hi all'),
    });

    expect(h.room.members.get(9)).toBeDefined();
  });

  it('registers an unknown sender on a TEXT addressed to someone else', async () => {
    // handleText drops a DM aimed at a third party, but the frame still
    // decoded — that device is real and in earshot regardless of who it was
    // talking to.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onMessage({
      type: ControlType.Text, senderId: 9, targetId: 7, payload: packText(3, 'psst'),
    });

    expect(h.room.members.get(9)).toBeDefined();
  });

  it('does not register an unknown sender on a BYE', async () => {
    // A BYE is proof the device existed, but it is leaving — recording it
    // adds a member that can only ever age out.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    h.room.onMessage({ type: ControlType.Bye, senderId: 9, targetId: 0, payload: new Uint8Array(0) });

    expect(h.room.members.get(9)).toBeUndefined();
  });

  it('a TEXT from a known member keeps the grid already measured for them', async () => {
    // noteHeard merges rather than replaces. Without that, every message from
    // an established peer would silently wipe the probe grid the room needs
    // to negotiate a band with them — turning a roster fix into a
    // settings-negotiation bug.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.onProbeHeard(9, flatGrid);
    expect(h.room.members.get(9)?.heardGrid).toBeDefined();

    h.room.onMessage({
      type: ControlType.Text, senderId: 9, targetId: 0, payload: packText(3, 'hi'),
    });

    expect(h.room.members.get(9)?.heardGrid).toBeDefined();
  });

  it('rejects text over the byte cap', () => {
    const h = makeHarness(1);
    expect(() => h.room.sendText('x'.repeat(TEXT_MAX_BYTES + 1))).toThrow(/cap|exceeds/i);
  });

  it('a received broadcast TEXT is delivered and ACKed exactly once', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.Text, senderId: 9, targetId: 0, payload: packText(3, 'hi all'),
    });
    await h.tick(SLOT_0 + 100);

    expect(h.textReceived).toEqual([{ msgId: 3, senderId: 9, targetId: 0, text: 'hi all' }]);
    const acks = h.sent.filter((m) => m.type === ControlType.Ack);
    expect(acks).toHaveLength(1);
    expect(acks[0].targetId).toBe(9);
    expect(parseAck(acks[0].payload)).toEqual({ msgId: 3 });
  });

  it('a duplicate (senderId, msgId) is neither re-delivered nor re-ACKed', async () => {
    // A retried TEXT arrives twice. The receiver must show it once and must
    // still ACK it once — the sender is retrying because it heard no ACK, so
    // a second ACK is not wrong, but a second delivery to the UI is.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    const dup = { type: ControlType.Text, senderId: 9, targetId: 0, payload: packText(3, 'hi all') };
    h.room.onMessage(dup);
    await h.tick(REPLY_SPAN + 200);
    h.room.onMessage(dup);
    await h.tick(REPLY_SPAN + 200);

    expect(h.textReceived).toHaveLength(1);
  });

  it('ignores a DM addressed to someone else', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.Text, senderId: 9, targetId: 5, payload: packText(4, 'not for you'),
    });
    await h.tick(REPLY_SPAN + 200);
    expect(h.textReceived).toHaveLength(0);
    expect(h.sent.filter((m) => m.type === ControlType.Ack)).toHaveLength(0);
  });

  it('a received ACK reports the acking device', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('hello');
    await h.tick(SLOT_0 + 100);
    h.room.onMessage({ type: ControlType.Ack, senderId: 8, targetId: 1, payload: packAck(msgId) });
    expect(h.textAcked).toEqual([{ msgId, by: 8 }]);
  });

  it('a DM with no ACK retries once, then fails', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendText('you there?', 7);
    await h.tick(SLOT_0 + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(1);

    await h.tick(ROOM_TIMING.ackWindowMs + SLOT_0 + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(2);

    await h.tick(ROOM_TIMING.ackWindowMs + SLOT_0 + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(2); // capped
    expect(h.textStates[h.textStates.length - 1]).toMatchObject({ state: 'failed' });
  });

  it('a DM that is ACKed does not retry', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('you there?', 7);
    await h.tick(SLOT_0 + 100);
    h.room.onMessage({ type: ControlType.Ack, senderId: 7, targetId: 1, payload: packAck(msgId) });

    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(1);
    expect(h.textStates[h.textStates.length - 1]).toMatchObject({ state: 'delivered', ackedBy: [7] });
  });

  it('a broadcast with one ACK does not retry', async () => {
    // Retrying because one of several peers missed it would spend seconds of
    // air punishing the ones that heard it.
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('hello room');
    await h.tick(SLOT_0 + 100);
    h.room.onMessage({ type: ControlType.Ack, senderId: 5, targetId: 1, payload: packAck(msgId) });

    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(1);
    expect(h.textStates[h.textStates.length - 1]).toMatchObject({ state: 'delivered', ackedBy: [5] });
  });

  it('a broadcast with zero ACKs retries once', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendText('anyone?');
    await h.tick(SLOT_0 + 100);
    await h.tick(ROOM_TIMING.ackWindowMs + SLOT_0 + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(2);
  });

  it('records every acking device on a broadcast', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('roll up');
    await h.tick(SLOT_0 + 100);
    h.room.onMessage({ type: ControlType.Ack, senderId: 5, targetId: 1, payload: packAck(msgId) });
    h.room.onMessage({ type: ControlType.Ack, senderId: 6, targetId: 1, payload: packAck(msgId) });
    h.room.onMessage({ type: ControlType.Ack, senderId: 5, targetId: 1, payload: packAck(msgId) }); // dup
    expect(h.textStates[h.textStates.length - 1]).toMatchObject({ state: 'delivered', ackedBy: [5, 6] });
  });

  it('a TEXT that exhausts every slot with the air busy reports failed and does not strand', async () => {
    // Slot exhaustion is a DIFFERENT failure than an ACK timeout: nothing was
    // ever transmitted, so armTextAck never got a chance to arm anything.
    // Without a dedicated onFailed branch the SentText record would sit in
    // `sentText` forever, reported 'sending' for the rest of the session —
    // the same silent-failure shape this whole task exists to eliminate, just
    // moved earlier in the pipeline.
    let busy = false;
    const h = makeHarness(1, { busy: () => busy });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);

    busy = true; // every slot in the window will find the air busy
    const msgId = h.room.sendText('anyone?');
    await h.tick(REPLY_SPAN + 500);

    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(0);
    expect(h.textStates[h.textStates.length - 1]).toMatchObject({ state: 'failed' });
    expect((h.room as any).sentText.has(msgId)).toBe(false);
  });

  it('a TEXT queued while receiving is held, then sent on return to idle', async () => {
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.FileComing, senderId: 8, targetId: 0,
      payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
    });
    expect(h.room.state).toBe('receiving');

    h.room.sendText('during a transfer');
    await h.tick(REPLY_SPAN + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(0);

    await h.tick(2000 + 5000 + SLOT_0 + 300);
    expect(h.room.state).toBe('idle');
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(1);
  });

  // ---- stall guards: a dep promise that never settles ----
  //
  // Every state reached via a TIMER carries its own deadline back to idle, but
  // a state entered immediately BEFORE an await carries none: 'rollCall' is
  // entered and then `playProbe` is awaited, so a playback promise that never
  // settles (a suspended AudioContext never fires `ended`, a worker reply that
  // never arrives) leaves the machine in 'rollCall' for the rest of the
  // session. That is not merely a stuck badge — every REPORT that arrives is
  // then dropped, because roll-call accumulation requires 'collecting'.

  it('a playProbe that never settles does not wedge the roll call', async () => {
    const h = makeHarness(1, { playProbe: () => new Promise<void>(() => {}) });
    (h.room as any).setState('idle');

    h.room.sendFile(64, 1000);
    await h.tick(ROOM_TIMING.listenMs + 100);
    expect(h.room.state).toBe('rollCall'); // awaiting a probe that never ends

    await h.tick(ROOM_STALL_MS + 100);
    expect(h.room.state).toBe('idle');
    expect(h.room.lastError).toMatch(/never completed/);
  });

  it('a REPORT arriving while the prober is still in rollCall is not silently dropped', async () => {
    const h = makeHarness(1, { playProbe: () => new Promise<void>(() => {}) });
    (h.room as any).setState('idle');
    h.room.sendFile(64, 1000);
    await h.tick(ROOM_TIMING.listenMs + 100);
    expect(h.room.state).toBe('rollCall');

    h.room.onMessage({ type: ControlType.Report, senderId: 7, targetId: 1, payload: packReport(flatGrid) });
    // The member refresh still happens; only the roll-call accumulation is
    // state-gated, and the reason must be visible rather than silent.
    expect(h.room.members.get(7)).toBeDefined();
    expect((h.room as any).collectedReports.size).toBe(0);
  });

  it('a join announce that never settles falls back to cold', async () => {
    const h = makeHarness(1, { playProbe: () => new Promise<void>(() => {}) });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 100);
    expect(h.room.state).toBe('announcing');

    await h.tick(ROOM_STALL_MS + 100);
    expect(h.room.state).toBe('cold');
    expect(h.room.lastError).toMatch(/never completed/);
  });

  // ---- reply turnaround ----

  it('holds a reply through the turnaround before its first slot', async () => {
    // Wiring plus behaviour: the real ROOM_TIMING value has to reach the
    // outbox, not just exist. A reply queued the instant a peer's burst ends
    // must not go out while that peer is still muted for its own playback and
    // re-arming its receiver.
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN
      + ROOM_TIMING.collectExtraMs + 200);
    const before = h.sent.length;

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replyTurnaroundMs - 100);
    expect(h.sent.length, 'silent through the turnaround').toBe(before);

    await h.tick(REPLY_SPAN + 300);
    expect(h.sent.length).toBeGreaterThan(before);
  });

  it('leaves room in the collect window for a reply drawn into the last slot', async () => {
    // Asserted, not left in a comment. The last time this arithmetic drifted,
    // the symptom was a reply landing just outside the window and silently
    // killing a file transfer — see collectExtraMs. A WELCOME is the longest
    // reply at ~3.15 s of air (measured).
    const WELCOME_AIR_MS = 3150;
    const lastSlotOpensAt = ROOM_TIMING.replyTurnaroundMs
      + (ROOM_TIMING.replySlots - 1) * ROOM_TIMING.replySlotMs;
    const worstReplyEndsAt = lastSlotOpensAt + WELCOME_AIR_MS;
    const window = ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs;

    expect(worstReplyEndsAt).toBeLessThan(window);
    // ...with real margin left for encode and output latency, which nothing
    // else budgets for.
    expect(window - worstReplyEndsAt).toBeGreaterThan(1000);
  });

  it('leaves room in the ACK window for an ACK drawn into the last slot', () => {
    // Same discipline as the collect-window assertion above, for the same
    // reason: the peer's ACK rides the same Outbox as every reply, so it is
    // scheduled at turnaround + slot*slotMs — a window that omits the
    // turnaround shuts before an ACK drawn into a late slot has finished,
    // and the sender retries (then reports 'failed') a message that was in
    // fact delivered. An ACK is ~2 s of air (measured — see ACK_AIR_MS).
    const ACK_AIR_MS = 2000;
    const lastSlotOpensAt = ROOM_TIMING.replyTurnaroundMs
      + (ROOM_TIMING.replySlots - 1) * ROOM_TIMING.replySlotMs;
    const worstAckEndsAt = lastSlotOpensAt + ACK_AIR_MS;

    expect(worstAckEndsAt).toBeLessThan(ROOM_TIMING.ackWindowMs);
    // ...with real margin for the peer's decode of the TEXT, its encode of
    // the ACK, and output latency — budgeted nowhere else.
    expect(ROOM_TIMING.ackWindowMs - worstAckEndsAt).toBeGreaterThan(1000);
  });

  // ---- texts must not strand when the room cannot transmit ----

  it('a TEXT sent while the room is cold fails immediately instead of stranding', async () => {
    // The outbox only drains on entry to idle/joinWait, and a cold room never
    // reaches either without a fresh start(). A text accepted in cold would
    // otherwise sit reported 'sending' for the rest of the session.
    const h = makeHarness(1);
    const msgId = h.room.sendText('anyone?'); // never started — state is 'cold'
    await h.tick(REPLY_SPAN + ROOM_TIMING.ackWindowMs + 500);

    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(0);
    expect(h.textStates[h.textStates.length - 1]).toMatchObject({ msgId, state: 'failed' });
    expect((h.room as any).sentText.has(msgId)).toBe(false);
    expect((h.room as any).outbox.size).toBe(0);
  });

  it('a deps error that drops the room to cold fails in-flight TEXTs rather than stranding them', async () => {
    // handleDepsError('cold') clears the outbox, which cancels every slot
    // chain — after that nothing can ever resolve a SentText record, so each
    // one must be reported 'failed' rather than left on 'sending' forever.
    const h = makeHarness(1, { playProbe: () => new Promise<void>(() => {}) });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 100);
    expect(h.room.state).toBe('announcing'); // transmitter busy: text is held

    const msgId = h.room.sendText('queued mid-join');
    await h.tick(ROOM_STALL_MS + 100); // announce stalls → cold

    expect(h.room.state).toBe('cold');
    expect(h.textStates[h.textStates.length - 1]).toMatchObject({ msgId, state: 'failed' });
    expect((h.room as any).sentText.has(msgId)).toBe(false);
  });

  // ---- remembered band: skip the roll call when we already negotiated ----
  //
  // A roll call exists to learn which band a peer can hear. That answer does
  // not change between two sends thirty seconds apart, and re-deriving it
  // costs a probe burst, a reply window, and — critically — a 12-chunk REPORT
  // over the fixed control band, which is the single most failure-prone
  // message the room sends. Remembering it per peer removes the whole
  // negotiation from a repeat send.

  /** Drive a first addressed send all the way through, so a band is cached. */
  const negotiateOnce = async (h: ReturnType<typeof makeHarness>, peer: number) => {
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + REPLY_SPAN + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(64, 1000, peer);
    await h.tick(ROOM_TIMING.listenMs + 100);
    h.room.onMessage({ type: ControlType.Report, senderId: peer, targetId: 1, payload: packReport(flatGrid) });
    await h.tick(
      REPLY_SPAN + ROOM_TIMING.collectExtraMs
      + ROOM_TIMING.fileComingLeadMs + 1000 + 5000 + 500,
    );
  };

  it('a repeat send to the same peer skips the roll call', async () => {
    const h = makeHarness(1);
    await negotiateOnce(h, 7);
    expect(h.room.state).toBe('idle');
    const probesAfterFirst = h.calls.filter((c) => c === 'probe').length;
    const firstAnnounce = h.sent.filter((m) => m.type === ControlType.FileComing);
    expect(firstAnnounce).toHaveLength(1);

    h.room.sendFile(64, 1000, 7);
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.fileComingLeadMs + 500);

    // No second probe, and the announcement went out anyway.
    expect(h.calls.filter((c) => c === 'probe')).toHaveLength(probesAfterFirst);
    expect(h.sent.filter((m) => m.type === ControlType.FileComing)).toHaveLength(2);
    expect(h.room.lastError).toBeNull();
    expect(h.calls.filter((c) => c === 'fileTx')).toHaveLength(2);
  });

  it('still carrier-senses before announcing from a remembered band', async () => {
    // Skipping the negotiation must not skip listen-before-talk: the whole
    // point of the check is that FILE_COMING is what arms every receiver.
    let busy = false;
    const h = makeHarness(1, { busy: () => busy });
    await negotiateOnce(h, 7);

    busy = true;
    h.room.sendFile(64, 1000, 7);
    await h.tick(ROOM_TIMING.listenCapMs + ROOM_TIMING.fileComingLeadMs + 1000);
    expect(h.room.lastError).toMatch(/channel busy/);
  });

  it('a peer that rejoins invalidates its remembered band', async () => {
    // Device ids are re-rolled at random (1-255) on every join, so a
    // 'joining' probe from an id we already hold is a NEW session behind a
    // recycled number — possibly a different device entirely. Its old band is
    // meaningless and must not be reused.
    const h = makeHarness(1);
    await negotiateOnce(h, 7);
    const probesBefore = h.calls.filter((c) => c === 'probe').length;

    h.room.onProbeHeard(7, flatGrid, PROBE_PURPOSE.joining);
    h.room.sendFile(64, 1000, 7);
    await h.tick(ROOM_TIMING.listenMs + 200);

    expect(h.calls.filter((c) => c === 'probe').length).toBe(probesBefore + 1);
  });

  it('a remembered band goes stale rather than being trusted forever', async () => {
    const h = makeHarness(1);
    await negotiateOnce(h, 7);
    const probesBefore = h.calls.filter((c) => c === 'probe').length;

    await h.tick(BAND_CACHE_TTL_MS + 1000);
    h.room.sendFile(64, 1000, 7);
    await h.tick(ROOM_TIMING.listenMs + 200);

    expect(h.calls.filter((c) => c === 'probe').length).toBe(probesBefore + 1);
  });

  it('a broadcast always rolls call, however recently we negotiated', async () => {
    // A broadcast has no single peer to remember: the right settings are the
    // room's collective worst case, and a member who joined since the last
    // send has never been measured at all.
    const h = makeHarness(1);
    await negotiateOnce(h, 7);
    const probesBefore = h.calls.filter((c) => c === 'probe').length;

    h.room.sendFile(64, 1000, 0);
    await h.tick(ROOM_TIMING.listenMs + 200);

    expect(h.calls.filter((c) => c === 'probe').length).toBe(probesBefore + 1);
  });

  it('an isAirBusy that never settles does not wedge carrier sense', async () => {
    const h = makeHarness(1, { isAirBusy: () => new Promise<boolean>(() => {}) });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 100);
    expect(h.room.state).toBe('listening');

    await h.tick(ROOM_STALL_MS + 100);
    expect(h.room.state).toBe('cold');
    expect(h.room.lastError).toMatch(/never completed/);
  });
});

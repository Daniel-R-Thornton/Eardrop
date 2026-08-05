import { describe, expect, it } from 'vitest';
import { RoomProtocol, ROOM_TIMING } from '../chatter/roomProtocol';
import { ControlType, packReport, packWelcome, packFileComing } from '../protocol/controlFrame';
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
  return { room, tick, sent, calls };
}

const flatGrid = Array.from({ length: 64 }, () => 1);

/**
 * The reply queue lives in the Outbox now (see outbox.ts), keyed on a
 * monotonic entry id rather than on the prober — a TEXT broadcast is not keyed
 * by a peer. `reply:<proberId>` is the dedup key that restores the old
 * one-chain-per-peer rule, so these two stand in for what used to be
 * `(room as any).replyQueue.get(id)` and `.size`.
 */
const queuedReply = (room: any, proberId: number): any =>
  Array.from(room.outbox.entries.values() as Iterable<any>)
    .find((e: any) => e.dedupKey === `reply:${proberId}`);
const replyQueueSize = (room: any): number => room.outbox.size;

describe('room protocol', () => {
  it('joins an empty room: listen → announce → joinWait → idle', async () => {
    const h = makeHarness(1);
    h.room.start();
    expect(h.room.state).toBe('listening');
    await h.tick(ROOM_TIMING.listenMs + 50);
    expect(h.calls).toContain('probe');
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 100);
    expect(h.room.state).toBe('idle');
    expect(h.room.members.size).toBe(0);
  });

  it('member replies WELCOME when it hears a probe', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.onProbeHeard(9, flatGrid);
    await h.tick(ROOM_TIMING.replySlotMs + 100); // slot 0 fires
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
    await h.tick(ROOM_TIMING.listenCapMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 500);
    expect(h.room.state).toBe('idle');
    h.room.onProbeHeard(9, flatGrid);
    await h.tick(ROOM_TIMING.replySlotMs + 50); // slot 0 blocked
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
    busy = false;
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('roll call with one report → FILE_COMING + startFileTx', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + 100); // carrier-sense + probe
    h.room.onMessage({ type: ControlType.Report, senderId: 5, targetId: 1, payload: packReport(flatGrid) });
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + 100); // carrier-sense + probe
    h.room.onMessage({
      type: ControlType.Welcome,
      senderId: 5,
      targetId: 1,
      payload: packWelcome({ claim: { lowHz: 1500, highHz: 7800, maxQamOrder: 6 }, grid: flatGrid }),
    });
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
    expect(h.room.lastError).toBeNull();
    expect(h.sent.some((m) => m.type === ControlType.FileComing)).toBe(true);
    expect(h.calls).toContain('fileTx');
  });

  it('roll call with zero reports aborts to idle with lastError', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 500);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000, 5); // addressed to 5
    await h.tick(ROOM_TIMING.listenMs + 100);
    // Only a bystander answers.
    h.room.onMessage({ type: ControlType.Report, senderId: 7, targetId: 1, payload: packReport(flatGrid) });
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
    expect(h.calls).not.toContain('fileTx');
    expect(h.room.lastError).toMatch(/not reachable/);
  });

  it('an addressed FILE_COMING carries the target id', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendFile(1000, 30000, 5);
    await h.tick(ROOM_TIMING.listenMs + 100);
    h.room.onMessage({ type: ControlType.Report, senderId: 5, targetId: 1, payload: packReport(flatGrid) });
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
    const fc = h.sent.find((m) => m.type === ControlType.FileComing);
    expect(fc).toBeDefined();
    expect(fc.targetId).toBe(5);
    expect(h.calls).toContain('fileTx');
  });

  it('FILE_COMING while idle arms RX and times back out to idle', async () => {
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
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

    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 100);
    expect(h.room.state).toBe('idle');
  });

  it('onProbeHeard twice for the same prober while idle only schedules one WELCOME chain', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.onProbeHeard(9, flatGrid);
    h.room.onProbeHeard(9, flatGrid); // duplicate, same prober, reply chain already pending
    // Measured over a window shorter than one slot window: the retry arms
    // only after the first WELCOME actually sends, so this still isolates
    // "one chain per prober" from the retry behaviour covered separately
    // below (a window covering a full slot window would let a retry fire
    // too, which is correct but not what this test is checking).
    await h.tick(ROOM_TIMING.replySlotMs + 100);
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
    await h.tick(ROOM_TIMING.replySlotMs + 100);

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
    await h.tick(ROOM_TIMING.replySlotMs + 200);
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
    await a.tick(ROOM_TIMING.replySlotMs + 100);
    await b.tick(ROOM_TIMING.replySlotMs + 100);

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
    await h.tick(ROOM_TIMING.replySlotMs + 200);

    expect(h.sent.filter((m) => m.type === ControlType.Report)).toHaveLength(0);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('does not reply while sending or receiving', async () => {
    // Our transmitter is genuinely occupied by a file. Queue, do not talk
    // over it.
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.FileComing, senderId: 8, targetId: 0,
      payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
    });
    expect(h.room.state).toBe('receiving');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    const elapsedSoFarMs = ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200;
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
    const transferDeadlineMs = 2000 + 5000;
    await h.tick(transferDeadlineMs - elapsedSoFarMs + 200);
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
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
    // HELD, not dropped: the entry is still queued, and `scheduled` was
    // cleared so a later setState re-drains it.
    const held = queuedReply(h.room, 9);
    expect(held).toBeDefined();
    expect(held.scheduled).toBe(false);

    // The transfer's own deadline (durationMs + 5000) returns us to idle,
    // which re-drains the queue and finally sends the WELCOME.
    await h.tick(2000 + 5000 + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
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
    await h.tick(ROOM_TIMING.replySlotMs + 100); // slot 0 fires, isAirBusy steals the transmitter mid-await
    expect(h.room.state).toBe('receiving');
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
    const held = queuedReply(h.room, 9);
    expect(held).toBeDefined();
    expect(held.scheduled).toBe(false);

    await h.tick(2000 + 5000 + ROOM_TIMING.replySlotMs + 200);
    expect(h.room.state).toBe('idle');
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('stop() mid-chain clears the queue and sends nothing afterward', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.state).toBe('idle');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    await h.tick(ROOM_TIMING.replySlotMs + 100);

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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    expect(h.room.members.get(9)).toBeDefined();

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining); // 9 refreshed and rejoined
    await h.tick(ROOM_TIMING.replySlotMs + 100);

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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // Nothing heard back within one slot window → one more attempt.
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.replySlotMs + 200);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + 100); // carrier-sense (still quiet) + probe
    h.room.onMessage({ type: ControlType.Report, senderId: 5, targetId: 1, payload: packReport(flatGrid) });

    // Someone starts talking during the collect window — e.g. a peer that drew
    // a late reply slot, or another device's own roll call.
    busy = true;
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 500);

    expect(h.sent.some((m) => m.type === ControlType.FileComing)).toBe(false);
    expect(h.calls).not.toContain('fileTx');
    expect(h.room.state).toBe('idle');
    expect(h.room.lastError).toMatch(/busy/i);
  });

  it('stops after two attempts', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(2);
  });

  it('does not retry once the prober is heard from', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // 9 answers — a REPORT addressed to us proves it heard the welcome.
    h.room.onMessage({ type: ControlType.Report, senderId: 9, targetId: 2, payload: packReport(flatGrid) });
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('does not let a stale in-flight send discard a fresh reply queued under the same prober id', async () => {
    // Regression pin for the identity check on the three replyQueue.delete
    // sites in scheduleReply: a plain delete-by-key would discard a newer,
    // not-yet-sent entry that reoccupies the same key while an earlier send
    // is still in flight (sendMessage is ~3s of audio, and stop()/start()/a
    // fresh probe can all happen inside that window). Reverting the guards
    // to a plain delete keeps every OTHER test green, so this is the only
    // thing that would catch that regression.
    let resolveSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => { resolveSend = resolve; });
    const h = makeHarness(2, {
      sendMessage: async (m: any) => {
        h.sent.push(m);
        await sendGate; // hangs until the test releases it
      },
    });
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.state).toBe('idle');

    // First probe: slot 0 fires, scheduleReply's timer calls sendMessage,
    // which is now hung awaiting sendGate. The original PendingReply object
    // is captured in that timer's closure but no longer sits in replyQueue —
    // it's "in flight".
    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // Leave and rejoin while that send is still in flight, then hear a new
    // probe from the same prober id (9). This creates a DISTINCT PendingReply
    // object under the same key, queued and drained fresh in the new room.
    h.room.stop();
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.state).toBe('idle');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    expect(queuedReply(h.room, 9)).toBeDefined();
    const freshEntry = queuedReply(h.room, 9);

    // Now let the original, stale sendMessage resolve. Its timer callback
    // will check `replyQueue.get(9) === <original entry>` — false, since a
    // new entry occupies that key — and must NOT delete the fresh entry. A
    // plain delete-by-key would discard it here, and it would never be sent
    // or re-added.
    resolveSend();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(queuedReply(h.room, 9)).toBe(freshEntry);

    // And it does eventually go out.
    await h.tick(ROOM_TIMING.replySlotMs + 100);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining); // we owe a WELCOME
    await h.tick(ROOM_TIMING.replySlotMs + 100);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(10); // slot 0, rng fixed to 0 — sends almost immediately
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // Fresh contact from 9, air busy from here: this reply will exhaust every
    // slot and give up rather than send.
    busy = true;
    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);

    // Past the first send's retry deadline (one slot window after it) — by
    // now the busy-blocked second reply has already exhausted its own slots
    // and given up, so a still-pending stale ack would find nothing left in
    // replyQueue to defer to and would re-queue itself here.
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 100);

    // Let the air clear: if the stale ack wrongly re-queued above, this is
    // where it would actually transmit.
    busy = false;
    await h.tick(2000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });
});

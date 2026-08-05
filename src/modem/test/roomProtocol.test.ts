import { describe, expect, it } from 'vitest';
import { RoomProtocol, ROOM_TIMING } from '../chatter/roomProtocol';
import { ControlType, packReport, packWelcome, packFileComing } from '../protocol/controlFrame';
import { PROBE_PURPOSE } from '../protocol/probeBurst';

/** Manual clock + timer wheel so every test is deterministic. */
function makeHarness(
  deviceId: number,
  opts: { busy?: () => boolean; playProbe?: () => Promise<void> } = {},
) {
  let t = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const sent: any[] = [];
  const calls: string[] = [];
  const deps = {
    deviceId,
    now: () => t,
    rng: () => 0, // slot 0 always — collisions forced by `busy`
    schedule: (fn: () => void, d: number) => {
      const rec = { at: t + d, fn, dead: false };
      timers.push(rec);
      return () => { rec.dead = true; };
    },
    playProbe: opts.playProbe ?? (async () => { calls.push('probe'); }),
    sendMessage: async (m: any) => { sent.push(m); },
    isAirBusy: async () => opts.busy?.() ?? false,
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
      await Promise.resolve(); await Promise.resolve(); // drain microtasks
    }
    t = end;
  };
  return { room, tick, sent, calls };
}

const flatGrid = Array.from({ length: 64 }, () => 1);

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
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 100);
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

  it('holds a probe heard mid-announce and replies once the transmitter frees up', async () => {
    // 'announcing' is genuinely busy — our own probe is playing. The reply
    // must be queued rather than dropped, then sent when we reach joinWait.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs - 10);
    expect(h.room.state).toBe('listening');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);

    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
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
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);

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
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);

    // ...but once the transfer's deadline returns us to idle, it goes out.
    await h.tick(2000 + 5000 + ROOM_TIMING.replySlotMs + 200);
    expect(h.room.state).toBe('idle');
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
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
});

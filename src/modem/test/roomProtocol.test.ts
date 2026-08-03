import { describe, expect, it } from 'vitest';
import { RoomProtocol, ROOM_TIMING } from '../chatter/roomProtocol';
import { ControlType, packReport, packWelcome, packFileComing } from '../protocol/controlFrame';

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
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 100);
    expect(h.room.state).toBe('idle');
    expect(h.room.members.size).toBe(0);
  });

  it('member replies WELCOME when it hears a probe', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
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
    await h.tick(ROOM_TIMING.listenCapMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 500);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + 100); // carrier-sense + probe
    h.room.onMessage({ type: ControlType.Report, senderId: 5, targetId: 1, payload: packReport(flatGrid) });
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
    expect(h.sent.some((m) => m.type === ControlType.FileComing)).toBe(true);
    expect(h.calls).toContain('fileTx');
    expect(h.room.state).toBe('sending');
  });

  it('roll call with zero reports aborts to idle with lastError', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 500);
    expect(h.calls).not.toContain('fileTx');
    expect(h.room.state).toBe('idle');
    expect(h.room.lastError).toMatch(/no.*report|nobody/i);
  });

  it('FILE_COMING while idle arms RX and times back out to idle', async () => {
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
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
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
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

    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 100);
    expect(h.room.state).toBe('idle');
  });

  it('onProbeHeard twice for the same prober while idle only schedules one WELCOME chain', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    h.room.onProbeHeard(9, flatGrid);
    h.room.onProbeHeard(9, flatGrid); // duplicate, same prober, reply chain already pending
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });
});

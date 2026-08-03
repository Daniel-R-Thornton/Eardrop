/**
 * chatterController.test.ts — the controller drives a REAL RoomProtocol
 * (via a fake worker handle + fake player, manual clock — same harness
 * pattern as roomProtocol.test.ts) with no AudioContext anywhere in the
 * loop. Exercises: join → probe playback, an incoming probe → WELCOME
 * reply, and the pre-idle broadcastFile guard.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ChatterController, type ModemWorkerHandle, type AudioPlayerLike } from '../../ui/controllers/chatterController';
import { ROOM_TIMING } from '../chatter/roomProtocol';
import { ControlType, CONTROL_HEADER_WIRE, controlPayloadWireSize } from '../protocol/controlFrame';
import { getState, setState, CHATTER_PACKET_LOG_MAX } from '../../ui/Store';

/** Manual clock + timer wheel, mirroring roomProtocol.test.ts's harness. */
function makeClock() {
  let t = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const schedule = (fn: () => void, delayMs: number) => {
    const rec = { at: t + delayMs, fn, dead: false };
    timers.push(rec);
    return () => { rec.dead = true; };
  };
  const tick = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      // Drain microtasks BEFORE checking what's due — ChatterController's
      // playAndMute chains encode -> play -> scheduled echo-tail unmute
      // across several promise hops with NO synchronous schedule() call at
      // the start (unlike roomProtocol.test.ts's deps, which call `timer()`
      // directly inside start()/onProbeHeard). Without this pre-drain, a
      // chain's first schedule() call can still be microtask-hops away when
      // the due-check runs, so it's invisible this round and its timer ends
      // up registered relative to `t` AFTER we've already jumped `t` to
      // `end` at the bottom of the loop — permanently missing its window.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
    }
    t = end;
  };
  return { schedule, tick, now: () => t };
}

/** Fake worker handle: records every command, resolves encode/check requests
 *  immediately, and lets the test fire probeHeard/controlMessage events. */
function makeFakeWorker() {
  const calls: string[] = [];
  const muteLog: boolean[] = [];
  const handlers = new Map<string, Set<(ev: any) => void>>();
  let airBusy = false;

  const worker: ModemWorkerHandle & { emit: (type: string, ev: any) => void; calls: string[]; muteLog: boolean[]; setAirBusy: (b: boolean) => void } = {
    sampleRate: 48000,
    calls,
    muteLog,
    on: (type: any, fn: any) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
      return () => handlers.get(type)?.delete(fn);
    },
    emit: (type: string, ev: any) => {
      handlers.get(type)?.forEach((fn) => fn(ev));
    },
    configure: () => { calls.push('configure'); },
    startListening: async () => { calls.push('startListening'); },
    stopListening: () => { calls.push('stopListening'); },
    encodeFile: async (fileName: string) => {
      calls.push(`encodeFile:${fileName}`);
      return { samples: new Float32Array(4), sampleRate: 48000 };
    },
    chatterStart: (deviceId: number) => { calls.push(`chatterStart:${deviceId}`); },
    chatterStop: () => { calls.push('chatterStop'); },
    encodeProbe: async () => {
      calls.push('encodeProbe');
      return { samples: new Float32Array(4), sampleRate: 48000 };
    },
    encodeControl: async (msg) => {
      calls.push(`encodeControl:${msg.type}`);
      return { samples: new Float32Array(4), sampleRate: 48000 };
    },
    airCheck: async () => ({ busy: airBusy, rms: 0 }),
    setRxMuted: (muted: boolean) => { muteLog.push(muted); },
    setAirBusy: (b: boolean) => { airBusy = b; },
  };
  return worker;
}

function makeFakePlayer() {
  const played: { samples: Float32Array; sampleRate: number }[] = [];
  const player: AudioPlayerLike & { played: typeof played } = {
    played,
    play: async (samples: Float32Array, sampleRate: number) => {
      played.push({ samples, sampleRate });
    },
  };
  return player;
}

const flatGrid = Array.from({ length: 64 }, () => 1);

/** Mirrors ChatterController's own echo-tail delay (MUTE_TAIL_MS) — every
 *  own-playback round trip costs this much extra wall-clock time after the
 *  audio itself "finishes" before RX un-mutes. */
const MUTE_TAIL_MS = 150;

describe('ChatterController', () => {
  beforeEach(() => {
    setState({
      chatterOn: false,
      chatterState: 'off',
      chatterDeviceId: 0,
      chatterMembers: [],
      chatterError: null,
      chatterPackets: [],
      chatterLastTx: null,
    });
  });

  it('joinRoom starts the worker chatter mode and plays a probe on announce', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const rng = () => 0; // deviceId = 1, reply slot 0
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng });

    await controller.joinRoom();

    expect(worker.calls).toContain('configure');
    expect(worker.calls).toContain('chatterStart:1');
    expect(worker.calls).toContain('startListening');
    expect(getState().chatterOn).toBe(true);
    expect(getState().chatterDeviceId).toBe(1);
    expect(getState().chatterState).toBe('listening');

    // drive listen -> announce (probe, plus its post-playback echo-tail
    // mute/unmute) -> joinWait -> idle
    await clock.tick(ROOM_TIMING.listenMs + MUTE_TAIL_MS + 50);
    expect(worker.calls).toContain('encodeProbe');
    expect(player.played).toHaveLength(1);
    // muted true for the probe, then false again after the echo tail
    expect(worker.muteLog).toEqual([true, false]);

    await clock.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 100);
    expect(getState().chatterState).toBe('idle');
  });

  it('a second joinRoom call while the first is still in flight is a no-op', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const rng = () => 0;
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng });

    // Neither call is awaited before the second fires — reproduces a second
    // button click landing mid-await, before `chatterOn` has flipped true.
    const p1 = controller.joinRoom();
    const p2 = controller.joinRoom();
    await Promise.all([p1, p2]);

    expect(worker.calls.filter((c) => c.startsWith('chatterStart')).length).toBe(1);
    expect(worker.calls.filter((c) => c === 'startListening').length).toBe(1);
    expect(getState().chatterOn).toBe(true);
  });

  it('routes a worker probeHeard event into the protocol and replies WELCOME', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + MUTE_TAIL_MS + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200,
    );
    expect(getState().chatterState).toBe('idle');

    worker.emit('probeHeard', { deviceId: 9, grid: flatGrid });
    await clock.tick(ROOM_TIMING.replySlotMs + MUTE_TAIL_MS + 100); // slot 0 fires, then its own echo tail

    expect(worker.calls).toContain(`encodeControl:${ControlType.Welcome}`);
    expect(player.played.length).toBeGreaterThanOrEqual(2); // join probe + WELCOME reply
  });

  it('routes a worker controlMessage event into the protocol (WELCOME reply)', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    await clock.tick(ROOM_TIMING.listenMs + MUTE_TAIL_MS + 50); // reach 'announcing' -> 'joinWait'
    expect(getState().chatterState).toBe('joinWait');

    worker.emit('controlMessage', {
      msg: { type: ControlType.Welcome, senderId: 9, targetId: 1, payload: new Uint8Array(0) },
    });
    // Malformed WELCOME payload (empty) is simply ignored by parseWelcome —
    // this only proves the event reaches RoomProtocol.onMessage without throwing.
    await clock.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 100);
    expect(getState().chatterState).toBe('idle');
  });

  it('broadcastFile before idle sets chatterError and does not touch the worker', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    expect(getState().chatterState).toBe('listening'); // not idle yet

    const callsBefore = worker.calls.length;
    await controller.broadcastFile('a.txt', new Uint8Array([1, 2, 3]));

    expect(getState().chatterError).toMatch(/idle/);
    expect(worker.calls.length).toBe(callsBefore); // no new worker commands issued
  });

  it('leaveRoom stops the protocol and resets chatter store fields', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom(); // state 'listening' (not 'cold') — stop() below fires a BYE
    const leavePromise = controller.leaveRoom();
    await clock.tick(200); // let the BYE's own echo-tail timer settle leaveRoom's wait
    await leavePromise;

    expect(worker.calls).toContain('chatterStop');
    expect(worker.calls).toContain('stopListening');
    expect(getState().chatterOn).toBe(false);
    expect(getState().chatterState).toBe('off');
    expect(getState().chatterDeviceId).toBe(0);
  });

  it('leaveRoom waits for the in-flight BYE playback before tearing chatter mode down', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + MUTE_TAIL_MS + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200,
    );
    expect(getState().chatterState).toBe('idle');

    const leavePromise = controller.leaveRoom();
    await Promise.resolve(); // let stop()'s synchronous fire-and-forget sendMessage reach encodeControl

    expect(worker.calls).toContain(`encodeControl:${ControlType.Bye}`);
    // The BYE's encode+play is still in flight (its echo-tail timer hasn't
    // fired yet) — chatterStop must NOT have run yet, structurally, not by luck.
    expect(worker.calls).not.toContain('chatterStop');

    await clock.tick(MUTE_TAIL_MS + 50); // let the BYE playback's echo-tail timer fire
    await leavePromise;

    expect(worker.calls).toContain('chatterStop');
    const byeIdx = worker.calls.indexOf(`encodeControl:${ControlType.Bye}`);
    const stopIdx = worker.calls.indexOf('chatterStop');
    expect(byeIdx).toBeGreaterThanOrEqual(0);
    expect(byeIdx).toBeLessThan(stopIdx);
  });

  it('records a tx packet + chatterLastTx for the join probe', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    await clock.tick(ROOM_TIMING.listenMs + MUTE_TAIL_MS + 50);

    const probePackets = getState().chatterPackets.filter((p) => p.kind === 'probe' && p.dir === 'tx');
    expect(probePackets).toHaveLength(1);
    expect(probePackets[0]).toMatchObject({ dir: 'tx', kind: 'probe', bytes: 0 });
    expect(getState().chatterLastTx).not.toBeNull();
  });

  it('records an rx packet for a heard probe, with a link-quality note', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + MUTE_TAIL_MS + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200,
    );

    worker.emit('probeHeard', { deviceId: 9, grid: flatGrid });

    const rxProbe = getState().chatterPackets.find((p) => p.kind === 'probe' && p.dir === 'rx');
    expect(rxProbe).toBeDefined();
    expect(rxProbe).toMatchObject({ dir: 'rx', kind: 'probe', peerId: 9, bytes: 0 });
    // flatGrid is uniform, so it's already at its own peak everywhere -> 0 dB.
    expect(rxProbe!.note).toMatch(/0(\.0)? ?dB/);
  });

  it('records an rx packet for a decoded control message, keyed by ControlType', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    await clock.tick(ROOM_TIMING.listenMs + MUTE_TAIL_MS + 50); // reach 'joinWait'

    worker.emit('controlMessage', {
      msg: { type: ControlType.Welcome, senderId: 9, targetId: 1, payload: new Uint8Array([1, 2, 3]) },
    });

    const rxWelcome = getState().chatterPackets.find((p) => p.kind === 'welcome' && p.dir === 'rx');
    expect(rxWelcome).toBeDefined();
    expect(rxWelcome).toMatchObject({
      dir: 'rx',
      kind: 'welcome',
      peerId: 9,
      bytes: CONTROL_HEADER_WIRE + controlPayloadWireSize(3),
    });
  });

  it('caps the packet log at CHATTER_PACKET_LOG_MAX, keeping the newest', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + MUTE_TAIL_MS + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200,
    );

    for (let i = 0; i < CHATTER_PACKET_LOG_MAX + 20; i++) {
      worker.emit('probeHeard', { deviceId: 9, grid: flatGrid });
    }

    const packets = getState().chatterPackets;
    expect(packets.length).toBe(CHATTER_PACKET_LOG_MAX);
    expect(packets[packets.length - 1].seq).toBeGreaterThan(packets[0].seq);
  });

  it('enriches a member with linkDb/grid once a probe from them has been measured', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + MUTE_TAIL_MS + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200,
    );
    expect(getState().chatterState).toBe('idle');

    // Device 9 probes us — this device measures & records device 9's grid.
    worker.emit('probeHeard', { deviceId: 9, grid: flatGrid });
    await clock.tick(ROOM_TIMING.replySlotMs + MUTE_TAIL_MS + 100);
    expect(getState().chatterState).toBe('idle');

    // Drive a roll call so RoomProtocol's next onStateChange snapshot carries
    // device 9 (with its heardGrid) into the store.
    await controller.broadcastFile('a.txt', new Uint8Array([1, 2, 3]));
    await clock.tick(ROOM_TIMING.listenMs + MUTE_TAIL_MS + 50); // reach 'rollCall'

    const member = getState().chatterMembers.find((m) => m.deviceId === 9);
    expect(member).toBeDefined();
    expect(member!.linkDb).toBeCloseTo(0, 5); // flat grid -> already at its own peak
    expect(member!.grid).toEqual(flatGrid.map(() => 1));
  });

  it('reflects linkDb/grid the instant a probe is heard, with no subsequent state transition', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng: () => 0 });

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + MUTE_TAIL_MS + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200,
    );
    expect(getState().chatterState).toBe('idle');

    // Device 9 probes us — a quiet room otherwise never fires another
    // onStateChange (idle -> rollCall only happens via an explicit
    // sendFile()), so without a same-tick store patch this would sit
    // undefined indefinitely.
    worker.emit('probeHeard', { deviceId: 9, grid: flatGrid });

    const member = getState().chatterMembers.find((m) => m.deviceId === 9);
    expect(member).toBeDefined();
    expect(member!.linkDb).toBeCloseTo(0, 5);
    expect(member!.grid).toEqual(flatGrid.map(() => 1));
  });
});

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
import { ControlType } from '../protocol/controlFrame';
import { getState, setState } from '../../ui/Store';

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
      const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
      // Drain a deeper microtask chain than roomProtocol.test.ts's harness
      // needs — ChatterController's playAndMute chains encode -> play ->
      // scheduled echo-tail unmute across several promise hops per firing.
      for (let i = 0; i < 10; i++) await Promise.resolve();
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

    await controller.joinRoom();
    await controller.leaveRoom();

    expect(worker.calls).toContain('chatterStop');
    expect(worker.calls).toContain('stopListening');
    expect(getState().chatterOn).toBe(false);
    expect(getState().chatterState).toBe('off');
    expect(getState().chatterDeviceId).toBe(0);
  });
});

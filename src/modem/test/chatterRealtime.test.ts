/**
 * chatterRealtime.test.ts — the chatter room over an air that takes TIME.
 *
 * chatterLoopback.test.ts proves the chain works when every transmission is
 * delivered to the other side instantaneously, inside the `playProbe`/
 * `sendMessage` call itself. That cannot catch a timing fault, and the room's
 * whole roll-call design is timing: a REPORT has to leave a randomly drawn
 * slot, take ~3 s of air, and still land inside the prober's collect window,
 * while each device is deaf to the room for as long as it is transmitting
 * (`setRxMuted`) plus an echo tail.
 *
 * So this harness models exactly those three things and nothing else:
 *   - playback occupies wall-clock time (samples / sampleRate),
 *   - the transmitting device's own receivers are muted for that time plus
 *     MUTE_TAIL_MS, and re-armed on unmute (what modemService does),
 *   - audio arrives at the other device in 100 ms chunks as it is played, so
 *     a burst that starts while the peer is still muted loses its head.
 *
 * Everything else is the real code: real probe bursts, real control-frame
 * audio, the real ProbeDetector, the real chatter RxEngine, the real
 * AirNoiseTracker behind isAirBusy.
 */
import { describe, expect, it } from 'vitest';
import { RoomProtocol, ROOM_TIMING, type RoomDeps } from '../chatter/roomProtocol';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import { AirNoiseTracker, ProbeDetector, rmsOf } from '../../workers/modemService';
import { buildProbeBurst, type ProbePurpose } from '../protocol/probeBurst';
import { encodeControlMessage, type ControlMessage } from '../protocol/controlFrame';
import type { PickedSettings } from '../chatter/settingsPick';

const SR = 48000;
const TIMEOUT = 120000;

/** chatterController.ts's own constant — the echo tail before RX un-mutes. */
const MUTE_TAIL_MS = 150;
/** Delivery granularity: the mic callback size the worker sees, near enough. */
const CHUNK_MS = 100;

const A_ID = 42;
const B_ID = 99;

function makeClock() {
  let t = 0;
  const timers: { at: number; seq: number; fn: () => void; dead: boolean }[] = [];
  let seq = 0;
  const now = () => t;
  const schedule = (fn: () => void, d: number) => {
    const rec = { at: t + Math.max(0, d), seq: seq++, fn, dead: false };
    timers.push(rec);
    return () => { rec.dead = true; };
  };
  const drain = async (): Promise<void> => {
    for (let k = 0; k < 12; k++) await Promise.resolve();
  };
  const tick = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      await drain();
      const due = timers
        .filter((x) => !x.dead && x.at <= end)
        .sort((a, b) => (a.at - b.at) || (a.seq - b.seq))[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
    }
    await drain();
    t = end;
  };
  return { now, schedule, tick };
}

type Clock = ReturnType<typeof makeClock>;

/** One device's radio: the two passive listeners, the noise tracker behind
 *  isAirBusy, the mute gate, and a ring of recently HEARD audio. */
class Radio {
  readonly rx: RxEngine;
  readonly detector: ProbeDetector;
  private readonly noise = new AirNoiseTracker();
  private ring: number[] = [];
  muted = false;
  scanPaused = false;

  constructor(
    readonly id: number,
    private readonly clock: Clock,
    roomRef: { current: RoomProtocol | null },
  ) {
    this.rx = new RxEngine({
      useOFDM: true, sampleRate: SR, bandHandshake: true,
      pilotFreqHz: 999, toneStartHz: 12345, toneCount: 16,
    } as ConstructorParameters<typeof RxEngine>[0]);
    this.rx.onControlMessage = (msg: ControlMessage) => roomRef.current?.onMessage(msg);
    this.detector = new ProbeDetector(id, SR, (deviceId, grid, purpose) => {
      this.rx.rearmForNextControlMessage();
      roomRef.current?.onProbeHeard(deviceId, grid, purpose);
    });
  }

  /** One mic chunk, exactly as modemService's feedChunk handles it. */
  hear(chunk: Float32Array): void {
    this.ring.push(...chunk);
    const cap = Math.round(SR * 0.25);
    if (this.ring.length > cap) this.ring = this.ring.slice(this.ring.length - cap);
    if (this.muted) return;
    this.noise.update(rmsOf(chunk));
    if (this.scanPaused) return;
    this.rx.feedChunk(chunk);
    this.detector.feedChunk(chunk);
  }

  airBusy(): boolean {
    return this.noise.isBusy(rmsOf(this.ring));
  }

  /** Mute for `playMs` of playback plus the echo tail, re-arming on unmute. */
  muteFor(playMs: number): void {
    this.muted = true;
    this.clock.schedule(() => {
      this.muted = false;
      this.rx.rearmForNextControlMessage();
    }, playMs + MUTE_TAIL_MS);
  }
}

/** Deterministic ambient noise — a real mic never delivers digital silence,
 *  and AirNoiseTracker's floor (hence every carrier sense) is built from it. */
const NOISE_AMPLITUDE = 0.002;
function noiseAt(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2 * NOISE_AMPLITUDE;
}

/**
 * The air: a CONTINUOUS mic stream into every radio, CHUNK_MS at a time, with
 * whatever anyone is currently playing mixed in.
 *
 * Continuous matters as much as the timing does: the worker feeds the noise
 * tracker and the air-check ring from the mic callback, which never stops, so
 * a room modelled as "audio only exists while someone transmits" would leave
 * every carrier sense reading the last burst forever.
 */
function makeAir(clock: Clock) {
  const radios: Radio[] = [];
  const chunkSamples = Math.round((CHUNK_MS / 1000) * SR);
  const active: { fromId: number; samples: Float32Array; startSample: number }[] = [];
  let sampleCursor = 0;

  const pump = () => {
    for (const r of radios) {
      const chunk = new Float32Array(chunkSamples);
      for (let i = 0; i < chunkSamples; i++) chunk[i] = noiseAt(sampleCursor + i);
      for (const t of active) {
        if (t.fromId === r.id) continue;
        const base = sampleCursor - t.startSample;
        for (let i = 0; i < chunkSamples; i++) {
          const k = base + i;
          if (k >= 0 && k < t.samples.length) chunk[i] += t.samples[k];
        }
      }
      r.hear(chunk);
    }
    sampleCursor += chunkSamples;
    for (let i = active.length - 1; i >= 0; i--) {
      if (sampleCursor - active[i].startSample >= active[i].samples.length) active.splice(i, 1);
    }
    clock.schedule(pump, CHUNK_MS);
  };
  clock.schedule(pump, 0);

  /** Play `samples` from `fromId`; resolves when playback + echo tail is over. */
  const play = (fromId: number, samples: Float32Array): Promise<void> => {
    const playMs = (samples.length / SR) * 1000;
    const self = radios.find((r) => r.id === fromId)!;
    self.muteFor(playMs);
    active.push({ fromId, samples, startSample: sampleCursor });
    return new Promise((resolve) => {
      clock.schedule(resolve, playMs + MUTE_TAIL_MS);
    });
  };

  return { radios, play };
}

function controlTx(): TxEngine {
  return new TxEngine({
    useOFDM: true, sampleRate: SR, bandHandshake: true,
    pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32,
  } as ConstructorParameters<typeof TxEngine>[0]);
}

async function runScenario(rngValue: number): Promise<{ error: string | null; picked: boolean; armed: boolean; knows: boolean }> {
  const clock = makeClock();
  const air = makeAir(clock);
  const tx = controlTx();

  const aRef: { current: RoomProtocol | null } = { current: null };
  const bRef: { current: RoomProtocol | null } = { current: null };
  const aRadio = new Radio(A_ID, clock, aRef);
  const bRadio = new Radio(B_ID, clock, bRef);
  air.radios.push(aRadio, bRadio);

  let picked: PickedSettings | null = null;
  let armed = false;

  const deps = (id: number, radio: Radio): RoomDeps => ({
    deviceId: id,
    now: clock.now,
    rng: () => rngValue,
    schedule: clock.schedule,
    playProbe: (purpose: ProbePurpose) => air.play(id, buildProbeBurst(id, SR, purpose)),
    sendMessage: (msg: ControlMessage) =>
      air.play(id, tx.buildHandshakeSegment(encodeControlMessage(msg))),
    isAirBusy: async () => radio.airBusy(),
    startFileTx: (settings) => { picked = settings; },
    armFileRx: () => { armed = true; },
    onStateChange: (state) => {
      radio.scanPaused = state === 'sending' || state === 'receiving';
    },
  });

  const aRoom = new RoomProtocol(deps(A_ID, aRadio));
  const bRoom = new RoomProtocol(deps(B_ID, bRadio));
  aRef.current = aRoom;
  bRef.current = bRoom;

  // The join chain's own deadline, plus one whole probe burst and one whole
  // control message of real air time (~7 s) for the WELCOME exchange to
  // actually happen — none of it is instantaneous here.
  const joinMs = ROOM_TIMING.listenMs
      + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs
      + ROOM_TIMING.collectExtraMs
      + 8000;

  aRoom.start();
  await clock.tick(joinMs);
  bRoom.start();
  await clock.tick(joinMs);

  const knows = aRoom.members.get(B_ID) !== undefined && bRoom.members.get(A_ID) !== undefined;

  aRoom.sendFile(256, 10000);
  await clock.tick(joinMs + ROOM_TIMING.fileComingLeadMs + 8000);

  return { error: aRoom.lastError, picked: picked !== null, armed, knows };
}

describe('chatter room over an air that takes time', () => {
  // The reply's slot is drawn at random, and the collect window's margin
  // depends on which one it lands in — so the earliest, a middle and the last
  // slot each get a run. (rng picks an index into the slots still available.)
  for (const rngValue of [0, 0.5, 0.99]) {
    it(`a roll call collects a REPORT inside the collect window (slot draw ${rngValue})`, async () => {
      const r = await runScenario(rngValue);
      expect(r.knows, 'both devices know each other after the join').toBe(true);
      expect(r.error).toBeNull();
      expect(r.picked, 'A picked settings from a collected REPORT').toBe(true);
      expect(r.armed, 'B armed its receiver from FILE_COMING').toBe(true);
    }, TIMEOUT);
  }
});

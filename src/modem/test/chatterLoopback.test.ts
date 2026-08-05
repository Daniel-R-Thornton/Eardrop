/**
 * chatterLoopback.test.ts — end-to-end chatter room integration: two
 * RoomProtocol instances (A, B) bridged over a shared "air" of REAL audio
 * samples, proving the whole chain works together sample-accurately in one
 * in-process test: join → mutual WELCOME → roll call → REPORT → settings
 * negotiation → FILE_COMING → a real bandHandshake file transfer decoded by
 * a HandshakeReceiver.
 *
 * Bridge design (per the harness idiom in roomProtocol.test.ts + the real-
 * audio idiom in bandHandshake.test.ts / chatterWorker.test.ts): each side's
 * `playProbe`/`sendMessage` synthesizes real samples (`buildProbeBurst` /
 * `encodeControlMessage` + `TxEngine.buildHandshakeSegment`) and feeds them
 * SYNCHRONOUSLY into the OTHER side's `ProbeDetector` + chatter `RxEngine`
 * listener — never self-feed. `isAirBusy` always resolves false; turn-taking
 * is scripted by the scenario itself (a manual clock/timer wheel), not by a
 * simulated carrier-sense race.
 */
import { describe, expect, it } from 'vitest';
import { RoomProtocol, ROOM_TIMING, type RoomDeps } from '../chatter/roomProtocol';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import { HandshakeReceiver } from '../protocol/handshakeReceiver';
import { ProbeDetector } from '../../workers/modemService';
import { buildProbeBurst, PROBE_PURPOSE, type ProbePurpose } from '../protocol/probeBurst';
import { encodeControlMessage, type ControlMessage } from '../protocol/controlFrame';
import type { PickedSettings } from '../chatter/settingsPick';
import { ofdmSamples } from '../types';

const SR = 48000;
const { symSamples: SYM_LEN } = ofdmSamples(SR);
const TIMEOUT = 60000;

const A_ID = 42;
const B_ID = 99;

/** A device's RX-side surface: passive listeners fed by the OTHER side's
 *  playback, wired straight into this device's RoomProtocol. */
function makeListeners(selfId: number, room: { current: RoomProtocol | null }) {
  const listener = new RxEngine({
    useOFDM: true, sampleRate: SR, bandHandshake: true,
    pilotFreqHz: 999, toneStartHz: 12345, toneCount: 16,
  } as ConstructorParameters<typeof RxEngine>[0]);
  listener.onControlMessage = (msg: ControlMessage) => room.current?.onMessage(msg);

  const detector = new ProbeDetector(selfId, SR, (deviceId, grid, purpose) => room.current?.onProbeHeard(deviceId, grid, purpose));

  return { listener, detector };
}

/** Feed a probe burst the way a real mic stream would: padded with quiet on
 *  both sides (see chatterWorker.test.ts's ProbeDetector tests). */
function feedProbe(detector: ProbeDetector, deviceId: number, purpose: ProbePurpose = PROBE_PURPOSE.joining): void {
  const burst = buildProbeBurst(deviceId, SR, purpose);
  const pad = Math.round(SR * 0.2);
  const padded = new Float32Array(pad + burst.length + pad);
  padded.set(burst, pad);
  detector.feedChunk(padded);
}

/** Feed a control message the way chatterWorker.test.ts's control-frame test
 *  does: the handshake-segment audio, then a trailing silence flush. */
function feedControl(listener: RxEngine, controlTx: TxEngine, msg: ControlMessage): void {
  const wire = encodeControlMessage(msg);
  const audio = controlTx.buildHandshakeSegment(wire);
  listener.feedChunk(audio);
  listener.feedChunk(new Float32Array(4096));
}

/** Manual clock + timer wheel — same idiom as roomProtocol.test.ts. Draining
 *  microtasks BEFORE checking due timers matters: a timer callback's own
 *  async continuation (e.g. a dep's resolved promise scheduling the NEXT
 *  timer) must be allowed to run before we decide no more timers are due. */
function makeClock() {
  let t = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const now = () => t;
  const schedule = (fn: () => void, d: number) => {
    const rec = { at: t + d, fn, dead: false };
    timers.push(rec);
    return () => { rec.dead = true; };
  };
  const tick = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      await Promise.resolve(); await Promise.resolve();
      const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
    }
    await Promise.resolve(); await Promise.resolve();
    t = end;
  };
  return { now, schedule, tick };
}

describe('chatter loopback: join, roll call, negotiated transfer', () => {
  it(
    'A joins alone, B joins and is WELCOMEd, A sends a file B receives byte-perfect on non-floor settings',
    async () => {
      const clock = makeClock();

      const aRoomRef: { current: RoomProtocol | null } = { current: null };
      const bRoomRef: { current: RoomProtocol | null } = { current: null };

      const aListeners = makeListeners(A_ID, aRoomRef); // A's ears: hears B
      const bListeners = makeListeners(B_ID, bRoomRef); // B's ears: hears A

      // Control-message handshake-segment encoder — any bandHandshake config
      // works, since buildHandshakeSegment only touches the fixed handshake
      // band's own engine (OFDM_HANDSHAKE), not this cfg's pilot/tone fields.
      const controlTx = new TxEngine({
        useOFDM: true, sampleRate: SR, bandHandshake: true,
        pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32,
      } as ConstructorParameters<typeof TxEngine>[0]);

      let bHandshakeReceiver: HandshakeReceiver | null = null;
      let pickedSettings: PickedSettings | null = null;
      const payload = new Uint8Array(256).map((_, i) => (i * 13 + 7) & 0xff);

      const aDeps: RoomDeps = {
        deviceId: A_ID,
        now: clock.now,
        rng: () => 0, // slot 0 always — no busy air to force a re-roll in this scenario
        schedule: clock.schedule,
        playProbe: async (purpose) => feedProbe(bListeners.detector, A_ID, purpose), // B hears A
        sendMessage: async (msg) => feedControl(bListeners.listener, controlTx, msg), // B hears A
        isAirBusy: async () => false, // turn-taking is scripted by the scenario
        startFileTx: (settings) => {
          pickedSettings = settings;
          const tx = new TxEngine({
            useOFDM: true,
            sampleRate: SR,
            bandHandshake: true,
            pilotFreqHz: settings.pilotFreqHz,
            toneStartHz: settings.toneStartHz,
            toneCount: settings.toneCount,
            qamMap: settings.qamMap,
            toneGains: settings.toneGains,
          } as ConstructorParameters<typeof TxEngine>[0]);
          const audio = tx.transmitFile('loopback.bin', payload);
          expect(bHandshakeReceiver).not.toBeNull();
          bHandshakeReceiver!.feedChunk(audio);
          bHandshakeReceiver!.feedChunk(new Float32Array(SYM_LEN * 8)); // flush tail, per bandHandshake.test.ts
        },
        armFileRx: () => {
          // B's own armFileRx (below) does the real arming; A never arms.
        },
      };

      const bDeps: RoomDeps = {
        deviceId: B_ID,
        now: clock.now,
        rng: () => 0,
        schedule: clock.schedule,
        playProbe: async (purpose) => feedProbe(aListeners.detector, B_ID, purpose), // A hears B
        sendMessage: async (msg) => feedControl(aListeners.listener, controlTx, msg), // A hears B
        isAirBusy: async () => false,
        startFileTx: () => {
          throw new Error('B never sends in this scenario');
        },
        armFileRx: () => {
          bHandshakeReceiver = new HandshakeReceiver({
            useOFDM: true, sampleRate: SR,
            pilotFreqHz: 999, toneStartHz: 12345, toneCount: 16,
          } as ConstructorParameters<typeof HandshakeReceiver>[0]);
        },
      };

      const aRoom = new RoomProtocol(aDeps);
      const bRoom = new RoomProtocol(bDeps);
      aRoomRef.current = aRoom;
      bRoomRef.current = bRoom;

      // --- 1. A joins an empty room -> idle, no members. ---
      aRoom.start();
      await clock.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
      expect(aRoom.state).toBe('idle');
      expect(aRoom.members.size).toBe(0);

      // --- 2. B joins -> A hears B's probe and WELCOMEs; both idle with
      //     mutual member entries. ---
      bRoom.start();
      await clock.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
      expect(aRoom.state).toBe('idle');
      expect(bRoom.state).toBe('idle');
      expect(aRoom.members.get(B_ID)).toBeDefined();
      expect(bRoom.members.get(A_ID)).toBeDefined();

      // --- 3. A sends a file: roll-call probe -> B (already a known member)
      //     REPORTs a real measured grid -> A picks non-floor settings ->
      //     FILE_COMING decodes at B -> B arms a HandshakeReceiver. ---
      aRoom.sendFile(payload.length, 10000);
      await clock.tick(
        ROOM_TIMING.listenMs
        + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs
        + ROOM_TIMING.collectExtraMs
        + ROOM_TIMING.fileComingLeadMs
        + 300,
      );

      expect(aRoom.lastError).toBeNull();
      expect(pickedSettings).not.toBeNull();
      expect(pickedSettings!.floor).toBe(false); // clean simulated channel
      expect(bHandshakeReceiver).not.toBeNull();

      // --- 4. A's 256-byte transfer decodes at B, byte-perfect. ---
      const file = bHandshakeReceiver!.getFile();
      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );
});

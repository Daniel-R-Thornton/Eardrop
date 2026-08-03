/**
 * chatterWorker.test.ts — worker chatter mode: probe detection, control
 * frames on the fixed handshake band, and carrier-sense air check.
 *
 * Pure-logic pieces only (no real Worker): ProbeDetector fed real probe-burst
 * and sync-chirp audio, TxEngine.buildHandshakeSegment + RxEngine's control
 * frame path round-tripping a real ControlMessage, and the AirNoiseTracker
 * EMA against real RMS levels.
 */
import { describe, expect, it } from 'vitest';
import { ProbeDetector, AirNoiseTracker, rmsOf } from '../../workers/modemService';
import { buildProbeBurst } from '../protocol/probeBurst';
import { generateChirp } from '../protocol/chirp';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import { ControlType, type ControlMessage, encodeControlMessage } from '../protocol/controlFrame';
import { SentinelScanner } from '../receiver/SentinelScanner';

const SR = 48000;
const TIMEOUT = 60000;

/** Feed a Float32Array through a ProbeDetector in fixed-size chunks, the way
 *  the worker's feedChunk command does. */
function feedInChunks(det: ProbeDetector, samples: Float32Array, chunkSize = 4096): void {
  for (let i = 0; i < samples.length; i += chunkSize) {
    det.feedChunk(samples.subarray(i, Math.min(i + chunkSize, samples.length)));
  }
}

describe('ProbeDetector', () => {
  it(
    'decodes a real probe burst fed in worker-sized chunks',
    () => {
      const burst = buildProbeBurst(7, SR);
      const heard: Array<{ deviceId: number; grid: number[] }> = [];
      const det = new ProbeDetector(0, SR, (deviceId, grid) => heard.push({ deviceId, grid }));
      // Pad with a little silence on both sides — a real feed never starts
      // exactly at the burst.
      const padded = new Float32Array(SR * 0.2 + burst.length + SR * 0.2);
      padded.set(burst, SR * 0.2);
      feedInChunks(det, padded);
      expect(heard).toHaveLength(1);
      expect(heard[0].deviceId).toBe(7);
      expect(heard[0].grid).toHaveLength(64);
    },
    TIMEOUT,
  );

  it('does not fire on its own device ID', () => {
    const burst = buildProbeBurst(7, SR);
    const heard: number[] = [];
    const det = new ProbeDetector(7, SR, (deviceId) => heard.push(deviceId));
    feedInChunks(det, burst);
    expect(heard).toHaveLength(0);
  });

  it(
    "does not fire on the modem's own UP-chirp sync burst",
    () => {
      // Same sweep range as the probe's down-chirp, but the modem's own
      // (up) direction — this is exactly the shape probe detection must
      // reject, per probeBurst.ts's design rationale.
      const upChirp = generateChirp({ fStart: 1200, fEnd: 4400, durationSec: 0.15, sampleRate: SR, amplitude: 0.5 });
      const withNoise = new Float32Array(SR * 0.2 + upChirp.length + SR * 0.2);
      withNoise.set(upChirp, SR * 0.2);
      let seed = 7;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
      for (let i = 0; i < withNoise.length; i++) withNoise[i] += (rnd() - 0.5) * 0.01;

      const heard: number[] = [];
      const det = new ProbeDetector(0, SR, (deviceId) => heard.push(deviceId));
      feedInChunks(det, withNoise);
      expect(heard).toHaveLength(0);
    },
    TIMEOUT,
  );
});

describe('AirNoiseTracker', () => {
  it('seeds on the first chunk, then flags a loud burst busy and silence clear', () => {
    const tracker = new AirNoiseTracker();
    const silence = new Float32Array(2048); // all zero — seeds the floor at 0
    tracker.update(rmsOf(silence));
    expect(tracker.noiseFloor).toBe(0);

    const loud = new Float32Array(2048).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR));
    tracker.update(rmsOf(loud));
    expect(tracker.isBusy(rmsOf(loud))).toBe(true);

    // A later quiet chunk reads as clear.
    expect(tracker.isBusy(rmsOf(silence))).toBe(false);
  });

  it('a loud chunk never drags the floor up to meet it', () => {
    const tracker = new AirNoiseTracker();
    const quiet = new Float32Array(2048).map(() => 0.001);
    tracker.update(rmsOf(quiet)); // seed
    const loud = new Float32Array(2048).map((_, i) => 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR));
    for (let n = 0; n < 20; n++) tracker.update(rmsOf(loud));
    // Floor should still be near the quiet level, not the loud one.
    expect(tracker.noiseFloor).toBeLessThan(rmsOf(loud) / 3);
  });

  it('recovers from a too-quiet seed instead of reporting busy forever', () => {
    // The first chunk after a mic starts is often near-silence, which seeds
    // the floor far below the real room. Every later chunk then sits above
    // 3x that seed. If the floor can only move while the air reads clear, it
    // never moves again and the air is busy forever — a join burns its whole
    // carrier-sense cap before every announce, which is exactly what was seen
    // on hardware.
    const tracker = new AirNoiseTracker();
    tracker.update(rmsOf(new Float32Array(2048).map(() => 1e-6))) // near-silent seed
    ;
    const room = new Float32Array(2048).map((_, i) => 0.01 * Math.sin((2 * Math.PI * 300 * i) / SR));
    expect(tracker.isBusy(rmsOf(room))).toBe(true); // busy at first, correctly

    // Steady room tone is the new normal — a few seconds of it must lift the
    // floor enough that the room alone no longer counts as a transmission.
    for (let n = 0; n < 400; n++) tracker.update(rmsOf(room));
    expect(tracker.isBusy(rmsOf(room))).toBe(false);

    // ...while a genuinely loud burst over that room still reads busy.
    const burst = new Float32Array(2048).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR));
    expect(tracker.isBusy(rmsOf(burst))).toBe(true);
  });
});

describe('control frames on the handshake band', () => {
  it(
    'RxEngine decodes a real control message built via TxEngine.buildHandshakeSegment',
    () => {
      const msg: ControlMessage = {
        type: ControlType.Bye,
        senderId: 3,
        targetId: 0,
        payload: new Uint8Array([1, 2, 3, 4, 5]),
      };
      const wire = encodeControlMessage(msg);

      const tx = new TxEngine({
        useOFDM: true,
        sampleRate: SR,
        bandHandshake: true,
        pilotFreqHz: 6300,
        toneStartHz: 600,
        toneCount: 32,
      } as ConstructorParameters<typeof TxEngine>[0]);
      const audio = tx.buildHandshakeSegment(wire);

      const rx = new RxEngine({
        useOFDM: true,
        sampleRate: SR,
        bandHandshake: true,
        pilotFreqHz: 999,
        toneStartHz: 12345,
        toneCount: 16,
      } as ConstructorParameters<typeof RxEngine>[0]);

      let received: ControlMessage | null = null;
      rx.onControlMessage = (m) => { received = m; };
      rx.feedChunk(audio);
      rx.feedChunk(new Float32Array(4096));

      expect(received).not.toBeNull();
      expect(received!.type).toBe(ControlType.Bye);
      expect(received!.senderId).toBe(3);
      expect(received!.targetId).toBe(0);
      expect(Array.from(received!.payload)).toEqual([1, 2, 3, 4, 5]);
    },
    TIMEOUT,
  );

  it('encodeControl audio does not falsely decode as a band card', () => {
    // decodeBandCard must reject a control header's magic byte, exercised
    // implicitly above by getting a controlMessage and no onBandCard call.
    const msg: ControlMessage = {
      type: ControlType.Welcome,
      senderId: 1,
      targetId: 0,
      payload: new Uint8Array(0),
    };
    const wire = encodeControlMessage(msg);
    const tx = new TxEngine({
      useOFDM: true, sampleRate: SR, bandHandshake: true,
      pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32,
    } as ConstructorParameters<typeof TxEngine>[0]);
    const audio = tx.buildHandshakeSegment(wire);

    const rx = new RxEngine({
      useOFDM: true, sampleRate: SR, bandHandshake: true,
      pilotFreqHz: 999, toneStartHz: 12345, toneCount: 16,
    } as ConstructorParameters<typeof RxEngine>[0]);
    let cardSeen = false;
    let msgSeen = false;
    rx.onBandCard = () => { cardSeen = true; };
    rx.onControlMessage = () => { msgSeen = true; };
    rx.feedChunk(audio);
    rx.feedChunk(new Float32Array(4096));

    expect(cardSeen).toBe(false);
    expect(msgSeen).toBe(true);
  });
});

describe('SentinelScanner: reset mid-collection', () => {
  const SENTINEL_BYTES = [0xe7, 0x9f, 0xe7];

  it('reset() during a continueCollecting run restores the header size for the NEXT sentinel', () => {
    const HEADER_BYTES = 5;
    const scanner = new SentinelScanner(HEADER_BYTES);
    const frames: Uint8Array[] = [];

    // First header: fires onFrame, which asks for 3 MORE (payload) bytes —
    // simulating a control message's header telling the scanner its
    // payload length — then reset() lands mid-way through that payload run
    // (e.g. a config change or chatterStop tearing the engine down).
    let continued = false;
    scanner.onFrame = (f) => {
      frames.push(f);
      if (!continued) {
        continued = true;
        scanner.continueCollecting(3);
      }
    };
    for (const b of SENTINEL_BYTES) scanner.feedByte(b);
    for (let i = 0; i < HEADER_BYTES; i++) scanner.feedByte(0xaa);
    expect(frames).toHaveLength(1); // header fired, now mid-payload-collection

    scanner.reset(); // <- must restore collectBytes to the header size

    // A fresh sentinel + header-sized run must collect at HEADER_BYTES, not
    // the stale 3-byte payload size from the interrupted run.
    scanner.onFrame = (f) => frames.push(f);
    for (const b of SENTINEL_BYTES) scanner.feedByte(b);
    for (let i = 0; i < HEADER_BYTES; i++) scanner.feedByte(0xbb);

    expect(frames).toHaveLength(2);
    expect(frames[1]).toHaveLength(3 + HEADER_BYTES); // sentinel + full header, not a short 3-byte frame
    expect(Array.from(frames[1].slice(3))).toEqual(new Array(HEADER_BYTES).fill(0xbb));
  });
});

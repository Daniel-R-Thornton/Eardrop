/**
 * linkProfile_integration.test.ts — Phase 4 link-profile frame, full
 * TxEngine → RxEngine pipeline (OFDM).
 *
 * Verifies:
 *   - flag OFF (default): no profile frame emitted, RX stays on default
 *     profile, decode still works, and the waveform is unchanged (covered
 *     separately by streamChunks.test.ts byte-identity).
 *   - flag ON: RX's getLinkProfile() reflects the sent (default-content)
 *     profile and the file still decodes byte-exact.
 */
import { describe, it, expect } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { DEFAULT_LINK_PROFILE, packLinkProfile } from '../protocol/linkProfile';
import { encodeFrame, FRAME_TYPE_PROFILE } from '../protocol/atomicFrame';
import { ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;
const TONE_COUNT = 16;
const TIMEOUT = 30000;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);

function makeTx(emitLinkProfile: boolean) {
  return new TxEngine({
    useOFDM: true,
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: TONE_COUNT,
    emitLinkProfile,
  } as ConstructorParameters<typeof TxEngine>[0]);
}

function makeRx() {
  return new RxEngine({
    useOFDM: true,
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: TONE_COUNT,
  } as ConstructorParameters<typeof RxEngine>[0]);
}

function runRoundtrip(
  tx: TxEngine,
  rx: RxEngine,
  payload: Uint8Array,
  fileName: string,
): ReceivedFile | null {
  const audio = tx.transmitFile(fileName, payload);
  for (let i = 0; i < audio.length; i++) rx.feedSample(audio[i]);
  // Extra runoff so the last frame's demodulation/assembly fully flushes
  // (mirrors rxEngine_chunk.test.ts's tail padding for the same reason).
  const tail = symSamplesTail();
  for (let i = 0; i < tail.length; i++) rx.feedSample(tail[i]);
  return rx.getFile();
}

function symSamplesTail(): Float32Array {
  return new Float32Array(SYM_LEN * 8);
}

describe('Phase 4: link-profile frame (TxEngine → RxEngine)', () => {
  it(
    'flag OFF (default): RX stays on default profile, file still decodes',
    () => {
      const payload = new Uint8Array(64);
      for (let i = 0; i < 64; i++) payload[i] = i;

      const tx = makeTx(false);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'off.bin');

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));

      const profile = rx.getLinkProfile();
      expect(profile).toEqual(DEFAULT_LINK_PROFILE(TONE_COUNT));
    },
    TIMEOUT,
  );

  it(
    'flag ON: RX getLinkProfile() reflects the sent profile, file still decodes byte-exact',
    () => {
      const payload = new Uint8Array(128);
      for (let i = 0; i < 128; i++) payload[i] = (i * 7 + 3) & 0xff;

      const tx = makeTx(true);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'on.bin');

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));

      const profile = rx.getLinkProfile();
      expect(profile).toEqual(DEFAULT_LINK_PROFILE(TONE_COUNT));
    },
    TIMEOUT,
  );

  it(
    'flag ON: emitted audio is longer than flag OFF (profile frames add airtime)',
    () => {
      const payload = new Uint8Array(64);
      for (let i = 0; i < 64; i++) payload[i] = i;

      const audioOff = makeTx(false).transmitFile('a.bin', payload);
      const audioOn = makeTx(true).transmitFile('a.bin', payload);

      expect(audioOn.length).toBeGreaterThan(audioOff.length);
    },
    TIMEOUT,
  );

  it(
    'legacy (no profile frame): RX stays on default profile, payload still decodes',
    () => {
      const payload = new Uint8Array(32);
      for (let i = 0; i < 32; i++) payload[i] = 0xaa;

      const tx = makeTx(false);
      const rx = makeRx();
      const file = runRoundtrip(tx, rx, payload, 'legacy.bin');

      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
      expect(rx.getLinkProfile()).toEqual(DEFAULT_LINK_PROFILE(TONE_COUNT));
    },
    TIMEOUT,
  );

  it('processFrame: a valid 0x04 frame updates getLinkProfile(); a corrupted one is ignored', () => {
    const rx = makeRx();
    const processFrame = (rx as unknown as { processFrame: (f: Uint8Array) => void }).processFrame.bind(
      rx,
    );

    // Valid profile announcing non-default eccT/cpId — proves storage, not
    // just "matches default" (P4 doesn't interpret it, just stores it).
    const sentProfile = {
      ver: 2,
      flags: 0,
      eccT: 2,
      cpId: 1,
      toneCount: TONE_COUNT,
      pilotFreqHz: 0,
      toneStartHz: 0,
      qamMap: new Array(TONE_COUNT).fill(0),
    };
    const goodPayload = packLinkProfile(sentProfile);
    const goodFrame = encodeFrame({ type: FRAME_TYPE_PROFILE, seqNum: 0, totalFrames: 3, crc: 0 }, goodPayload);
    processFrame(goodFrame);
    expect(rx.getLinkProfile()).toEqual(sentProfile);

    // Now feed a corrupted profile frame (flipped payload byte → crc fails).
    // RX must ignore it and keep the previously-stored (or default) profile —
    // it must NOT crash and must NOT reset to default on a bad frame.
    const corruptPayload = new Uint8Array(goodPayload);
    corruptPayload[6] ^= 0xff;
    const corruptFrame = encodeFrame(
      { type: FRAME_TYPE_PROFILE, seqNum: 0, totalFrames: 3, crc: 0 },
      corruptPayload,
    );
    expect(() => processFrame(corruptFrame)).not.toThrow();
    expect(rx.getLinkProfile()).toEqual(sentProfile);
  });

  it('a legacy RX (unknown 0x04 handling) simulation: unknown-type frames are silently dropped', () => {
    // Simulates "a legacy RX given a profile-bearing stream" from the other
    // direction: an RX seeing a frame type it doesn't recognise (here we use
    // an out-of-range type) must not throw and must not corrupt file state.
    const rx = makeRx();
    const processFrame = (rx as unknown as { processFrame: (f: Uint8Array) => void }).processFrame.bind(
      rx,
    );
    const payload = new Uint8Array(160);
    const frame = encodeFrame({ type: 0x05, seqNum: 0, totalFrames: 3, crc: 0 }, payload);
    expect(() => processFrame(frame)).not.toThrow();
    expect(rx.getLinkProfile()).toEqual(DEFAULT_LINK_PROFILE(TONE_COUNT));
    expect(rx.getFile()).toBeNull();
  });
});

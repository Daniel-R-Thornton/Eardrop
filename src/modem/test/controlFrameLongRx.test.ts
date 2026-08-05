import { describe, expect, it } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import {
  encodeControlMessage, ControlType, packText, parseText, TEXT_MAX_BYTES,
  type ControlMessage,
} from '../protocol/controlFrame';
import { OFDM_DEFAULTS } from '../types';

const SR = 48000;

function buildControlAudio(msg: ControlMessage): Float32Array {
  const tx = new TxEngine({
    useOFDM: true,
    bandHandshake: true,
    sampleRate: SR,
    pilotFreqHz: OFDM_DEFAULTS.pilotFreqHz,
    toneStartHz: OFDM_DEFAULTS.toneStartHz,
    toneCount: OFDM_DEFAULTS.toneCount,
  } as ConstructorParameters<typeof TxEngine>[0]);
  return tx.buildHandshakeSegment(encodeControlMessage(msg));
}

function decodeControl(audio: Float32Array): ControlMessage | null {
  let got: ControlMessage | null = null;
  const rx = new RxEngine({
    useOFDM: true,
    bandHandshake: true,
    sampleRate: SR,
  } as ConstructorParameters<typeof RxEngine>[0]);
  rx.onControlMessage = (m) => { got = m; };
  rx.feedChunk(audio);
  // Trailing silence so the last symbols are consumed.
  rx.feedChunk(new Float32Array(SR));
  return got;
}

describe('long control messages survive the sync watchdog', () => {
  it('decodes a maximum-length TEXT message', () => {
    // ~10.4 s of audio — four times longer than any control message the
    // plane previously carried, and well past the 5 s watchdog. Without the
    // length-aware grace the receiver resets to WAITING mid-message and this
    // returns null.
    const text = 'x'.repeat(TEXT_MAX_BYTES);
    const audio = buildControlAudio({
      type: ControlType.Text, senderId: 4, targetId: 0, payload: packText(11, text),
    });
    expect(audio.length / SR).toBeGreaterThan(6); // sanity: this really is long

    const got = decodeControl(audio);
    expect(got).not.toBeNull();
    expect(got!.type).toBe(ControlType.Text);
    expect(parseText(got!.payload)).toEqual({ msgId: 11, text });
  });

  it('still decodes a short control message', () => {
    // The grace must not break the ordinary case.
    const audio = buildControlAudio({
      type: ControlType.Text, senderId: 4, targetId: 9, payload: packText(1, 'hi'),
    });
    const got = decodeControl(audio);
    expect(parseText(got!.payload)).toEqual({ msgId: 1, text: 'hi' });
  });

  it('a sync with no valid control header earns no grace', () => {
    // A false sync must still reset on the plain 5 s watchdog, which is the
    // whole reason the watchdog exists. Feed noise long enough that any
    // extended deadline would be visible, then a real short message: if the
    // engine were stuck holding a grace it never earned, this would fail.
    const rx = new RxEngine({
      useOFDM: true, bandHandshake: true, sampleRate: SR,
    } as ConstructorParameters<typeof RxEngine>[0]);
    let got: ControlMessage | null = null;
    rx.onControlMessage = (m) => { got = m; };

    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const noise = new Float32Array(SR * 12);
    for (let i = 0; i < noise.length; i++) noise[i] = (rnd() - 0.5) * 0.2;
    rx.feedChunk(noise);

    rx.feedChunk(buildControlAudio({
      type: ControlType.Text, senderId: 4, targetId: 0, payload: packText(2, 'after noise'),
    }));
    rx.feedChunk(new Float32Array(SR));
    expect(parseText(got!.payload)).toEqual({ msgId: 2, text: 'after noise' });
  });
});

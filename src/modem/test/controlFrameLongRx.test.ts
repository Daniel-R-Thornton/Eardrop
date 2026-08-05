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

  it('rearmForNextControlMessage clears a grace earned but not yet spent', () => {
    // rearmForNextControlMessage() is the one path that can abort a payload
    // run mid-flight — the host calls it on a probe burst, an unpaused
    // chatter scan, or un-mute after our own TX (see modemService.ts). If it
    // doesn't clear ofdmWatchdogGraceWindows, a grace earned by a long
    // message's header survives into the NEXT sync — quite possibly a false
    // one on whatever interrupted us, which is exactly the case the plain
    // 5 s watchdog exists to bound: a leaked ~344-window grace would turn
    // that false sync's deadline into ~544 windows (~13.6 s) instead of the
    // plain ~200 (~5 s), which is within reach of the 601-window incident
    // this watchdog was written to prevent.
    //
    // This drives the REAL abort sequence — decode a maximum-length TEXT's
    // header via processCard (earning the grace) without letting the payload
    // run finish, then call the real rearmForNextControlMessage() — and
    // checks the field directly, which pins the mechanism rather than only
    // an indirect consequence.
    //
    // NOT extended to "and a following message still decodes": rearm also
    // leaves chirpDetected/chirpEndSample and the SentinelScanner's
    // mid-collection state untouched (the same leftover-state category as
    // pendingControlHeader, already flagged pre-existing and out of scope).
    // Feeding more audio after this abort exercises THOSE gaps, not the one
    // this task fixes, and produced a stale chirp handoff using the aborted
    // message's own leftover anchor rather than a clean resync — unreliable
    // for pinning this specific fix. See the report's Important-1 follow-up
    // for detail.
    const text = 'x'.repeat(TEXT_MAX_BYTES);
    const longAudio = buildControlAudio({
      type: ControlType.Text, senderId: 4, targetId: 0, payload: packText(11, text),
    });

    const rx = new RxEngine({
      useOFDM: true, bandHandshake: true, sampleRate: SR,
    } as ConstructorParameters<typeof RxEngine>[0]);
    let got: ControlMessage | null = null;
    rx.onControlMessage = (m) => { got = m; };

    // Feed only the front of the long message — enough for the preamble and
    // control header to decode (short messages fully round-trip in ~2 s, so
    // the header itself is well within the first 3 s), but stop long before
    // the ~10.4 s payload run completes.
    rx.feedChunk(longAudio.slice(0, SR * 3));
    expect(got).toBeNull(); // payload run not yet complete
    expect((rx as unknown as { ofdmWatchdogGraceWindows: number }).ofdmWatchdogGraceWindows)
      .toBeGreaterThan(0); // the header WAS decoded and DID earn a grace

    rx.rearmForNextControlMessage();
    expect((rx as unknown as { ofdmWatchdogGraceWindows: number }).ofdmWatchdogGraceWindows)
      .toBe(0); // the abort must clear it, not just re-arm sync
  });
});

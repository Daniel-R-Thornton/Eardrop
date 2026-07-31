/**
 * bandHandshake.test.ts — fixed-handshake-band protocol.
 *
 * Problem: the profile frame is OFDM on the very tones it describes, so a
 * receiver cannot learn the band from it — both sides had to be configured
 * by hand. With bandHandshake enabled, TX transmits its chirp + preamble +
 * profile frames on a FIXED, universally-known base config
 * (OFDM_HANDSHAKE), the v2 profile announces the real band (pilot, tone
 * start, count, qamMap) with the band-hop flag, a second settle+training
 * preamble follows in the target band, and the data frames ride there. A
 * receiver needs nothing but the flag: it listens on OFDM_HANDSHAKE and
 * follows the announcement.
 *
 * Flag OFF must stay byte-identical to today's waveform (covered by the
 * existing byte-identity tests; asserted structurally here).
 */
import { describe, expect, it } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import { OFDM_HANDSHAKE, OFDM_TUNING, ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);
const TIMEOUT = 60000;

/** Target config deliberately different from the handshake config. */
const TARGET = { pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32 };

function makeTx(overrides: Record<string, unknown> = {}) {
  return new TxEngine({
    useOFDM: true,
    sampleRate: SAMPLE_RATE,
    emitLinkProfile: true,
    ...TARGET,
    ...overrides,
  } as ConstructorParameters<typeof TxEngine>[0]);
}

describe('band handshake: TX', () => {
  it(
    'flag ON inserts a second settle+training preamble after the profile frames',
    () => {
      const payload = new Uint8Array(64).map((_, i) => i);
      const secondPreambleLen =
        (OFDM_TUNING.trainingSettleSymbols + OFDM_TUNING.trainingSymbols) * SYM_LEN;

      const segments = (tx: TxEngine) =>
        Array.from(
          (tx as unknown as { frameSegments(n: string, d: Uint8Array): Generator<Float32Array> })
            .frameSegments('a.bin', payload),
        );

      const on = segments(makeTx({ bandHandshake: true }));
      // Segment 0 is chirp+settle+training (handshake band); the second
      // preamble is its own segment of exactly settle+training symbols.
      expect(on.slice(1).some((seg) => seg.length === secondPreambleLen)).toBe(true);

      const off = segments(makeTx());
      expect(off.slice(1).some((seg) => seg.length === secondPreambleLen)).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'flag ON transmission is longer than flag OFF by at least the second preamble',
    () => {
      const payload = new Uint8Array(64).map((_, i) => i);
      const on = makeTx({ bandHandshake: true }).transmitFile('a.bin', payload);
      const off = makeTx().transmitFile('a.bin', payload);
      const secondPreambleLen =
        (OFDM_TUNING.trainingSettleSymbols + OFDM_TUNING.trainingSymbols) * SYM_LEN;
      expect(on.length - off.length).toBeGreaterThanOrEqual(secondPreambleLen);
    },
    TIMEOUT,
  );
});

describe('band handshake: RX end-to-end (the oracle)', () => {
  const roundtrip = (txOverrides: Record<string, unknown>, payloadLen = 96) => {
    const payload = new Uint8Array(payloadLen).map((_, i) => (i * 7 + 3) & 0xff);
    const tx = makeTx({ bandHandshake: true, ...txOverrides });
    // RX knows NOTHING about the target band — only the handshake flag.
    // Its configured band fields are garbage on purpose.
    const rx = new RxEngine({
      useOFDM: true,
      sampleRate: SAMPLE_RATE,
      bandHandshake: true,
      pilotFreqHz: 999,
      toneStartHz: 12345,
      toneCount: 16,
    } as ConstructorParameters<typeof RxEngine>[0]);

    const audio = tx.transmitFile('h.bin', payload);
    for (let i = 0; i < audio.length; i++) rx.feedSample(audio[i]);
    const tail = new Float32Array(SYM_LEN * 8);
    for (let i = 0; i < tail.length; i++) rx.feedSample(tail[i]);
    return { file: rx.getFile(), payload };
  };

  it(
    'decodes a QPSK transfer on a band the RX was never configured for',
    () => {
      const { file, payload } = roundtrip({});
      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );

  it(
    'decodes a 16-QAM transfer via handshake',
    () => {
      const { file, payload } = roundtrip({ qamMap: new Array(TARGET.toneCount).fill(1) });
      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );

  it(
    'handshake constants cover the RX listening config',
    () => {
      // The whole point: OFDM_HANDSHAKE is the only shared knowledge.
      expect(OFDM_HANDSHAKE.toneCount % 4).toBe(0);
      expect(OFDM_HANDSHAKE.pilotFreqHz).toBeGreaterThan(0);
      expect(OFDM_HANDSHAKE.toneStartHz).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});

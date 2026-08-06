/**
 * bandHandshake.test.ts — fixed-band handshake protocol (band-card design).
 *
 * Problem: a receiver cannot learn the band from a transmission it can't
 * tune to. With bandHandshake enabled, TX opens with a self-contained
 * announcement on a FIXED, universally-known band (OFDM_HANDSHAKE): full
 * preamble (chirp + settle + training) + the band card ×3 (bandCard.ts —
 * pilot, tone start, tone count, settle, bin/table coded into 27 wire
 * bytes). Then the ENTIRE normal transmission follows in the target band,
 * byte-identical to a flag-off send — its own chirp, preamble and (when the
 * qamMap needs one) in-band link profile. The receiver listens on
 * OFDM_HANDSHAKE, decodes the card, and swaps in a factory-fresh engine for
 * the announced band (HandshakeReceiver) — no boundary, PLL or channel
 * state survives the hop.
 *
 * Flag OFF must stay byte-identical to today's waveform (covered by the
 * existing byte-identity tests; asserted structurally here).
 */
import { describe, expect, it } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import { HandshakeReceiver } from '../protocol/handshakeReceiver';
import { OFDMEngine } from '../protocol/ofdmEngine';
import { OFDM_DEFAULTS, OFDM_HANDSHAKE, OFDM_TUNING, ofdmSamples } from '../types';

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

const transmit = (tx: TxEngine, payload: Uint8Array) => tx.transmitFile('a.bin', payload);

describe('band handshake: TX', () => {
  const payload = new Uint8Array(64).map((_, i) => i);

  it(
    'flag ON opens with a full fixed-band preamble segment',
    () => {
      const segments = Array.from(
        (makeTx({ bandHandshake: true }) as unknown as {
          frameSegments(n: string, d: Uint8Array): Generator<Float32Array>;
        }).frameSegments('a.bin', payload),
      );
      const handshakePreambleLen =
        (OFDM_TUNING.chirpSymbols
          + OFDM_TUNING.trainingSettleSymbols
          + OFDM_TUNING.trainingSymbols) * SYM_LEN;
      expect(segments[0].length).toBe(handshakePreambleLen);
      // Card ×3: three identical short segments right after the preamble.
      expect(segments[1].length).toBe(segments[2].length);
      expect(segments[2].length).toBe(segments[3].length);
      expect(Array.from(segments[1])).toEqual(Array.from(segments[2]));
      // Silence gap after the cards, before the target-band preamble — the
      // post-hop engine must meet the target chirp the way a cold RX does.
      expect(segments[4].length).toBe(OFDM_HANDSHAKE.gapSymbols * SYM_LEN);
      expect(segments[4].every((s) => s === 0)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'listener discard lands the target engine inside the silence gap',
    () => {
      const audio = transmit(makeTx({ bandHandshake: true }), payload);
      const listener = new RxEngine({
        useOFDM: true, sampleRate: SAMPLE_RATE, bandHandshake: true,
        pilotFreqHz: 999, toneStartHz: 12345, toneCount: 16,
      } as ConstructorParameters<typeof RxEngine>[0]);
      let landing = -1;
      listener.onBandCard = () => {
        landing = 0; // resolved below once we know the current feed index
      };
      let i = 0;
      for (; i < audio.length && landing < 0; i++) listener.feedSample(audio[i]);
      expect(landing).toBe(0);
      const discard = listener.handshakeSegmentRemaining();
      expect(discard).not.toBeNull();
      // The first sample the target engine would receive, and a couple of
      // symbols after it, must be inside the TX's silence gap.
      const start = i + discard!;
      const probe = audio.slice(start, start + 2 * SYM_LEN);
      expect(probe.length).toBe(2 * SYM_LEN);
      expect(Math.max(...probe.map(Math.abs))).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'flag ON transmission = handshake segment + the EXACT flag-off waveform',
    () => {
      const on = transmit(makeTx({ bandHandshake: true }), payload);
      const off = transmit(makeTx(), payload);
      expect(on.length).toBeGreaterThan(off.length);
      const suffix = on.slice(on.length - off.length);
      expect(Array.from(suffix)).toEqual(Array.from(off));
    },
    TIMEOUT,
  );

  it(
    'handshake segment ignores the settle override (wire constant), card carries it',
    () => {
      // Different settle overrides must not change the handshake segment —
      // a zero-config receiver has to predict its length from OFDM_TUNING.
      const seg0 = (settle: number) =>
        Array.from(
          (makeTx({ bandHandshake: true, trainingSettleSymbols: settle }) as unknown as {
            frameSegments(n: string, d: Uint8Array): Generator<Float32Array>;
          }).frameSegments('a.bin', payload),
        )[0].length;
      expect(seg0(4)).toBe(seg0(24));
    },
    TIMEOUT,
  );

  it(
    'estimateStreamSamples matches the streamed length with the flag on',
    () => {
      const est = makeTx({ bandHandshake: true }).estimateStreamSamples(payload.length);
      let actual = 0;
      for (const chunk of makeTx({ bandHandshake: true }).streamChunks('a.bin', payload, 4096)) {
        actual += chunk.length;
      }
      expect(Math.abs(est - actual) / actual).toBeLessThan(0.05);
    },
    TIMEOUT,
  );

  it(
    'puts the handshake segment chirp on the handshake band\'s own centre, not the target band\'s',
    () => {
      // The chirp is the loudest thing in a transmission and the chain
      // compresses per band, so it must not sit next to the tones it precedes
      // (types.ts documents a 17 dB received-level swing and zero decoded
      // frames from exactly that). The handshake band therefore carries its
      // own chirp centre, and the target band keeps OFDM_TUNING's.
      expect(OFDM_HANDSHAKE.chirpCenterHz).not.toBe(OFDM_TUNING.chirpCenterHz);

      const handshake = new OFDMEngine({
        sampleRate: SAMPLE_RATE,
        toneCount: OFDM_HANDSHAKE.toneCount,
        pilotFreqHz: OFDM_HANDSHAKE.pilotFreqHz,
        toneStartHz: OFDM_HANDSHAKE.toneStartHz,
        chirpCenterHz: OFDM_HANDSHAKE.chirpCenterHz,
      });
      const target = new OFDMEngine({ sampleRate: SAMPLE_RATE, toneCount: 32 });

      const hsCfg = handshake.generateChirpBurst(OFDM_TUNING.chirpSymbols).chirpCfg;
      const tgtCfg = target.generateChirpBurst(OFDM_TUNING.chirpSymbols).chirpCfg;

      expect((hsCfg.fStart + hsCfg.fEnd) / 2).toBeCloseTo(OFDM_HANDSHAKE.chirpCenterHz, 6);
      expect((tgtCfg.fStart + tgtCfg.fEnd) / 2).toBeCloseTo(OFDM_TUNING.chirpCenterHz, 6);
    },
    TIMEOUT,
  );

  it('keeps the handshake band inside the hardware sweet spot and clear of its chirp', () => {
    // This band carries every control message. At 6900-7250 Hz it sat where
    // phone speakers and mics are both worst, which is a single point of
    // failure for the whole control plane.
    const firstTone = OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz;
    const lastTone = firstTone + (OFDM_HANDSHAKE.toneCount - 1) * OFDM_DEFAULTS.toneSpacingHz;

    expect(firstTone).toBe(2600);
    expect(lastTone).toBe(2950);

    // Pilot phase is extrapolated to each tone by toneFreq/pilotFreq, so any
    // error in the pilot measurement is multiplied by this. 3.9 shipped
    // broken; 1.15 was fine. Same invariant as tuning.test.ts's "handshake
    // pilot sits directly below its tones" — 1.6 is the live 1.475 ratio plus
    // headroom, not a measured safety threshold, so if either assertion ever
    // needs raising, raise both together and re-check the margin is still
    // meaningful (headroom over 1.475 is already only ~8%).
    expect(lastTone / OFDM_HANDSHAKE.pilotFreqHz).toBeLessThan(1.6);

    // The chirp must stay far from the tones it precedes — 500 Hz was not
    // enough (types.ts documents the 17 dB swing).
    const halfSpan = 100; // OFDMEngine's default chirpSpanHz is 200
    expect(OFDM_HANDSHAKE.chirpCenterHz - halfSpan - lastTone).toBeGreaterThan(1000);
  });
});

describe('band handshake: RX end-to-end (the oracle)', () => {
  const roundtrip = (txOverrides: Record<string, unknown>, payloadLen = 96) => {
    const payload = new Uint8Array(payloadLen).map((_, i) => (i * 7 + 3) & 0xff);
    const tx = makeTx({ bandHandshake: true, ...txOverrides });
    // RX knows NOTHING about the target band — only the handshake flag.
    // Its configured band fields are garbage on purpose, and it does NOT
    // get the TX's settle override — the card carries that.
    const rx = new HandshakeReceiver({
      useOFDM: true,
      sampleRate: SAMPLE_RATE,
      pilotFreqHz: 999,
      toneStartHz: 12345,
      toneCount: 16,
    } as ConstructorParameters<typeof HandshakeReceiver>[0]);

    const audio = transmit(tx, payload);
    rx.feedChunk(audio);
    rx.feedChunk(new Float32Array(SYM_LEN * 8));
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
    'non-chirp energy before a transfer does not make the card listener deaf to it',
    () => {
      // The card listener is the thing that must hear the band card and hop.
      // Everything it needs to hear opens with a chirp (frameSegments' own
      // handshake preamble), so an energy-fallback sync on it can only ever be
      // a FALSE one — and firing costs 15 s of deafness, because with no
      // onControlMessage this engine takes the long watchdog. The card is sent
      // three times precisely because losing it kills the whole transfer;
      // being deaf for fifteen seconds loses all three copies at once.
      //
      // Observed on hardware as `!ES` then `!WD 601` on the receiving device,
      // with no `HR` (card decoded) and no `HH` (hopped) row anywhere in the
      // session — a roll call that completed, a FILE_COMING that went out, and
      // a transfer that reached nobody.
      const payload = new Uint8Array(96).map((_, i) => (i * 7 + 3) & 0xff);
      const audio = transmit(makeTx({ bandHandshake: true }), payload);

      // Strong in-band energy with no chirp in front of it: the tail of a
      // transmission whose head we missed, an echo, a neighbour's burst.
      const interference = audio.slice(Math.round(SAMPLE_RATE * 1.2), Math.round(SAMPLE_RATE * 1.8));

      const rx = new HandshakeReceiver({
        useOFDM: true,
        sampleRate: SAMPLE_RATE,
        pilotFreqHz: 999,
        toneStartHz: 12345,
        toneCount: 16,
      } as ConstructorParameters<typeof HandshakeReceiver>[0]);

      rx.feedChunk(interference);
      rx.feedChunk(new Float32Array(SYM_LEN * 4));
      rx.feedChunk(audio);
      rx.feedChunk(new Float32Array(SYM_LEN * 8));

      const file = rx.getFile();
      expect(file).not.toBeNull();
      expect(Array.from(file!.data.slice(0, payload.length))).toEqual(Array.from(payload));
    },
    TIMEOUT,
  );

  it(
    'decodes when the TX uses a non-default settle count (card carries it)',
    () => {
      const { file, payload } = roundtrip({ trainingSettleSymbols: 8 });
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

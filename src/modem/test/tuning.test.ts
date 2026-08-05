/**
 * OFDM_TUNING invariants — the levers file must keep the sync burst long
 * enough to contain detection + alignment slack + training.
 */
import { expect, test } from 'vitest';
import { OFDM_TUNING, OFDM_DEFAULTS, OFDM_HANDSHAKE } from '../types';

test('handshake pilot sits directly below its tones', () => {
  // Drift correction extrapolates the pilot's measured phase to each tone by
  // toneFreq/pilotFreq. A pure timing offset extrapolates exactly, but any
  // ERROR in that measurement — noise, a fractional-sample estimate, residual
  // drift — is multiplied by the same factor. This band shipped with pilot
  // 1850 under tones at 6900-7250, a factor of ~3.9, so roughly 12 degrees of
  // pilot uncertainty was enough to cross QPSK's 45 degree decision boundary
  // at the top tone. Loopback is noise-free and decoded fine; over the air
  // two devices never demodulated a single control frame in either direction.
  // Keep the factor well below that or the same failure returns, silently and
  // only on hardware. Pilot 2000 under tones ending at 2950 puts it at ~1.48
  // — still well inside the range documented as harmless (1.15 measured safe,
  // 3.9 measured catastrophic). Same invariant as bandHandshake.test.ts's
  // "hardware sweet spot" test — 1.6 is the live ~1.48 ratio plus headroom,
  // not a measured safety threshold, so the two assertions must move
  // together if either bound is ever raised (headroom over 1.475 is already
  // only ~8%, so the next deliberate move is likely to hit it again).
  const firstTone = OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz;
  const topTone = firstTone + (OFDM_HANDSHAKE.toneCount - 1) * OFDM_DEFAULTS.toneSpacingHz;
  expect(topTone / OFDM_HANDSHAKE.pilotFreqHz).toBeLessThan(1.6);

  // The pilot must also stay clear of the chirp template's centre, or the
  // correlator can fire on the pilot itself (see OFDM_HANDSHAKE's comment).
  // The handshake band's own correlator reads OFDM_HANDSHAKE.chirpCenterHz,
  // not the global OFDM_TUNING value (see rxEngine's bandHandshake block) —
  // that pairing is the one actually live for this band, so it's the one
  // this assertion must guard.
  expect(Math.abs(OFDM_HANDSHAKE.pilotFreqHz - OFDM_HANDSHAKE.chirpCenterHz)).toBeGreaterThan(500);
});

test('handshake pilot clears the GLOBAL chirp template too', () => {
  // The post-hop TARGET engine (not the handshake band's own receiver)
  // correlates against OFDM_TUNING.chirpCenterHz, a linear sweep spanning
  // +/-halfSpan around that centre (OFDMEngine/rxEngine default chirpSpanHz
  // 200, i.e. halfSpan 100 — see bandHandshake.test.ts's own copy of this
  // constant). Old pilot 1850 sat exactly ON that centre, which is the
  // false-trigger mechanism documented on OFDM_HANDSHAKE.gapSymbols: the
  // correlator fired on the card symbols' pilot at norm ~0.15, and because
  // cards are real OFDM with real cyclic prefixes the CP probe VALIDATED the
  // false detect. New pilot 2000 is no longer ON the centre, but it is only
  // 150 Hz away, and the template's swept edge (1850+100=1950) is just 50 Hz
  // below it — a partial return toward the same mechanism, not an escape
  // from it. The gap (OFDM_HANDSHAKE.gapSymbols) and HandshakeReceiver's
  // sample discard are the actual mitigation and are untouched; this
  // assertion exists so a future move of either frequency doesn't silently
  // close the clearance further with nothing to catch it.
  //
  // Bound: halfSpan (100, the swept edge itself) + one tone-spacing grid
  // step (50 Hz, OFDM_DEFAULTS.toneSpacingHz) as the minimum safety margin
  // outside the swept range — not the live 150 Hz value with a hair added.
  const halfSpan = 100; // OFDMEngine's default chirpSpanHz is 200
  const minClearance = halfSpan + OFDM_DEFAULTS.toneSpacingHz;
  expect(Math.abs(OFDM_HANDSHAKE.pilotFreqHz - OFDM_TUNING.chirpCenterHz)).toBeGreaterThanOrEqual(
    minClearance,
  );
});

test('sync burst covers detection + alignment slack + settle + training', () => {
  // See OFDM_TUNING's INVARIANT. The settle term is easy to forget and its
  // absence does not fail loudly — the receiver silently trains on data
  // symbols and the frame just never decodes.
  const floor =
    OFDM_TUNING.syncMinFrames
    + 2
    + OFDM_TUNING.trainingSettleSymbols
    + OFDM_TUNING.trainingSymbols;
  // chirpSymbols is excluded on purpose: the chirp is the loudest part of the
  // transmission and the settle period exists to recover from it, so coupling
  // the two would lengthen the chirp every time the settle period grew.
  // The energy-sync path reads training out of the sync burst itself, so the
  // burst must also cover the slack the chirp path gets as extra symbols.
  expect(OFDM_TUNING.syncBurstSymbols).toBeGreaterThanOrEqual(floor);
});

test('current default values', () => {
  expect(OFDM_TUNING).toEqual({
    syncBurstSymbols: 40,
    chirpSymbols: 32,
    chirpCenterHz: 1850,
    trainingSymbols: 12,
    trainingSettleSymbols: 16,
    syncMinFrames: 8,
    tailSilenceSymbols: 6,
    cpCorrelationMinScore: 0.35,
    cpCorrelationMinSharpness: 1.1,
    qamRefSymbols: 4,
    qamWarmupSymbols: 40,
    chirpAmplitude: 0.12,
  });
});

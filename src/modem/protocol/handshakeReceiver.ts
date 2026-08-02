/**
 * HandshakeReceiver — the RX side of the band handshake (see bandCard.ts).
 *
 * Two engines, one at a time:
 *
 *   1. A card listener: a plain RxEngine in bandHandshake mode, tuned to the
 *      fixed OFDM_HANDSHAKE band, whose only output is a decoded band card.
 *   2. The real receiver: a FRESH RxEngine built from the card the moment it
 *      decodes. Fresh on purpose — the target-band transmission is
 *      byte-identical to a non-handshake send (own chirp, own preamble), so
 *      a factory-new engine there behaves exactly as if the user had
 *      configured both ends by hand. No state carries across the hop: not
 *      the symbol boundary (different band, different group delay), not the
 *      channel estimate, not the PLL. Carrying those over is what the first
 *      cut of the handshake did, and the accumulated half-truths cost
 *      fractions of a dB — fatal for the last frame at zero-margin QAM.
 *
 * Exposes the subset of the RxEngine surface the worker uses, so the two are
 * interchangeable behind `configure`.
 */
import { RxEngine } from './rxEngine';
import type { BandCard } from './bandCard';
import { dlog } from '../../lib/debug/dlog';

type RxConfig = ConstructorParameters<typeof RxEngine>[0];

export class HandshakeReceiver {
  private listener: RxEngine;
  private target: RxEngine | null = null;
  /**
   * Samples still belonging to the handshake segment at hop time — discarded
   * so the target engine's first sample lands in the TX's silence gap. Cards
   * are real OFDM (real pilot, real cyclic prefixes); fed to the fresh
   * engine they can false-trigger its chirp detector AND pass the CP probe
   * (bench 2026-08-03). Exact, not heuristic: the listener anchors the
   * segment position on the handshake chirp (see handshakeSegmentRemaining).
   */
  private discardRemaining = 0;

  constructor(private readonly cfg: RxConfig) {
    this.listener = new RxEngine({ ...cfg, bandHandshake: true } as RxConfig);
    this.listener.onBandCard = (card) => this.hop(card);
  }

  private hop(card: BandCard): void {
    this.discardRemaining = this.listener.handshakeSegmentRemaining() ?? 0;
    dlog('RX-OFDM', {
      cardHop: true,
      pilot: card.pilotFreqHz,
      tones: card.toneCount,
      discard: this.discardRemaining,
    }, { level: 'info' });
    this.target = new RxEngine({
      ...this.cfg,
      bandHandshake: false,
      // Born mid-stream, into the tail of the handshake segment: leftover
      // card symbols are strong non-chirp energy, so only the target band's
      // own chirp may start this engine (no energy-fallback sync).
      chirpOnlySync: true,
      pilotFreqHz: card.pilotFreqHz,
      toneStartHz: card.toneStartHz,
      toneCount: card.toneCount,
      trainingSettleSymbols: card.settleSymbols,
    } as RxConfig);
  }

  /** Route samples to whichever engine is live; the swap happens mid-stream. */
  feedSample(sample: number): void {
    if (this.target && this.discardRemaining > 0) {
      this.discardRemaining--;
      return;
    }
    (this.target ?? this.listener).feedSample(sample);
  }

  /** Per-sample loop (not a delegated feedChunk) so a card decoded mid-chunk
   *  hands the REST of that chunk to the fresh target engine. */
  feedChunk(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) this.feedSample(chunk[i]);
  }

  getFile(): ReturnType<RxEngine['getFile']> {
    return this.target?.getFile() ?? null;
  }

  getCompletionCount(): number {
    return this.target?.getCompletionCount() ?? 0;
  }

  /** Pre-hop the listener has no assembly progress — report its idle state. */
  getProgress(): ReturnType<RxEngine['getProgress']> {
    return (this.target ?? this.listener).getProgress();
  }
}

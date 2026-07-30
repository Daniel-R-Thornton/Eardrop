/**
 * OFDMEngine — OFDM/QPSK transmission engine for atomic frames.
 *
 * Native-rate: all timing is derived from OFDM_SYMBOL_MS + OFDM_CP_MS via
 * ofdmSamples(), which yields integer window sizes at any hardware rate.
 * Tone frequencies are absolute Hz on the 25 Hz grid (integer cycles per
 * window ⇒ orthogonal at any sample rate). No FFT, no power-of-two constraint.
 *
 * Sync burst: chirped pilot (LFM sweep) for frequency-diversity timing.
 * Training: OFDM symbols with de-cohered per-tone phases (see syncQpskSymbols)
 * for per-tone channel estimation.
 */
import { ofdmSamples, ofdmToneFrequencies, OFDM_DEFAULTS, OFDM_TUNING } from '../types';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import {
  outerCornerPoint,
  qamRefPhase,
  rotatePoint,
  syncQpskSymbols,
  type QamOrder,
} from '../modulation/constellation';
import { generateChirp, type ChirpConfig } from './chirp';
import { dlog } from '../../lib/debug/dlog';

export class OFDMEngine {
  private toneCount: number;
  private toneFreqs: Float32Array;
  private ofdm: OFDMQPSKModulator;
  private pilotFreqHz: number;
  private sampleRate: number;
  private symSamples: number;
  /** Chirp span (Hz) around pilot; sweep goes pilot±span/2 */
  private chirpSpanHz: number;

  // Per-tone bit-loading (Phase 3). Default: every tone QPSK, which keeps
  // modulateFrame() on the untouched legacy 4-tone/nibble-lane path (see
  // modulateFrameQpsk) — byte-identical to the pre-QAM engine. Only changed
  // by setToneOrders(), called by TxEngine exactly once per transmission,
  // right after the base-rate PROFILE frame is yielded.
  private toneOrders: QamOrder[];
  private allQpsk = true;

  constructor(cfg: {
    sampleRate: number;
    toneCount?: number;
    pilotFreqHz?: number;
    pilotAmplitude?: number;
    chirpSpanHz?: number;
    qamScaleOverride?: number;
    toneStartHz?: number;
    /** Per-tone pre-emphasis (linear); see OFDMQPSKModulatorConfig.toneGains. */
    toneGains?: number[];
  }) {
    const toneCount = cfg.toneCount ?? OFDM_DEFAULTS.toneCount;
    this.toneCount = toneCount % 4 !== 0 ? 4 : toneCount;
    if (toneCount % 4 !== 0) {
      dlog('TX-OFDM', { badToneCount: toneCount, using: 4 }, { level: 'warn' });
    }

    const pilotFreqHz = cfg.pilotFreqHz ?? 1900;
    const pilotAmplitude = cfg.pilotAmplitude ?? 2.0;
    const toneStartHz = cfg.toneStartHz ?? OFDM_DEFAULTS.toneStartHz;
    this.pilotFreqHz = pilotFreqHz;
    this.sampleRate = cfg.sampleRate;
    this.chirpSpanHz = cfg.chirpSpanHz ?? 200;
    const { symSamples } = ofdmSamples(cfg.sampleRate);
    this.symSamples = symSamples;

    this.toneFreqs = ofdmToneFrequencies({ toneCount: this.toneCount, pilotFreqHz, startHz: toneStartHz });

    this.ofdm = new OFDMQPSKModulator({
      sampleRate: cfg.sampleRate,
      toneFrequencies: this.toneFreqs,
      pilotFreqHz,
      pilotAmplitude,
      qamScaleOverride: cfg.qamScaleOverride,
      toneGains: cfg.toneGains,
    });
    this.toneOrders = new Array(this.toneCount).fill(2) as QamOrder[];

    dlog('TX-OFDM', {
      pilot: pilotFreqHz,
      tones: Array.from(this.toneFreqs).map((f) => f.toFixed(1)),
    });
  }

  /**
   * RMS and peak of one training/sync OFDM symbol, as actually synthesized.
   *
   * Used to level-match the chirp to the data (see generateChirpBurst). Derived
   * rather than assumed because it depends on toneCount and qamScale, both of
   * which move: the worst-case-peak scale means a 32-tone symbol is ~4x quieter
   * per tone than an 8-tone one, so any hardcoded chirp level can only be right
   * for one configuration.
   */
  private syncSymbolLevels(): { rms: number; peak: number; coherentPeak: number } {
    const measure = (): { rms: number; peak: number } => {
      const sym = this.ofdm.generateSymbol();
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < sym.length; i++) {
        sumSq += sym[i] * sym[i];
        const a = Math.abs(sym[i]);
        if (a > peak) peak = a;
      }
      return { rms: Math.sqrt(sumSq / sym.length), peak };
    };

    // The burst as actually transmitted (de-cohered — see syncQpskSymbols).
    this.ofdm.setSymbols(syncQpskSymbols(this.toneCount));
    const actual = measure();

    // The same burst with every tone phase-aligned. This is what the TX scale
    // is budgeted against, so it is stable regardless of the phase sequence —
    // and it is what the chirp level is derived from. Deriving the chirp from
    // the ACTUAL peak instead would silently drop it ~11 dB the moment the
    // burst was de-cohered, which is precisely how 40-tone sync stopped
    // locking (correlation fell to norm=0.36 against a 0.35 threshold).
    this.ofdm.setSymbols(new Array(this.toneCount).fill(0));
    const coherent = measure();

    return { rms: actual.rms, peak: actual.peak, coherentPeak: coherent.peak };
  }

  /** Chirped sync burst — linear sweep across chirpSpanHz for timing detection. */
  generateChirpBurst(symbolCount: number): { chirp: Float32Array; chirpCfg: ChirpConfig } {
    const durationSec = (symbolCount * this.symSamples) / this.sampleRate;
    const halfSpan = this.chirpSpanHz / 2;

    // ── Level-match the chirp to the PREAMBLE's peak, not its RMS ──
    // The invariant: the chirp must not ask the output stage for more headroom
    // than the waveform immediately behind it already does. That waveform is
    // the sync/training burst, whose carriers are phase-aligned by construction
    // and which therefore peaks near the coherent bound (~0.63 at every tone
    // count, since the TX scale is itself set by that bound).
    //
    // RMS-matching was tried first and is WRONG here, for a reason that only
    // shows up at high tone counts: the OFDM RMS is qamScale * sqrt(N), and
    // qamScale goes as 1/N, so the chirp got QUIETER as tones were added —
    // 0.121 at 32 tones, 0.108 at 40 — while the channel and noise did not.
    // Sync correlation fell to norm=0.36 against a 0.35 accept threshold at 40
    // tones and stopped locking at all. It also left ~15 dB of headroom unused
    // below the preamble's own peak.
    //
    // What makes the louder chirp safe is OFDM_TUNING.trainingSettleSymbols:
    // the reason to keep the chirp quiet was that it compressed the chain
    // during the training window that followed it immediately. The settle
    // period now discards the first 8 symbols after sync, so the chain has
    // ~200 ms to recover before any channel estimate is taken. That decouples
    // chirp loudness from estimate accuracy, which is what the settle period
    // was added for.
    //
    // In practice OFDM_TUNING.chirpAmplitude (0.6) binds at every tone count,
    // so this lands just under the preamble peak — the level the chirp had
    // before any of this, which is also the level at which sync was reliable
    // (measured norm 0.67-0.72 at 32 tones).
    const levels = this.syncSymbolLevels();
    const matchedAmplitude = levels.coherentPeak;
    const amplitude = Math.min(OFDM_TUNING.chirpAmplitude, matchedAmplitude);

    const chirpCfg: ChirpConfig = {
      fStart: this.pilotFreqHz - halfSpan,
      fEnd: this.pilotFreqHz + halfSpan,
      durationSec,
      sampleRate: this.sampleRate,
      amplitude,
    };
    const chirp = generateChirp(chirpCfg);
    dlog('TX-OFDM', {
      chirp: `${chirpCfg.fStart}-${chirpCfg.fEnd}Hz`,
      durMs: Math.round(durationSec * 1000),
      samples: chirp.length,
      amp: amplitude.toFixed(4),
      // The preamble's own levels, so a mismatch is visible without re-deriving.
      symPeak: levels.peak.toFixed(4),
      symRms: levels.rms.toFixed(4),
      symCoherentPeak: levels.coherentPeak.toFixed(4),
    });
    return { chirp, chirpCfg };
  }

  /** Training symbols — de-cohered per-tone QPSK phases for channel estimation. */
  generateTrainingSymbols(count: number): Float32Array {
    return this.generateSyncBurst(count);
  }

  /**
   * Settle symbols — the ones the RX discards before it starts training (see
   * OFDM_TUNING.trainingSettleSymbols). Deliberately NON-STATIONARY: every
   * symbol carries different pseudo-random QPSK data.
   *
   * Their content is irrelevant to the receiver, which counts them and throws
   * them away, so only the COUNT has to agree between the two sides. What the
   * content is for is the microphone: laptop mic arrays run adaptive DSP that
   * `noiseSuppression: false` does not fully disable, and a long stationary
   * multi-tone signal is exactly what such a processor adapts to and starts
   * attenuating per band. Measured: 400 ms of repeated identical sync symbols
   * before training produced RANDOM per-tone channel estimates (phases
   * scattered rather than smooth) and nothing decoded, while 200 ms did not.
   * The envelope probe separately measured this mic attenuating a sustained
   * tone by 14 dB with a ~350 ms adaptation.
   *
   * So the settle period has to load the output chain at data level — which is
   * why it is signal and not silence — without looking stationary. Varying data
   * does both, and is what real payload looks like anyway.
   */
  generateSettleSymbols(count: number): Float32Array {
    const parts: Float32Array[] = [];
    // Deterministic so a transmission is reproducible; the receiver never needs
    // to know the sequence.
    let seed = 0x9e3779b9;
    const nextSymbol = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed >>> 16) & 0x3;
    };
    for (let i = 0; i < count; i++) {
      this.ofdm.setSymbols(Array.from({ length: this.toneCount }, () => nextSymbol()));
      parts.push(this.ofdm.generateSymbol());
    }
    const totalLen = parts.reduce((a, b) => a + b.length, 0);
    const audio = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }
    return audio;
  }

  generateSyncBurst(count: number): Float32Array {
    // De-cohered per-tone phases, NOT all-zeros — see syncQpskSymbols. The RX
    // rotates them back out while training, so channel estimates are unchanged.
    const symbols = syncQpskSymbols(this.toneCount);
    const parts: Float32Array[] = [];
    for (let i = 0; i < count; i++) {
      this.ofdm.setSymbols(symbols);
      parts.push(this.ofdm.generateSymbol());
    }
    const totalLen = parts.reduce((a, b) => a + b.length, 0);
    const audio = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }
    return audio;
  }

  /**
   * Per-tone bit-loading (Phase 3): assign each tone's constellation order
   * for TX. Default (never called) is all-QPSK, which keeps modulateFrame()
   * on the legacy byte-identical nibble-lane path.
   */
  setToneOrders(orders: QamOrder[]): void {
    this.ofdm.setToneOrders(orders);
    this.toneOrders = orders.slice();
    this.allQpsk = orders.every((o) => o === 2);
  }

  /**
   * Reset to the base (all-QPSK) rate — called at the start of every
   * transmission (TxEngine.frameSegments), so preamble/training/profile
   * frames are always modulated at the base rate regardless of what a
   * previous transmission on this engine instance left it at.
   */
  resetToneOrders(): void {
    this.setToneOrders(new Array(this.toneCount).fill(2) as QamOrder[]);
  }

  /**
   * Modulate a frame. All-QPSK (default): tones are grouped into 4-tone
   * blocks; each block carries one byte per OFDM symbol (upper nibble on the
   * b0 bit lane, lower nibble on b1) — UNCHANGED, byte-identical to the
   * pre-QAM engine. If any tone's order is above QPSK, a generic per-tone
   * bit-serializer is used instead (see modulateFrameGeneric).
   */
  modulateFrame(frame: Uint8Array): Float32Array {
    return this.allQpsk ? this.modulateFrameQpsk(frame) : this.modulateFrameGeneric(frame);
  }

  /** Legacy all-QPSK frame modulation — UNCHANGED from the pre-QAM engine. */
  private modulateFrameQpsk(frame: Uint8Array): Float32Array {
    const blockCount = Math.max(1, Math.floor(this.toneCount / 4));
    const parts: Float32Array[] = [];
    for (let i = 0; i < frame.length; i += blockCount) {
      const symbols: number[] = new Array(this.toneCount).fill(0);
      for (let blk = 0; blk < blockCount; blk++) {
        const byte = i + blk < frame.length ? frame[i + blk] : 0x00;
        const upper = (byte >> 4) & 0xf;
        const lower = byte & 0xf;
        for (let j = 0; j < 4; j++) {
          const b0 = (upper >> (3 - j)) & 1;
          const b1 = (lower >> (3 - j)) & 1;
          symbols[blk * 4 + j] = (b0 << 1) | b1;
        }
      }
      this.ofdm.setSymbols(symbols);
      parts.push(this.ofdm.generateSymbol());
    }
    const totalLen = parts.reduce((a, b) => a + b.length, 0);
    const audio = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }
    return audio;
  }

  /**
   * QAM reference symbols — inserted (by txEngine) right after the profile
   * frames and setToneOrders(), before the header frame, ONLY when the
   * announced qamMap uses any tone above QPSK. Every tone transmits the
   * OUTER CORNER constellation point of its assigned order (e.g. (3,3)/
   * sqrt(10) for 16-QAM — see outerCornerPoint), rotated by a deterministic
   * per-tone phase (qamRefPhase) before synthesis. Without that rotation,
   * every tone lands on the SAME point, so all tones sum phase-aligned into
   * a coherent pulse that hard-clips the DAC (measured peak 2.5+ at 32
   * tones/16-QAM) — exactly on the symbols calibrateQamRef trains on. The
   * rotation only changes phase (magnitude unchanged), and RX applies the
   * identical rotation when computing its expected point (see
   * OFDMQPSKDemodulator.calibrateQamRef), so calibration is unaffected.
   * Synthesis otherwise goes through the exact same path as ordinary QAM
   * data (qamScale, pilot as usual, standard CP) via the modulator's
   * setPoints (a setSymbols variant that accepts rotated points directly,
   * since these don't correspond to Gray-index constellation symbols).
   */
  modulateQamRefSymbols(): Float32Array {
    const points = this.toneOrders.map((order, t) =>
      rotatePoint(outerCornerPoint(order), qamRefPhase(t, this.toneCount)),
    );
    const parts: Float32Array[] = [];
    for (let i = 0; i < OFDM_TUNING.qamRefSymbols; i++) {
      this.ofdm.setPoints(points);
      parts.push(this.ofdm.generateSymbol());
    }
    const totalLen = parts.reduce((a, b) => a + b.length, 0);
    const audio = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }
    return audio;
  }

  /**
   * Generic per-tone bit-serializer — taken only when some tone's order is
   * above QPSK. Drains `frame` bytes MSB-first into a bit queue; per OFDM
   * symbol, each tone t takes `toneOrders[t]` bits off the queue (MSB-first)
   * and maps them to a constellation index. The final symbol of the frame is
   * padded with zero bits (mirrors the legacy path's zero-byte padding).
   *
   * rxEngine.feedSample's generic path is the exact inverse: it accumulates
   * demodulated per-tone bits (same tone order, same MSB-first convention)
   * into a byte buffer and feeds SentinelScanner as 8 bits fill — see the
   * comment there for the shared contract.
   */
  private modulateFrameGeneric(frame: Uint8Array): Float32Array {
    const bitsPerSymbol = this.toneOrders.reduce((a, b) => a + b, 0);
    const totalBits = frame.length * 8;
    const symbolCount = Math.ceil(totalBits / Math.max(1, bitsPerSymbol));

    let byteIdx = 0;
    let bitInByte = 0; // 0 = MSB of frame[byteIdx]
    const nextBit = (): number => {
      if (byteIdx >= frame.length) return 0; // pad past the frame's end
      const bit = (frame[byteIdx] >> (7 - bitInByte)) & 1;
      bitInByte++;
      if (bitInByte === 8) {
        bitInByte = 0;
        byteIdx++;
      }
      return bit;
    };

    const parts: Float32Array[] = [];
    for (let s = 0; s < symbolCount; s++) {
      const symbols: number[] = new Array(this.toneCount);
      for (let t = 0; t < this.toneCount; t++) {
        const order = this.toneOrders[t];
        let value = 0;
        for (let b = 0; b < order; b++) value = (value << 1) | nextBit();
        symbols[t] = value;
      }
      this.ofdm.setSymbols(symbols);
      parts.push(this.ofdm.generateSymbol());
    }
    const totalLen = parts.reduce((a, b) => a + b.length, 0);
    const audio = new Float32Array(totalLen);
    let off = 0;
    for (const p of parts) { audio.set(p, off); off += p.length; }
    return audio;
  }
}

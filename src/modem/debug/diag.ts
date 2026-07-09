/**
 * diag.ts — Diagnostics tools for the modem pipeline.
 *
 * Provides:
 *   - StateSnapshot: one-shot dump of full decoder state
 *   - TimingProfiler: per-stage wall-clock timing (min/max/avg over last N)
 *   - BerTracker: running bit error count (expected vs received)
 *   - ConstellationSampler: captures last N I/Q points per tone for scatter plots
 */

import { debugLogger, STAGE, LOG_LEVEL } from '../debug/debugger';

// ─── TimingProfiler ──────────────────────────────────

export interface TimingSample {
  stage: string;
  durationMs: number;
  timestamp: number;
}

export class TimingProfiler {
  private samples: Map<string, number[]> = new Map();
  private maxSamples = 100;
  private marks: Map<string, number> = new Map();

  /** Start a timer for a named stage */
  begin(stage: string): void {
    this.marks.set(stage, performance.now());
  }

  /** End a timer and record the duration */
  end(stage: string): number {
    const start = this.marks.get(stage);
    if (start === undefined) return 0;
    const duration = performance.now() - start;
    this.marks.delete(stage);

    let buf = this.samples.get(stage);
    if (!buf) {
      buf = [];
      this.samples.set(stage, buf);
    }
    buf.push(duration);
    if (buf.length > this.maxSamples) buf.shift();

    return duration;
  }

  /** Get timing stats for a stage */
  getStats(stage: string): { min: number; max: number; avg: number; count: number } | null {
    const buf = this.samples.get(stage);
    if (!buf || buf.length === 0) return null;
    const min = Math.min(...buf);
    const max = Math.max(...buf);
    const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
    return { min, max, avg, count: buf.length };
  }

  /** Get all stage stats */
  getAllStats(): Record<string, { min: number; max: number; avg: number; count: number }> {
    const result: Record<string, any> = {};
    for (const [stage] of this.samples) {
      const stats = this.getStats(stage);
      if (stats) result[stage] = stats;
    }
    return result;
  }

  /** Log timing stats to debugger */
  logStats(): void {
    for (const [stage, stats] of Object.entries(this.getAllStats())) {
      debugLogger.info(
        STAGE.DEBUG,
        {
          stage,
          minMs: stats.min.toFixed(2),
          maxMs: stats.max.toFixed(2),
          avgMs: stats.avg.toFixed(2),
          count: stats.count,
        },
        `TIMING ${stage}: avg=${stats.avg.toFixed(2)}ms [${stats.min.toFixed(2)}-${stats.max.toFixed(2)}]`,
      );
    }
  }

  reset(): void {
    this.samples.clear();
    this.marks.clear();
  }
}

// ─── BerTracker ──────────────────────────────────────

export interface BerReport {
  /** Total bits compared */
  totalBits: number;
  /** Raw bit errors (before ECC) */
  rawErrors: number;
  /** Corrected errors (ECC caught these) */
  correctedErrors: number;
  /** Uncorrectable errors (ECC gave up) */
  uncorrectableErrors: number;
  /** Raw bit error rate */
  rawBer: number;
  /** Corrected bit error rate (residual after ECC) */
  correctedBer: number;
}

export class BerTracker {
  private totalBits = 0;
  private rawErrors = 0;
  private correctedErrors = 0;
  private uncorrectableErrors = 0;

  /** Record a batch of bit comparisons */
  recordBits(count: number, errors: number, corrected: number, uncorrectable: number): void {
    this.totalBits += count;
    this.rawErrors += errors;
    this.correctedErrors += corrected;
    this.uncorrectableErrors += uncorrectable;
  }

  /** Record per-symbol (8-bit) comparison */
  recordSymbol(expectedBits: number, receivedBits: number): void {
    // XOR to find differing bits
    const diff = (expectedBits ^ receivedBits) & 0xff;
    let errors = 0;
    for (let i = 0; i < 8; i++) {
      if ((diff >> i) & 1) errors++;
    }
    this.totalBits += 8;
    this.rawErrors += errors;
  }

  /** Record codeword-level ECC result */
  recordEccResult(
    totalBits: number,
    rawErrors: number,
    corrected: number,
    uncorrectable: number,
  ): void {
    this.totalBits += totalBits;
    this.rawErrors += rawErrors;
    this.correctedErrors += corrected;
    this.uncorrectableErrors += uncorrectable;
  }

  getReport(): BerReport {
    return {
      totalBits: this.totalBits,
      rawErrors: this.rawErrors,
      correctedErrors: this.correctedErrors,
      uncorrectableErrors: this.uncorrectableErrors,
      rawBer: this.totalBits > 0 ? this.rawErrors / this.totalBits : 0,
      correctedBer:
        this.totalBits > 0
          ? Math.max(0, this.rawErrors - this.correctedErrors) / this.totalBits
          : 0,
    };
  }

  /** Log BER report to debugger */
  logReport(): void {
    const r = this.getReport();
    debugLogger.info(
      STAGE.DEBUG,
      {
        total_bits: r.totalBits,
        err_raw: r.rawErrors,
        err_corr: r.correctedErrors,
        err_uncorr: r.uncorrectableErrors,
        raw_ber: r.rawBer.toFixed(6),
        corr_ber: r.correctedBer.toFixed(6),
      },
      `BER raw=${(r.rawBer * 100).toFixed(2)}% corr=${(r.correctedBer * 100).toFixed(2)}%`,
    );
  }

  reset(): void {
    this.totalBits = 0;
    this.rawErrors = 0;
    this.correctedErrors = 0;
    this.uncorrectableErrors = 0;
  }
}

// ─── ConstellationSampler ────────────────────────────

export interface ConstellationPoint {
  /** Tone index (0-3) */
  tone: number;
  /** Pilot-relative I */
  i: number;
  /** Pilot-relative Q */
  q: number;
  /** Decoded amplitude bit */
  ampBit: number;
  /** Decoded phase bit */
  phaseBit: number;
  /** True bits if known (for BER overlay) */
  trueAmpBit?: number;
  truePhaseBit?: number;
  /** Symbol index */
  symbolIndex: number;
}

export class ConstellationSampler {
  private points: Map<number, ConstellationPoint[]> = new Map();
  private maxPointsPerTone = 200;
  private symbolCounter = 0;

  constructor() {
    for (let t = 0; t < 4; t++) this.points.set(t, []);
  }

  /** Record one tone's I/Q point */
  record(
    tone: number,
    i: number,
    q: number,
    ampBit: number,
    phaseBit: number,
    trueAmpBit?: number,
    truePhaseBit?: number,
  ): void {
    const buf = this.points.get(tone);
    if (!buf) return;

    buf.push({
      tone,
      i,
      q,
      ampBit,
      phaseBit,
      trueAmpBit,
      truePhaseBit,
      symbolIndex: this.symbolCounter,
    });

    if (buf.length > this.maxPointsPerTone) buf.shift();
  }

  /** Record all 4 tones at once */
  recordFrame(
    relI: [number, number, number, number],
    relQ: [number, number, number, number],
    ampBits: [number, number, number, number],
    phaseBits: [number, number, number, number],
    trueAmpBits?: [number, number, number, number],
    truePhaseBits?: [number, number, number, number],
  ): void {
    for (let t = 0; t < 4; t++) {
      this.record(
        t,
        relI[t],
        relQ[t],
        ampBits[t],
        phaseBits[t],
        trueAmpBits?.[t],
        truePhaseBits?.[t],
      );
    }
    this.symbolCounter++;
  }

  /** Get all points for a specific tone */
  getTone(tone: number): readonly ConstellationPoint[] {
    return this.points.get(tone) ?? [];
  }

  /** Get points for all tones */
  getAll(): Map<number, readonly ConstellationPoint[]> {
    return new Map(this.points);
  }

  /** Get last N points per tone */
  getLast(n: number): Map<number, ConstellationPoint[]> {
    const result = new Map<number, ConstellationPoint[]>();
    for (const [tone, buf] of this.points) {
      result.set(tone, buf.slice(-n));
    }
    return result;
  }

  reset(): void {
    for (const [, buf] of this.points) buf.length = 0;
    this.symbolCounter = 0;
  }
}

// ─── StateSnapshot ───────────────────────────────────

export interface DecoderSnapshot {
  timestamp: number;
  pilotFreq: number;
  pilotAmplitude: number;
  pilotLocked: boolean;
  inFrame: boolean;
  consecutiveSync: number;
  bitsTotal: number;
  blocksDecoded: number;
  blocksCrcFailed: number;
  noiseFloor: [number, number, number, number];
  signalToNoise: number;
  framedDecoderPhase: string;
  blockProcessorStats: {
    blocksReceived: number;
    bytesAssembled: number;
    resets: number;
  };
}

/**
 * Build a snapshot of the decoder's current state.
 * Call from the decoder when a user requests a dump.
 */
export function buildSnapshot(params: {
  pilotFreq: number;
  pilotAmplitude: number;
  pilotLocked: boolean;
  inFrame: boolean;
  consecutiveSync: number;
  bitsTotal: number;
  blocksDecoded: number;
  blocksCrcFailed: number;
  noiseFloor: [number, number, number, number];
  signalToNoise: number;
  framedDecoderPhase: string;
  blockProcessorStats: { blocksReceived: number; bytesAssembled: number; resets: number };
}): DecoderSnapshot {
  return {
    timestamp: performance.now(),
    pilotFreq: params.pilotFreq,
    pilotAmplitude: params.pilotAmplitude,
    pilotLocked: params.pilotLocked,
    inFrame: params.inFrame,
    consecutiveSync: params.consecutiveSync,
    bitsTotal: params.bitsTotal,
    blocksDecoded: params.blocksDecoded,
    blocksCrcFailed: params.blocksCrcFailed,
    noiseFloor: params.noiseFloor,
    signalToNoise: params.signalToNoise,
    framedDecoderPhase: params.framedDecoderPhase,
    blockProcessorStats: params.blockProcessorStats,
  };
}

/**
 * compressForLLM.ts — Compresses the full debug ring buffer into a structured
 * summary suitable for direct paste into an LLM context.
 *
 * Three levels:
 *   brief:   1 line per stage, key metrics only (~500 bytes)
 *   normal:  2-3 lines per stage, includes warnings and anomalies (~2KB)
 *   verbose: full ring buffer with filters applied (~5-10KB)
 *
 * Format: [STAGE_TAG] key=value key=value ...
 * Anomalies prefixed with ⚠️
 */

import { type DebugLogger, type LogEvent, STAGE, LOG_LEVEL, type StageTag } from '../debug/debugger';
import { type BerReport } from '../debug/diag';

export type CompressLevel = 'brief' | 'normal' | 'verbose';

export interface CompressOptions {
  /** Compression level */
  level: CompressLevel;
  /** Include BER report if available */
  berReport?: BerReport;
  /** Optional filter: only include these stages */
  stages?: StageTag[];
  /** Include anomalous events only (for brief mode) */
  anomaliesOnly?: boolean;
}

const ANOMALY_THRESHOLDS: Record<string, number> = {
  raw_ber: 0.01, // 1% = anomaly
  corr_ber: 0.001, // 0.1% = anomaly
  double_err_rate: 0.01, // 1% = anomaly
  syndrome_fix_rate: 0.3, // 30% = anomaly
  drift_deg: 10, // 10° = anomaly
  amp_recovery: 0.5, // <0.5 or >2.0 = anomaly
  phase_std: 0.2, // 0.2 rad = anomaly
  lock_quality: 0.5, // <0.5 = anomaly
  crc_fail_rate: 0.1, // 10% = anomaly
};

function isAnomalous(data: Record<string, unknown>): boolean {
  for (const [key, threshold] of Object.entries(ANOMALY_THRESHOLDS)) {
    const val = data[key];
    if (typeof val === 'number') {
      if (key === 'amp_recovery' || key === 'lock_quality') {
        if (val < threshold) return true;
      } else {
        if (val > threshold) return true;
      }
    }
  }
  return false;
}

function formatVal(v: unknown): string {
  if (typeof v === 'number') {
    if (Math.abs(v) < 0.01 || Math.abs(v) > 1000) {
      return v.toExponential(2);
    }
    return v.toFixed(v % 1 === 0 ? 0 : 4);
  }
  return String(v);
}

function eventToLine(event: LogEvent, markAnomalies: boolean): string {
  const parts: string[] = [`[${event.stage}]`];
  for (const [key, val] of Object.entries(event.data)) {
    parts.push(`${key}=${formatVal(val)}`);
  }
  let line = parts.join(' ');

  if (markAnomalies && isAnomalous(event.data)) {
    line = `⚠️ ${  line}`;
  }
  return line;
}

function stageSummary(stage: StageTag, events: LogEvent[], level: CompressLevel): string[] {
  if (events.length === 0) return [];

  const lines: string[] = [];
  const last = events[events.length - 1];

  if (level === 'brief') {
    // Single line from last event
    lines.push(eventToLine(last, true));
  } else if (level === 'normal') {
    // Last event + any WARN/ERROR events
    lines.push(eventToLine(last, true));
    for (const e of events) {
      if (e.level >= LOG_LEVEL.WARN) {
        lines.push(`  ${eventToLine(e, true)}`);
      }
    }
  } else {
    // verbose: last N events
    const n = Math.min(events.length, 10);
    for (let i = events.length - n; i < events.length; i++) {
      lines.push(eventToLine(events[i], true));
    }
  }

  return lines;
}

/**
 * Compress debug logger output into a structured LLM-friendly summary.
 */
export function compressForLLM(logger: DebugLogger, options: CompressOptions): string {
  const { level, berReport, stages, anomaliesOnly } = options;

  const allEvents = stages
    ? stages.flatMap((s) => [...logger.getStageBuffer(s)])
    : logger.getAllEvents();

  // Group by stage
  const grouped = new Map<StageTag, LogEvent[]>();
  for (const event of allEvents) {
    let buf = grouped.get(event.stage);
    if (!buf) {
      buf = [];
      grouped.set(event.stage, buf);
    }
    buf.push(event);
  }

  const output: string[] = [];
  const markAnomalies = level !== 'brief';

  // Process each stage in a consistent order
  const stageOrder: StageTag[] = [
    STAGE.PILOT_SCAN,
    STAGE.PILOT_LOCK,
    STAGE.SYNC_DETECT,
    STAGE.FRAME_BITS,
    STAGE.BLOCK_SENTINEL,
    STAGE.BLOCK_PROCESS,
    STAGE.ECC_DECODE,
    STAGE.SQUAWK_CAL,
    STAGE.END_DETECT,
    STAGE.CHANNEL,
    STAGE.DEBUG,
  ];

  for (const stage of stageOrder) {
    const events = grouped.get(stage);
    if (!events || events.length === 0) continue;

    if (anomaliesOnly) {
      const anomalous = events.filter((e) => isAnomalous(e.data));
      if (anomalous.length === 0) continue;
      const summary = stageSummary(stage, anomalous, 'verbose');
      for (const line of summary) output.push(line);
    } else {
      const summary = stageSummary(stage, events, level);
      for (const line of summary) output.push(line);
    }
  }

  // BER report
  if (berReport) {
    output.push(
      `[BER] raw=${berReport.rawBer.toExponential(2)} corr=${berReport.correctedBer.toExponential(2)} total_bits=${berReport.totalBits} err_raw=${berReport.rawErrors} err_corr=${berReport.correctedErrors} err_uncorr=${berReport.uncorrectableErrors}`,
    );
  }

  return output.join('\n');
}

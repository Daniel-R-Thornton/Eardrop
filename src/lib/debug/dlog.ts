/**
 * dlog — minimal LLM-parseable debug logging.
 *
 * Every line is `[TAG] key=value key=value` — one line per event, no objects,
 * no multi-line dumps. Uses console.log/debug (never console.warn for info)
 * so DevTools does not attach stack traces to routine output.
 *
 * Features:
 * - per-tag rate limiting (`every: N` logs the 1st then every Nth call)
 * - tag enable/disable at runtime (wired to the debug panel checkboxes)
 * - ring buffer of emitted lines for one-click LLM export (dlogDump)
 */

const RING_MAX = 500;
const MAX_LINE_LEN = 200; // auto-break long lines at field boundaries
const ring: string[] = [];
const rateCounters = new Map<string, number>();
const disabledTags = new Set<string>();

export type DlogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Output mode:
 * - 'lines'   — one console entry per event (default; workers, tests)
 * - 'redraw'  — clear the console and reprint the ENTIRE ring as ONE console
 *               entry, so the whole session log is a single copy target
 * - 'forward' — no console output; each line goes to the forward callback
 *               (used in workers to hand lines to the main thread's ring)
 */
export type DlogMode = 'lines' | 'redraw' | 'forward';
let mode: DlogMode = 'lines';
let forwardCb: ((line: string) => void) | null = null;
let redrawPending = false;

export function dlogSetMode(next: DlogMode, onForward?: (line: string) => void): void {
  mode = next;
  forwardCb = onForward ?? null;
}

/** Throttled clear-and-reprint: whole ring as one console entry. */
function scheduleRedraw(): void {
  if (redrawPending) return;
  redrawPending = true;
  setTimeout(() => {
    redrawPending = false;
    console.clear();
    console.log(`━━ eardrop log (${ring.length} lines, newest last) ━━\n${ring.join('\n')}`);
  }, 250);
}

/** Add a line produced in another context (e.g. worker) to this ring. */
export function dlogInject(line: string): void {
  ring.push(line);
  if (ring.length > RING_MAX) ring.shift();
  if (mode === 'redraw') scheduleRedraw();
}

export interface DlogOptions {
  /** Log the first call, then only every Nth call for this tag */
  every?: number;
  level?: DlogLevel;
}

/** Compact numeric formatting: 3 significant digits, exponential outside [0.01, 1000) */
export function dlogFmt(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value) && Math.abs(value) < 100000) return String(value);
    const abs = Math.abs(value);
    if (abs !== 0 && (abs >= 1000 || abs < 0.01)) return value.toExponential(2);
    return Number(value.toPrecision(3)).toString();
  }
  if (Array.isArray(value)) return value.map(dlogFmt).join(',');
  return String(value);
}

export function dlogSetTagEnabled(tag: string, enabled: boolean): void {
  if (enabled) {
    disabledTags.delete(tag);
  } else {
    disabledTags.add(tag);
  }
}

/** Emit `[TAG] k=v ...`. Ring buffer stores one line; console emits multiple .log() calls if over MAX_LINE_LEN. */
export function dlog(
  tag: string,
  fields: Record<string, unknown>,
  opts: DlogOptions = {},
): string | null {
  if (disabledTags.has(tag)) return null;

  if (opts.every && opts.every > 1) {
    const count = (rateCounters.get(tag) ?? 0) + 1;
    rateCounters.set(tag, count);
    if ((count - 1) % opts.every !== 0) return null;
  }

  const body = Object.entries(fields)
    .map(([key, value]) => `${key}=${dlogFmt(value)}`)
    .join(' ');
  const level = opts.level ?? 'info';
  const marker = level === 'error' ? '!! ' : level === 'warn' ? '! ' : '';
  const line = `${marker}[${tag}] ${body}`;

  // Ring buffer always stores the full single line (for LLM export)
  ring.push(line);
  if (ring.length > RING_MAX) ring.shift();

  if (mode === 'forward' && forwardCb) {
    forwardCb(line);
    return line;
  }
  if (mode === 'redraw') {
    scheduleRedraw();
    return line;
  }

  // Console output: if the line is too long, chunk it at word boundaries
  // so Chrome doesn't truncate. Ring buffer keeps the original single line.
  const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log;
  if (line.length > MAX_LINE_LEN) {
    const words = line.split(' ');
    let chunk = '';
    for (const w of words) {
      if (chunk.length + 1 + w.length > MAX_LINE_LEN && chunk) {
        logFn(chunk);
        chunk = w;
      } else {
        chunk += (chunk ? ' ' : '') + w;
      }
    }
    if (chunk) logFn(chunk);
  } else {
    logFn(line);
  }
  return line;
}

/** Last `count` emitted lines, newline-joined — paste-ready for LLM analysis. */
export function dlogDump(count = 200): string {
  return ring.slice(-count).join('\n');
}

/** Reset rate counters and ring (call when starting a fresh transmission test). */
export function dlogReset(): void {
  ring.length = 0;
  rateCounters.clear();
}

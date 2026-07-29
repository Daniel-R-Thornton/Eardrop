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
 * - consecutive duplicate suppression (shows `(+N dup)` instead of spam)
 * - ring buffer of emitted lines for one-click LLM export (dlogDump)
 */

const RING_MAX = 500;
const MAX_LINE_LEN = 100; // tight lines: max data, min context
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

/** Lines from ring that have already been emitted as a console entry */
let redrawEmitted = 0;
/** Lines per console entry — Chrome wraps single entries > ~50 lines */
const REDRAW_BATCH = 100;

/** Pending duplicate summaries: per tag, the last body and how many times it repeated. */
interface DupState {
  lastBody: string;
  count: number;
}
const dupState = new Map<string, DupState>();

export function dlogSetMode(next: DlogMode, onForward?: (line: string) => void): void {
  mode = next;
  forwardCb = onForward ?? null;
}

/**
 * Emit only NEW lines since the last batch as a fresh console entry.
 * The old entries stay visible in the console — no console.clear().
 * Each batch gets its own log so Chrome doesn't collapse them under
 * a "show more" toggle.
 */
function flushBatch(): void {
  redrawPending = false;
  const batch = ring.slice(redrawEmitted);
  if (batch.length === 0) return;
  while (batch.length > 0) {
    const chunk = batch.splice(0, REDRAW_BATCH);
    const fromLine = redrawEmitted + 1;
    const toLine = redrawEmitted + chunk.length;
    redrawEmitted += chunk.length;
    console.log(
      `--- ${fromLine}-${toLine}/${ring.length} ---\n${chunk.join('\n')}`,
    );
  }
}

function scheduleRedraw(): void {
  if (redrawPending) return;
  redrawPending = true;
  setTimeout(flushBatch, 250);
}

/** Add a line produced in another context (e.g. worker) to this ring. */
export function dlogInject(line: string): void {
  ringPush(line);
  if (mode === 'redraw') scheduleRedraw();
}

/** Push to ring, evicting oldest when full. Adjusts redrawEmitted so
 *  incremental flushes stay aligned after ring shifts. */
function ringPush(line: string): void {
  ring.push(line);
  if (ring.length > RING_MAX) {
    ring.shift();
    if (redrawEmitted > 0) redrawEmitted--;
  }
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

/** Format fields into one or more `[TAG] k=v ...` lines, auto-breaking at MAX_LINE_LEN. */
function formatLines(tag: string, fields: Record<string, unknown>, level: DlogLevel): string[] {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${dlogFmt(value)}`);
  const marker = level === 'error' ? '!! ' : level === 'warn' ? '! ' : '';
  const prefix = `${marker}[${tag}] `;

  const lines: string[] = [];
  let cur = prefix;

  function flush(): void {
    lines.push(cur);
    cur = prefix;
  }

  for (const pair of pairs) {
    const sep = cur === prefix ? '' : ' ';
    if (cur.length + sep.length + pair.length <= MAX_LINE_LEN) {
      cur += sep + pair;
      continue;
    }
    // Won't fit on current line.
    if (cur !== prefix) flush();

    // If pair still won't fit even on a fresh line, break it at spaces.
    if (pair.length + prefix.length > MAX_LINE_LEN) {
      const words = pair.split(' ');
      for (const w of words) {
        if (cur.length + (cur === prefix ? 0 : 1) + w.length > MAX_LINE_LEN && cur !== prefix) {
          flush();
        }
        cur += (cur === prefix ? '' : ' ') + w;
      }
    } else {
      cur += sep + pair;
    }
  }
  if (cur !== prefix) lines.push(cur);
  return lines;
}

/** Emit a line to console/forward/ring and return it. */
function emitLine(line: string, level: DlogLevel): string {
  ringPush(line);
  if (mode === 'forward' && forwardCb) {
    forwardCb(line);
  } else if (mode === 'redraw') {
    scheduleRedraw();
  } else {
    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log;
    logFn(line);
  }
  return line;
}

/** Build the `[TAG] ` prefix including warning/error markers. */
function buildPrefix(tag: string, level: DlogLevel): string {
  const marker = level === 'error' ? '!! ' : level === 'warn' ? '! ' : '';
  return `${marker}[${tag}] `;
}

/**
 * Emit `[TAG] k=v ...` line(s), suppressing consecutive identical lines.
 * Returns the formatted text (or null if suppressed by rate limiting or disabled).
 */
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

  const level = opts.level ?? 'info';
  const lines = formatLines(tag, fields, level);
  if (lines.length === 0) return null;

  // Deduplication only applies to single-line logs (covers >99% of calls).
  const primary = lines[0];
  const prefix = buildPrefix(tag, level);
  const body = primary.startsWith(prefix) ? primary.slice(prefix.length) : primary;

  const state = dupState.get(tag);
  let emittedResult: string | null = null;

  if (state && state.lastBody === body) {
    // Same line again — count it and suppress.
    state.count++;
    return null;
  }

  // Different line — flush any pending duplicate summary first.
  if (state && state.count > 0) {
    let dupBody = state.lastBody;
    const dupSuffix = state.count > 1 ? ` (+${state.count})` : '';
    if (dupBody.length + dupSuffix.length > MAX_LINE_LEN - prefix.length) {
      dupBody = `${dupBody.slice(0, Math.max(1, MAX_LINE_LEN - prefix.length - dupSuffix.length - 3))}...`;
    }
    emittedResult = emitLine(`${prefix}${dupBody}${dupSuffix}`, level);
  }

  // Emit new line(s).
  for (const l of lines) {
    emitLine(l, level);
  }
  dupState.set(tag, { lastBody: body, count: 0 });

  return emittedResult ?? lines.join('\n');
}

/** Last `count` emitted lines, newline-joined — paste-ready for LLM analysis. */
export function dlogDump(count = 200): string {
  return ring.slice(-count).join('\n');
}

/** Reset rate counters, duplicate state, and ring (call when starting a fresh transmission test). */
export function dlogReset(): void {
  ring.length = 0;
  rateCounters.clear();
  dupState.clear();
  redrawEmitted = 0;
}

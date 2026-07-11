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

/** Emit `[TAG] k=v ...` line(s), auto-breaking at MAX_LINE_LEN (200). Returns the formatted text (or null if suppressed). */
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

  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${dlogFmt(value)}`);
  const level = opts.level ?? 'info';
  const marker = level === 'error' ? '!! ' : level === 'warn' ? '! ' : '';
  const prefix = `${marker}[${tag}] `;

  // Build line(s), auto-breaking at field boundaries when exceeding MAX_LINE_LEN.
  // When a single field value is too long even on a fresh line, break it at spaces.
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
      // Emit whatever fits from the pair's words onto cur, flush when full.
      const words = pair.split(' ');
      for (const w of words) {
        const wSep = cur === prefix ? '' : ' ';
        if (cur.length + wSep.length + w.length > MAX_LINE_LEN && cur !== prefix) {
          flush();
        }
        cur += (cur === prefix ? '' : ' ') + w;
      }
    } else {
      cur += sep + pair;
    }
  }
  if (cur !== prefix) lines.push(cur);

  if (lines.length === 0) return null;

  // Push all lines into the ring buffer
  for (const l of lines) {
    ring.push(l);
    if (ring.length > RING_MAX) ring.shift();
  }

  if (mode === 'forward' && forwardCb) {
    for (const l of lines) forwardCb(l);
    return lines.join('\n');
  }
  if (mode === 'redraw') {
    scheduleRedraw();
    return lines.join('\n');
  }

  const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : level === 'debug' ? console.debug : console.log;
  for (const l of lines) logFn(l);
  return lines.join('\n');
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

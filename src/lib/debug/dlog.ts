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

/** Lines ever pushed to the ring, including evicted ones — the sequence space
 *  dlogSince cursors live in. Reset with the ring (dlogReset), which dlogSince
 *  callers survive by always adopting the returned cursor. */
let totalEmitted = 0;

/**
 * Bumped by every dlogReset. The sequence space restarting at 0 is only
 * *detectable* from a cursor when the new run is shorter than the old one
 * (seq > totalEmitted); app.ts resets per speed-test trial, so a trial that
 * emits at least as many lines as the previous cursor would look "already
 * caught up" and its entire log would be dropped silently. This counter makes
 * "different ring" unambiguous regardless of length, so a reader can restart
 * its cursor at 0 rather than guess.
 */
let generation = 0;

/**
 * Structured mirror of the ring: the same events, but as {tag, fields} rather
 * than formatted text.
 *
 * Exists so the LLM export can aggregate rather than re-parse. Console lines are
 * wrapped at MAX_LINE_LEN, so a per-tone array arrives as several continuation
 * lines with no key on them — recovering the values from that is fragile in a
 * way that silently corrupts summaries. Capturing at emit time keeps the values
 * intact and leaves console formatting free to change.
 */
export interface DlogRecord {
  tag: string;
  fields: Record<string, unknown>;
}
const records: DlogRecord[] = [];
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
/**
 * Structured counterpart of forwardCb.
 *
 * Forwarding only the formatted lines loses every field: the receiving context's
 * `records` array stays empty, so the LLM export — which aggregates records, not
 * lines — silently reports just the handful of events that happened to be logged
 * in that same context. Most of the modem logs in this app run in the worker, so
 * without this the digest was nearly blank.
 */
let forwardRecordCb: ((rec: DlogRecord) => void) | null = null;
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

export function dlogSetMode(
  next: DlogMode,
  onForward?: (line: string) => void,
  onForwardRecord?: (rec: DlogRecord) => void,
): void {
  mode = next;
  forwardCb = onForward ?? null;
  forwardRecordCb = onForwardRecord ?? null;
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

/** Add a structured event produced in another context to this record buffer. */
export function dlogInjectRecord(rec: DlogRecord): void {
  recordPush(rec);
}

/** Push to ring, evicting oldest when full. Adjusts redrawEmitted so
 *  incremental flushes stay aligned after ring shifts. */
function ringPush(line: string): void {
  totalEmitted++;
  ring.push(line);
  if (ring.length > RING_MAX) {
    ring.shift();
    if (redrawEmitted > 0) redrawEmitted--;
  }
}

/** Push to the record buffer, evicting oldest when full. */
function recordPush(rec: DlogRecord): void {
  records.push(rec);
  if (records.length > RING_MAX) records.shift();
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

/**
 * Allow-list. When non-null ONLY these tags emit, whatever else is enabled.
 *
 * Room mode needs this: the modem logs a burst of OFDM/sync/frame detail for
 * every symbol it touches, which buries the handful of room-protocol lines
 * that explain what the room is actually doing. A deny-list would have to
 * enumerate — and keep enumerating — every noisy tag in the modem, so the
 * focus is expressed as "just these" instead.
 */
let focusTags: Set<string> | null = null;

/** Restrict output to `tags`, or pass null to go back to everything. */
export function dlogSetFocus(tags: string[] | null): void {
  focusTags = tags && tags.length > 0 ? new Set(tags) : null;
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
  if (focusTags && !focusTags.has(tag)) return null;

  if (opts.every && opts.every > 1) {
    const count = (rateCounters.get(tag) ?? 0) + 1;
    rateCounters.set(tag, count);
    if ((count - 1) % opts.every !== 0) return null;
  }

  const level = opts.level ?? 'info';
  const lines = formatLines(tag, fields, level);
  if (lines.length === 0) return null;

  // Mirror the event structurally before any console formatting or dedup — the
  // LLM export aggregates from these, not from the wrapped text.
  recordPush({ tag, fields });
  if (mode === 'forward' && forwardRecordCb) forwardRecordCb({ tag, fields });

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

/**
 * Incremental read of the ring for the LAN log reporter: everything emitted
 * after cursor `seq`, plus the cursor to resume from. Clamped on both sides —
 * a cursor older than the ring's tail yields what survives (eviction loses
 * lines, it must not fabricate them), and a cursor from before a dlogReset
 * (now larger than totalEmitted) yields the current head rather than an
 * empty result forever. Callers always adopt `next`.
 *
 * `generation` changes on every dlogReset. Length-based detection above only
 * catches the shrinking case, so callers must compare generations too and
 * restart their cursor at 0 when it moves — otherwise a longer new run reads
 * as "caught up" and is dropped entirely.
 */
export function dlogSince(seq: number): {
  generation: number; next: number; lines: string[]; dropped: number;
} {
  const floor = totalEmitted - ring.length;
  // A cursor beyond totalEmitted can only mean a dlogReset happened underneath
  // the caller (the counter restarted at 0). Clamping it down to totalEmitted
  // (as if "already caught up") would silently swallow every line emitted
  // between the reset and this call. Snapping to floor instead hands back
  // everything currently in the ring, so the caller converges in one step.
  const reset = seq > totalEmitted;
  const start = reset ? floor : Math.max(seq, floor);
  return {
    generation,
    next: totalEmitted,
    lines: ring.slice(ring.length - (totalEmitted - start)),
    // How many lines existed between the caller's cursor and the oldest line
    // still in the ring. They are gone, but a reader that is not told about
    // them cannot tell a complete log from one with a hole in it — and the
    // hole always lands mid-burst, which is exactly when something
    // interesting was happening. Reported as 0 across a reset (`start` moves
    // BACKWARD there, which is not an eviction): the generation stamp is
    // what signals that case, and double-signalling it would cry wolf on
    // every speed-test trial.
    dropped: reset ? 0 : Math.max(0, start - seq),
  };
}

/** Structured records, for aggregation (see DlogRecord). */
export function dlogRecords(count = RING_MAX): DlogRecord[] {
  return records.slice(-count);
}

/**
 * Ring capacity, exported so callers that COUNT events in a dump (rather than
 * just reading it) can ask for everything and detect saturation. Scraping a
 * short tail silently undercounts: early lines get evicted while later ones
 * survive, which reads as "no frames arrived but here is their MER".
 */
export const DLOG_RING_MAX = RING_MAX;

/** Lines currently buffered. Equal to DLOG_RING_MAX means older lines were dropped. */
export function dlogRingLength(): number {
  return ring.length;
}

/** Reset rate counters, duplicate state, and ring (call when starting a fresh transmission test). */
export function dlogReset(): void {
  ring.length = 0;
  records.length = 0;
  rateCounters.clear();
  dupState.clear();
  redrawEmitted = 0;
  totalEmitted = 0;
  generation++;
}

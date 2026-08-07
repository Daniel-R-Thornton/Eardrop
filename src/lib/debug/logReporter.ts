// src/lib/debug/logReporter.ts
/**
 * logReporter — pushes the dlog ring to a LAN log server, incrementally.
 *
 * Exists for the phone: its 500-record ring silently loses the start of any
 * long session, and exporting it means touching the phone mid-test. When the
 * app is served by scripts/log-server.mjs or the vite dev server, /api/log
 * answers the startup probe and this module pushes every NEW line (dlogSince
 * cursor — nothing sent twice) every 5 s. On GitHub Pages the probe fails and
 * the reporter is permanently off: zero behavior change for the deployed site.
 *
 * Never throws into app code: every fetch path is caught. A failed push keeps
 * the cursor so the lines go next tick; three consecutive failures stretch
 * the tick to 30 s (the server was probably shut down) but never disable —
 * it may come back.
 */
import { dlogSince } from './dlog';

const INTERVAL_MS = 5000;
const BACKOFF_MS = 30000;
const BACKOFF_AFTER = 3;

interface ReporterState {
  enabled: boolean;
  device: string;
  session: string;
  cursor: number;
  failures: number;
  fetchFn: typeof fetch;
  intervalMs: number;
  backoffMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * The in-flight push, if any. Both the periodic tick and flushLogReporter
   * route through runOnce, which joins this promise instead of starting a
   * second concurrent push — that is what keeps "at most one in-flight push,
   * at most one live timer" true when a flush lands mid-tick (or two flushes
   * land back to back). Without it, two pushes read dlogSince at the same
   * unmoved cursor and the server gets the same rows twice.
   */
  pushing: Promise<void> | null;
}
let st: ReporterState | null = null;
const listeners = new Set<() => void>();
/**
 * A subscriber that throws must not be able to take the reporter down: from
 * `arm`'s chain it would surface as an unhandled rejection AND skip the
 * following `arm(s)` re-schedule (silently killing the reporter forever);
 * from `flushLogReporter` it would propagate into the caller's click handler.
 * Either violates "never throws into app code".
 */
const notify = () => {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* a bad subscriber must not kill the reporter or its caller */
    }
  }
};

const randomId = () => Math.random().toString(36).slice(2, 8);

async function push(s: ReporterState): Promise<void> {
  try {
    const { next, lines } = dlogSince(s.cursor);
    if (lines.length > 0) {
      try {
        const res = await s.fetchFn('/api/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device: s.device, session: s.session, rows: lines }),
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        s.cursor = next;
        s.failures = 0;
      } catch {
        s.failures += 1; // cursor unmoved: these lines go again next tick
      }
    } else {
      s.cursor = next; // adopt even when empty — survives a dlogReset
    }
  } catch {
    /* defensive: dlogSince is not expected to throw, but it must not be able
     * to take the reporter down either if it somehow did */
  } finally {
    notify();
  }
}

/**
 * Run exactly one push for `s`, joining an already-in-flight one instead of
 * starting a second. Callers (the tick timer and flushLogReporter) both go
 * through this so at most one push is ever outstanding per reporter state.
 */
function runOnce(s: ReporterState): Promise<void> {
  if (s.pushing) return s.pushing;
  const p = push(s).finally(() => {
    if (s.pushing === p) s.pushing = null;
  });
  s.pushing = p;
  return p;
}

function arm(s: ReporterState): void {
  const delay = s.failures >= BACKOFF_AFTER ? s.backoffMs : s.intervalMs;
  s.timer = setTimeout(() => {
    // Null out first: by the time this fires the id is spent, and leaving it
    // set would make a concurrent flushLogReporter's clearTimeout a no-op on
    // a stale id instead of the no-op-because-already-null it should be.
    s.timer = null;
    void runOnce(s).then(() => { if (st === s) arm(s); });
  }, delay);
}

export function startLogReporter(opts: {
  device?: string; fetchFn?: typeof fetch; intervalMs?: number; backoffMs?: number;
} = {}): void {
  if (st) return; // idempotent: main.tsx calls once, HMR may call again
  const s: ReporterState = {
    enabled: false,
    device: opts.device ?? `dev-${randomId()}`,
    session: randomId(),
    cursor: 0,
    failures: 0,
    fetchFn: opts.fetchFn ?? fetch.bind(globalThis),
    intervalMs: opts.intervalMs ?? INTERVAL_MS,
    backoffMs: opts.backoffMs ?? BACKOFF_MS,
    timer: null,
    pushing: null,
  };
  st = s;
  void (async () => {
    try {
      const res = await s.fetchFn('/api/log', { method: 'GET' });
      if (!res.ok) return; // Pages (404) or anything else odd: stay off
      s.enabled = true;
      notify();
      arm(s);
    } catch {
      /* no server (Pages, offline): permanently off */
    }
  })();
}

/** Immediate push — the ▤ log panel's "send now". Safe when disabled. */
export async function flushLogReporter(): Promise<void> {
  const s = st;
  if (!s || !s.enabled) return;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  // Joins an in-flight tick's push via runOnce rather than starting a second
  // one (same cursor, same rows — would duplicate them on the server).
  await runOnce(s);
  // If a joined tick already re-armed while we were awaiting, don't do it
  // again — that is exactly the double-arm this function used to cause.
  if (st === s && !s.timer) arm(s);
}

export function logReporterEnabled(): boolean {
  return st?.enabled ?? false;
}

export function onLogReporterChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Tests only: tear down timers and state so runs stay isolated. */
export function stopLogReporter(): void {
  if (st?.timer) clearTimeout(st.timer);
  st = null;
  listeners.clear();
}

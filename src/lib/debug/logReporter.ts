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
}
let st: ReporterState | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const cb of listeners) cb(); };

const randomId = () => Math.random().toString(36).slice(2, 8);

async function push(s: ReporterState): Promise<void> {
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
  notify();
}

function arm(s: ReporterState): void {
  const delay = s.failures >= BACKOFF_AFTER ? s.backoffMs : s.intervalMs;
  s.timer = setTimeout(() => { void push(s).then(() => { if (st === s) arm(s); }); }, delay);
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
  if (s.timer) clearTimeout(s.timer);
  await push(s);
  if (st === s) arm(s);
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

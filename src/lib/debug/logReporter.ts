// src/lib/debug/logReporter.ts
/**
 * logReporter — pushes the dlog ring to a LAN log server, incrementally.
 *
 * Exists for the phone: its 500-record ring silently loses the start of any
 * long session, and exporting it means touching the phone mid-test. When the
 * app is served by scripts/log-server.mjs or the vite dev server, /api/log
 * answers the startup probe with its 204 and this module pushes every NEW line
 * (dlogSince cursor — nothing sent twice) every 5 s. Anywhere else — GitHub
 * Pages' 404, an SPA fallback's 200 index.html — the probe does not match and
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
const TIMEOUT_MS = 10000;

/**
 * The endpoint answers 204 to both the probe and a stored POST, and nothing
 * else does. "Any 2xx" is not good enough: every SPA-fallback host (including
 * `npm run preview`) answers GET /api/log with 200 index.html, which would
 * light the "PC: connected" chip and advance the cursor while not one line
 * ever reaches disk — silent data loss in the tool you reach for when you
 * suspect data loss.
 */
const isEndpointReply = (res: Response): boolean => res.status === 204;

interface ReporterState {
  enabled: boolean;
  device: string;
  session: string;
  cursor: number;
  /**
   * The dlog generation `cursor` belongs to. -1 = "not yet observed"; the
   * first push adopts whatever the ring reports. A change means dlogReset ran
   * underneath us (app.ts does it per speed-test trial) and the cursor is
   * meaningless — see push().
   */
  generation: number;
  failures: number;
  fetchFn: typeof fetch;
  intervalMs: number;
  backoffMs: number;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  /**
   * The in-flight push, if any. Both the periodic tick and flushLogReporter
   * route through runOnce, which joins this promise instead of starting a
   * second concurrent push — that is what keeps "at most one in-flight push,
   * at most one live timer" true when a flush lands mid-tick (or two flushes
   * land back to back). Without it, two pushes read dlogSince at the same
   * unmoved cursor and the server gets the same rows twice.
   */
  pushing: Promise<boolean> | null;
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

const CLIENT_SLUG_KEY = 'eardrop.clientSlug';

/**
 * A coarse, human-readable name for this browser/OS, e.g. `chrome-android`.
 *
 * Deliberately coarse. This is a filename token whose only job is to let
 * someone reading `logs/` tell the phone's file from the PC's at a glance —
 * precisely the thing `dev-ih9jof` could not do. Version numbers and exact
 * engine identification would make it longer and less legible without making
 * it more useful, and the log body already carries the details.
 *
 * Order matters: Edge and most Android browsers put "Chrome" in their UA too,
 * so the more specific names have to be tested first, and Safari last because
 * every WebKit-shell UA contains "Safari".
 */
function uaLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /Android/i.test(ua) ? 'android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'ios'
      : /Windows/i.test(ua) ? 'windows'
        : /Mac OS X/i.test(ua) ? 'macos'
          : /Linux/i.test(ua) ? 'linux'
            : 'os';
  const browser = /Edg\//.test(ua) ? 'edge'
    : /OPR\//.test(ua) ? 'opera'
      : /SamsungBrowser/i.test(ua) ? 'samsung'
        : /Firefox\//.test(ua) ? 'firefox'
          : /Chrome\//.test(ua) ? 'chrome'
            : /Safari\//.test(ua) ? 'safari'
              : 'browser';
  return `${browser}-${os}`;
}

/**
 * A stable per-device identity, e.g. `chrome-android-k3n8`.
 *
 * Persisted in localStorage because the previous scheme minted a fresh random
 * id on every reload, so one phone across a debugging session scattered itself
 * over a directory of unrelated-looking filenames with no way to tell which
 * were the same device. The random suffix survives because two phones running
 * the same browser and OS would otherwise collide into one file.
 *
 * localStorage is wrapped: it throws on access in a partitioned or
 * storage-blocked context, and this module's contract is that it never throws
 * into app code. Losing persistence degrades to the old per-reload behaviour,
 * which is worse but not broken.
 */
function clientSlug(): string {
  const fresh = () => `${uaLabel()}-${randomId().slice(0, 4)}`;
  try {
    const store = globalThis.localStorage;
    if (!store) return fresh();
    const saved = store.getItem(CLIENT_SLUG_KEY);
    if (saved) return saved;
    const made = fresh();
    store.setItem(CLIENT_SLUG_KEY, made);
    return made;
  } catch {
    return fresh();
  }
}

/**
 * A request that never settles would block this reporter forever: pushes are
 * coalesced through one in-flight promise, so every later tick AND the manual
 * "send to PC" button would join a promise that can never resolve. A phone on
 * a flaky LAN produces exactly that. AbortSignal.timeout is guarded because
 * the module is also loaded under test/older runtimes; without it we simply
 * lose the timeout, not the push.
 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  const ctor = globalThis.AbortSignal as (typeof AbortSignal | undefined);
  return typeof ctor?.timeout === 'function' ? ctor.timeout(ms) : undefined;
}

/** Resolves true when the ring is fully delivered (including "nothing new"). */
async function push(s: ReporterState): Promise<boolean> {
  try {
    let read = dlogSince(s.cursor);
    // A generation change means the ring was reset underneath us, so `cursor`
    // indexes a sequence space that no longer exists. Reading from 0 resends
    // the whole fresh ring; the alternative (trusting the cursor) drops the
    // entire new run whenever it is at least as long as the old one, which is
    // precisely the per-trial speed-test case.
    if (read.generation !== s.generation) read = dlogSince(0);
    // The ring evicted lines this cursor never got to read — a burst outran
    // the 5 s tick. They are unrecoverable, but shipping the survivors
    // unannounced yields a file that reads as a COMPLETE record of the run,
    // and the hole always lands mid-burst: precisely where the interesting
    // thing happened. Diagnosing an over-the-air transfer from such a log
    // means reading "line absent" as "event did not occur", which is how a
    // missing [TX-COMP] was taken as proof the sender never transmitted.
    // Marker goes in-band, as the first row, so it survives to disk with the
    // same path as everything else.
    const rows = read.dropped > 0
      ? [`! [DLOG] linesDropped=${read.dropped} reason=ringOverflow`, ...read.lines]
      : read.lines;
    if (rows.length > 0) {
      try {
        const res = await s.fetchFn('/api/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ device: s.device, session: s.session, rows }),
          signal: timeoutSignal(s.timeoutMs),
        });
        if (!isEndpointReply(res)) throw new Error(`status ${res.status}`);
        s.cursor = read.next;
        s.generation = read.generation;
        s.failures = 0;
      } catch {
        // Cursor AND generation unmoved: these lines go again next tick, and
        // a still-unacknowledged reset is still seen as a reset.
        s.failures += 1;
        return false;
      }
    } else {
      s.cursor = read.next; // adopt even when empty — survives a dlogReset
      s.generation = read.generation;
    }
    return true;
  } catch {
    /* defensive: dlogSince is not expected to throw, but it must not be able
     * to take the reporter down either if it somehow did */
    return false;
  } finally {
    notify();
  }
}

/**
 * Run exactly one push for `s`, joining an already-in-flight one instead of
 * starting a second. Callers (the tick timer and flushLogReporter) both go
 * through this so at most one push is ever outstanding per reporter state.
 */
function runOnce(s: ReporterState): Promise<boolean> {
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
  device?: string; fetchFn?: typeof fetch;
  intervalMs?: number; backoffMs?: number; timeoutMs?: number;
} = {}): void {
  if (st) return; // idempotent: main.tsx calls once, HMR may call again
  const s: ReporterState = {
    enabled: false,
    // `dev-<random>` told you nothing and changed every reload. The slug is a
    // persisted per-device identity; `session` stays random per load, so one
    // device's runs sort together and are still separable.
    device: opts.device ?? clientSlug(),
    session: randomId(),
    cursor: 0,
    generation: -1,
    failures: 0,
    fetchFn: opts.fetchFn ?? fetch.bind(globalThis),
    intervalMs: opts.intervalMs ?? INTERVAL_MS,
    backoffMs: opts.backoffMs ?? BACKOFF_MS,
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    timer: null,
    pushing: null,
  };
  st = s;
  void (async () => {
    try {
      const res = await s.fetchFn('/api/log', { method: 'GET' });
      // Pages (404), an SPA fallback's 200 index.html, anything but our own
      // endpoint's 204: stay off, permanently and silently.
      if (!isEndpointReply(res)) return;
      s.enabled = true;
      notify();
      arm(s);
    } catch {
      /* no server (Pages, offline): permanently off */
    }
  })();
}

/**
 * Immediate push — the ▤ log panel's "send now". Safe when disabled.
 *
 * Resolves true only when the rows actually reached the server (or there was
 * nothing new to send), false otherwise. It deliberately never REJECTS —
 * "never throws into app code" is the module's invariant — so the outcome has
 * to come back as a value, or the caller's "send failed" branch is dead code
 * and a 500 or a full disk still flashes "sent to PC".
 */
export async function flushLogReporter(): Promise<boolean> {
  const s = st;
  if (!s || !s.enabled) return false;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  // Joins an in-flight tick's push via runOnce rather than starting a second
  // one (same cursor, same rows — would duplicate them on the server).
  const ok = await runOnce(s);
  // If a joined tick already re-armed while we were awaiting, don't do it
  // again — that is exactly the double-arm this function used to cause.
  if (st === s && !s.timer) arm(s);
  return ok;
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

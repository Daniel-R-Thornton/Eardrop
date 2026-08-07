# LAN Log Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone on the LAN auto-pushes its dlog ring to this PC, so acoustic-chat failures can be diagnosed without touching the phone mid-test.

**Architecture:** One shared Node request handler (`scripts/log-endpoint.mjs`) serves `POST /api/log` in three hosts: a zero-dependency standalone server that also serves `dist/` (`npm run logserver`), and the Vite dev server via a tiny inline plugin. The client (`src/lib/debug/logReporter.ts`) probes the relative `/api/log` at startup — inert on GitHub Pages — and, when reachable, pushes new dlog lines every 5 s using a cursor added to `dlog.ts`. Spec: `docs/superpowers/specs/2026-08-07-lan-log-reporting-design.md`.

**Tech Stack:** Node `http`/`fs` (no new dependencies), TypeScript, React, vitest.

## Global Constraints

- Zero new npm dependencies.
- `tsconfig.json` only includes `src/`, so `.mjs` files in `scripts/` need a sibling `.d.mts` for any TS import; vitest only discovers `src/**/*.test.ts(x)`.
- Server port default `8790` (`PORT` env overrides); reporter interval 5000 ms, backoff interval 30000 ms after 3 consecutive POST failures; body cap 1 MB; `device`/`session` sanitized to `[A-Za-z0-9_-]`, max 64 chars.
- The reporter must never throw into app code, and must stay permanently off when the probe fails (the Pages case).
- Log files: `logs/<yyyy-mm-dd>/<device>-<session>.log`, append-only. `logs/` is gitignored.
- Follow existing style: heavy "why" doc comments, no trailing-comment noise, `T` theme tokens in UI.
- Run all commands from the repo root. Lint/typecheck must stay clean for touched files (`npx eslint <files>`, `npm run typecheck`).

---

### Task 1: dlog cursor — `dlogSince(seq)`

**Files:**
- Modify: `src/lib/debug/dlog.ts` (ringPush is at ~line 122; exports near line 300)
- Test: `src/lib/debug/dlogSince.test.ts`

**Interfaces:**
- Produces: `dlogSince(seq: number): { next: number; lines: string[] }` — `lines` are the formatted ring lines emitted after cursor `seq` and still in the ring; `next` is the new cursor. Callers must always adopt `next`, even when `lines` is empty (this is what makes a `dlogReset()` mid-session self-heal).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/debug/dlogSince.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { dlog, dlogReset, dlogSince, DLOG_RING_MAX } from './dlog';

describe('dlogSince', () => {
  beforeEach(() => dlogReset());

  it('returns lines emitted after the cursor, and a cursor that resumes', () => {
    dlog('T1', { a: 1 });
    dlog('T1', { a: 2 });
    const first = dlogSince(0);
    expect(first.lines).toHaveLength(2);

    dlog('T1', { a: 3 });
    const second = dlogSince(first.next);
    expect(second.lines).toHaveLength(1);
    expect(second.lines[0]).toContain('a=3');
    expect(dlogSince(second.next).lines).toHaveLength(0);
  });

  it('clamps a cursor that predates lines the ring already evicted', () => {
    for (let i = 0; i < DLOG_RING_MAX + 20; i++) dlog('T1', { i });
    const { lines } = dlogSince(0);
    expect(lines).toHaveLength(DLOG_RING_MAX); // the 20 evicted lines are gone, not re-invented
  });

  it('clamps a cursor from before a dlogReset instead of stalling forever', () => {
    for (let i = 0; i < 5; i++) dlog('T1', { i });
    const { next } = dlogSince(0);
    dlogReset();
    dlog('T1', { fresh: true });
    // Old cursor is now beyond totalEmitted. Adopting `next` must converge on
    // the fresh line within one further call rather than returning empty forever.
    const after = dlogSince(next);
    const recovered = dlogSince(after.next);
    expect([...after.lines, ...recovered.lines].join('\n')).toContain('fresh=true');
  });
});
```

Note: `dlog(tag, fields)` deduplicates identical consecutive bodies — every test line above varies its fields, keep it that way.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/debug/dlogSince.test.ts`
Expected: FAIL — `dlogSince` is not exported.

- [ ] **Step 3: Implement**

In `dlog.ts`, add a counter next to the ring state and increment it in `ringPush` (single push site):

```ts
/** Lines ever pushed to the ring, including evicted ones — the sequence space
 *  dlogSince cursors live in. Reset with the ring (dlogReset), which dlogSince
 *  callers survive by always adopting the returned cursor. */
let totalEmitted = 0;
```

In `ringPush`, first line: `totalEmitted++;`

In `dlogReset`, add: `totalEmitted = 0;`

Near `dlogDump`, add:

```ts
/**
 * Incremental read of the ring for the LAN log reporter: everything emitted
 * after cursor `seq`, plus the cursor to resume from. Clamped on both sides —
 * a cursor older than the ring's tail yields what survives (eviction loses
 * lines, it must not fabricate them), and a cursor from before a dlogReset
 * (now larger than totalEmitted) yields the current head rather than an
 * empty result forever. Callers always adopt `next`.
 */
export function dlogSince(seq: number): { next: number; lines: string[] } {
  const start = Math.min(Math.max(seq, totalEmitted - ring.length), totalEmitted);
  return { next: totalEmitted, lines: ring.slice(ring.length - (totalEmitted - start)) };
}
```

Careful: `ring.slice(ring.length - 0)` must return `[]` — it does (`slice(len)`), no special case needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/debug/dlogSince.test.ts` — expected PASS.
Run: `npx vitest run src/lib` and `npm run typecheck` — no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/debug/dlog.ts src/lib/debug/dlogSince.test.ts
git commit -m "feat(dlog): incremental cursor read for the LAN log reporter"
```

---

### Task 2: shared endpoint handler — `scripts/log-endpoint.mjs`

**Files:**
- Create: `scripts/log-endpoint.mjs`, `scripts/log-endpoint.d.mts`
- Modify: `.gitignore` (append `logs/`)
- Test: `src/lib/debug/logEndpoint.test.ts`

**Interfaces:**
- Produces: `handleLogRequest(req, res, opts: { rootDir: string }): Promise<boolean>` — returns `true` if the URL was `/api/log` (response already sent), `false` otherwise (caller serves it). Consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/debug/logEndpoint.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Node context test (no jsdom needed): the handler is plain Node code.
import { handleLogRequest } from '../../../scripts/log-endpoint.mjs';

let server: http.Server;
let base: string;
let rootDir: string;

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'eardrop-log-'));
  server = http.createServer((req, res) => {
    void handleLogRequest(req, res, { rootDir }).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: unknown) => fetch(`${base}/api/log`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('log endpoint', () => {
  it('answers the GET probe with 204', async () => {
    expect((await fetch(`${base}/api/log`)).status).toBe(204);
  });

  it('appends rows across POSTs to one file per device+session', async () => {
    expect((await post({ device: 'ph1', session: 'abc', rows: ['row one'] })).status).toBe(204);
    expect((await post({ device: 'ph1', session: 'abc', rows: ['row two'] })).status).toBe(204);
    const date = new Date().toISOString().slice(0, 10);
    const text = await readFile(join(rootDir, 'logs', date, 'ph1-abc.log'), 'utf8');
    expect(text).toBe('row one\nrow two\n');
  });

  it('sanitizes device/session so a request cannot escape logs/', async () => {
    expect((await post({ device: '../../evil', session: 'a/b', rows: ['x'] })).status).toBe(204);
    const date = new Date().toISOString().slice(0, 10);
    const text = await readFile(join(rootDir, 'logs', date, 'evil-ab.log'), 'utf8');
    expect(text).toBe('x\n');
  });

  it('rejects malformed JSON with 400 and other methods with 405', async () => {
    const bad = await fetch(`${base}/api/log`, { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/log`, { method: 'PUT' })).status).toBe(405);
  });

  it('leaves non-/api/log URLs to the caller', async () => {
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/debug/logEndpoint.test.ts`
Expected: FAIL — cannot resolve `../../../scripts/log-endpoint.mjs`.

- [ ] **Step 3: Implement**

`scripts/log-endpoint.mjs`:

```js
/**
 * log-endpoint.mjs — the one place POST /api/log is implemented.
 *
 * Shared by the standalone LAN log server (scripts/log-server.mjs) and the
 * Vite dev server (vite.config.ts plugin) so a phone can report against
 * either with the same relative URL. Plain .mjs, not TS: the standalone
 * server must run under bare `node` with no build step.
 *
 * Appends rows to logs/<yyyy-mm-dd>/<device>-<session>.log under rootDir.
 * Append-only on purpose — the phone's dlog ring holds 500 records, and this
 * file is what survives after the ring wraps.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BODY_CAP = 1024 * 1024;

/** Strip to [A-Za-z0-9_-] and cap length: these become path segments, and a
 *  request must never be able to write outside logs/. */
const sanitize = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown';

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > BODY_CAP) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/** Handle /api/log; returns true if the URL was ours (response sent). */
export async function handleLogRequest(req, res, { rootDir }) {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/api/log') return false;
  try {
    if (req.method === 'GET') { res.statusCode = 204; res.end(); return true; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return true; }
    const parsed = JSON.parse(await readBody(req));
    const rows = Array.isArray(parsed.rows) ? parsed.rows.filter((r) => typeof r === 'string') : null;
    if (!rows || rows.length === 0) { res.statusCode = 400; res.end('rows required'); return true; }
    const date = new Date().toISOString().slice(0, 10);
    const dir = join(rootDir, 'logs', date);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${sanitize(parsed.device)}-${sanitize(parsed.session)}.log`), `${rows.join('\n')}\n`);
    res.statusCode = 204;
    res.end();
  } catch (err) {
    res.statusCode = 400;
    res.end(err instanceof Error ? err.message : 'bad request');
  }
  return true;
}
```

`scripts/log-endpoint.d.mts` (lets TS files import the module; tsconfig only includes src/, but declaration lookup follows the import):

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
export function handleLogRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { rootDir: string },
): Promise<boolean>;
```

Append `logs/` on its own line to `.gitignore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/debug/logEndpoint.test.ts` — expected PASS.
Run: `npm run typecheck` — expected clean (proves the `.d.mts` resolves).

- [ ] **Step 5: Commit**

```bash
git add scripts/log-endpoint.mjs scripts/log-endpoint.d.mts src/lib/debug/logEndpoint.test.ts .gitignore
git commit -m "feat(logserver): shared /api/log append handler"
```

---

### Task 3: standalone LAN server — `scripts/log-server.mjs`, `npm run logserver`

**Files:**
- Create: `scripts/log-server.mjs`, `scripts/log-server.d.mts`
- Modify: `package.json` (scripts)
- Test: `src/lib/debug/logServer.test.ts`

**Interfaces:**
- Consumes: `handleLogRequest` from Task 2.
- Produces: `createLogServer(opts: { rootDir: string; distDir: string }): http.Server` (not yet listening), plus a CLI entry that listens on `0.0.0.0:${PORT ?? 8790}` when run directly.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/debug/logServer.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogServer } from '../../../scripts/log-server.mjs';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'eardrop-srv-'));
  const distDir = join(rootDir, 'dist');
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>eardrop</title>');
  await writeFile(join(distDir, 'assets', 'app.js'), 'console.log(1)');
  server = createLogServer({ rootDir, distDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('log server', () => {
  it('serves static files with sensible MIME types', async () => {
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('falls back to index.html for SPA routes', async () => {
    const page = await fetch(`${base}/room/whatever`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('eardrop');
  });

  it('refuses path traversal out of dist', async () => {
    expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status).not.toBe(200);
  });

  it('mounts the /api/log handler', async () => {
    expect((await fetch(`${base}/api/log`)).status).toBe(204);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/debug/logServer.test.ts`
Expected: FAIL — cannot resolve `../../../scripts/log-server.mjs`.

- [ ] **Step 3: Implement**

`scripts/log-server.mjs`:

```js
/**
 * log-server.mjs — LAN debug server: serves the built app over plain http AND
 * collects phone logs at POST /api/log (see log-endpoint.mjs).
 *
 * Exists because the deployed site is https and a browser will not let an
 * https page POST to a plain-http LAN address. Instead of fighting certs,
 * both devices browse to THIS server during a debug session — which also
 * guarantees both run the identical build (probe wire-format changes made
 * build mismatch a real failure class).
 *
 * Run: npm run build && npm run logserver   (PORT env overrides 8790)
 * Note: build with the default base "/" (do NOT set VITE_BASE) — the Pages
 * build under /Eardrop/ will not load from here.
 */
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleLogRequest } from './log-endpoint.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createLogServer({ rootDir, distDir }) {
  const distRoot = resolve(distDir);
  return http.createServer((req, res) => {
    void (async () => {
      if (await handleLogRequest(req, res, { rootDir })) return;
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      // normalize + prefix check, not string filtering: the only invariant
      // that matters is that the resolved path stays inside dist.
      let filePath = resolve(join(distRoot, normalize(urlPath)));
      if (filePath !== distRoot && !filePath.startsWith(distRoot + sep)) {
        res.statusCode = 403; res.end(); return;
      }
      const exists = await stat(filePath).then((s) => s.isFile()).catch(() => false);
      if (!exists) filePath = join(distRoot, 'index.html'); // SPA fallback
      res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
      createReadStream(filePath)
        .on('error', () => { res.statusCode = 500; res.end(); })
        .pipe(res);
    })().catch(() => { res.statusCode = 500; res.end(); });
  });
}

// CLI entry: only when run directly (`node scripts/log-server.mjs`).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const distDir = join(rootDir, 'dist');
  const port = Number(process.env.PORT) || 8790;
  const hasDist = await stat(join(distDir, 'index.html')).then(() => true).catch(() => false);
  if (!hasDist) {
    console.error('dist/index.html not found — run `npm run build` first (default base, no VITE_BASE).');
    process.exit(1);
  }
  createLogServer({ rootDir, distDir }).listen(port, '0.0.0.0', () => {
    const urls = Object.values(networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i.address}:${port}`);
    console.log(`eardrop log server — logs append under logs/<date>/`);
    for (const u of urls) console.log(`  ${u}`);
  });
}
```

`scripts/log-server.d.mts`:

```ts
import type { Server } from 'node:http';
export function createLogServer(opts: { rootDir: string; distDir: string }): Server;
```

`package.json` scripts, add: `"logserver": "node scripts/log-server.mjs"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/debug/logServer.test.ts` — expected PASS.
Smoke: `npm run build && npm run logserver` in background, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/` → `200`, `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/api/log` → `204`, then kill it.

- [ ] **Step 5: Commit**

```bash
git add scripts/log-server.mjs scripts/log-server.d.mts src/lib/debug/logServer.test.ts package.json
git commit -m "feat(logserver): standalone LAN server serving dist + /api/log"
```

---

### Task 4: Vite dev-server parity

**Files:**
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: `handleLogRequest` from Task 2.

- [ ] **Step 1: Add the plugin**

Replace `vite.config.ts` contents with:

```ts
import { defineConfig } from "vite";
import { handleLogRequest } from "./scripts/log-endpoint.mjs";

export default defineConfig({
  root: ".",
  // GitHub Pages serves the site from /<repo>/ — the deploy workflow sets
  // VITE_BASE accordingly; local dev/preview stay at /.
  base: process.env.VITE_BASE ?? "/",
  build: { outDir: "dist" },
  server: { host: "0.0.0.0", port: 5173 },
  plugins: [
    {
      // Same POST /api/log the standalone log server mounts, so a phone
      // loading the dev server reports identically (see log-endpoint.mjs).
      name: "eardrop-log-endpoint",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          void handleLogRequest(req, res, { rootDir: process.cwd() }).then(
            (handled) => { if (!handled) next(); },
            next,
          );
        });
      },
    },
  ],
});
```

- [ ] **Step 2: Verify against the running dev server**

Run `npm run dev` in the background; then:
`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5173/api/log` → `204`
`curl -s -o /dev/null -w '%{http_code}' -X POST -d '{"device":"d","session":"s","rows":["hi"]}' http://127.0.0.1:5173/api/log` → `204`, and `logs/<today>/d-s.log` contains `hi`. Kill the dev server; delete the test log file.

- [ ] **Step 3: Commit**

```bash
git add vite.config.ts
git commit -m "feat(logserver): mount /api/log on the vite dev server"
```

---

### Task 5: client reporter — `src/lib/debug/logReporter.ts`

**Files:**
- Create: `src/lib/debug/logReporter.ts`
- Test: `src/lib/debug/logReporter.test.ts`

**Interfaces:**
- Consumes: `dlogSince` from Task 1.
- Produces (consumed by Task 6):
  - `startLogReporter(opts?: { device?: string; fetchFn?: typeof fetch; intervalMs?: number; backoffMs?: number }): void`
  - `flushLogReporter(): Promise<void>`
  - `logReporterEnabled(): boolean`
  - `onLogReporterChange(cb: () => void): () => void` (fires on enable and after each push attempt; returns unsubscribe)
  - `stopLogReporter(): void` (tests only: clears timers and state)

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/debug/logReporter.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dlog, dlogReset } from './dlog';
import {
  flushLogReporter, logReporterEnabled, startLogReporter, stopLogReporter,
} from './logReporter';

/** fetch stub: GET probe → probeStatus; POST → shift the next scripted status. */
function makeFetch(probeStatus: number, postStatuses: number[]) {
  const posts: { rows: string[] }[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (!init || init.method !== 'POST') return new Response(null, { status: probeStatus });
    posts.push(JSON.parse(String(init.body)));
    return new Response(null, { status: postStatuses.shift() ?? 204 });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, posts };
}

const settle = async () => { await vi.runOnlyPendingTimersAsync(); };

describe('logReporter', () => {
  beforeEach(() => { vi.useFakeTimers(); dlogReset(); });
  afterEach(() => { stopLogReporter(); vi.useRealTimers(); });

  it('stays permanently off when the probe fails (the Pages case)', async () => {
    const { fetchFn, posts } = makeFetch(404, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    expect(logReporterEnabled()).toBe(false);
    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(posts).toHaveLength(0);
  });

  it('pushes each new line exactly once across ticks', async () => {
    const { fetchFn, posts } = makeFetch(204, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    expect(logReporterEnabled()).toBe(true);

    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    dlog('T', { x: 2 });
    dlog('T', { x: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000); // nothing new: no third POST

    expect(posts).toHaveLength(2);
    expect(posts[0].rows.join()).toContain('x=1');
    expect(posts[1].rows).toHaveLength(2);
  });

  it('keeps the cursor on a failed POST and re-sends those lines next tick', async () => {
    const { fetchFn, posts } = makeFetch(204, [500, 204]);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(5000); // 500
    await vi.advanceTimersByTimeAsync(5000); // retry, 204
    expect(posts).toHaveLength(2);
    expect(posts[1].rows.join()).toContain('x=1');
  });

  it('backs off to 30 s after 3 consecutive failures, recovers on success', async () => {
    const { fetchFn, posts } = makeFetch(204, [500, 500, 500, 204]);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { x: 1 });
    await vi.advanceTimersByTimeAsync(15000); // 3 ticks, 3 failures
    expect(posts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5000); // inside backoff: nothing
    expect(posts).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(25000); // backoff expires → 4th push, 204
    expect(posts).toHaveLength(4);
  });

  it('flushLogReporter pushes immediately', async () => {
    const { fetchFn, posts } = makeFetch(204, []);
    startLogReporter({ device: 'd', fetchFn });
    await settle();
    dlog('T', { x: 1 });
    await flushLogReporter();
    expect(posts).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/debug/logReporter.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/debug/logReporter.test.ts` — expected PASS. If a timing test hangs, the usual cause is the probe promise: `settle()` (`runOnlyPendingTimersAsync`) also drains microtasks, which is why the tests await it right after `startLogReporter`.
Run: `npm run typecheck` and `npx eslint src/lib/debug/logReporter.ts src/lib/debug/logReporter.test.ts` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/debug/logReporter.ts src/lib/debug/logReporter.test.ts
git commit -m "feat(logserver): client reporter — probe, incremental push, backoff"
```

---

### Task 6: wire-up — app startup + LogShare UI

**Files:**
- Modify: `src/ui/main.tsx` (call `startLogReporter()` once at module scope, before render)
- Modify: `src/ui/views/LogShare.tsx`
- Test: `src/ui/views/LogShare.reporter.test.tsx`

**Interfaces:**
- Consumes: `startLogReporter`, `flushLogReporter`, `logReporterEnabled`, `onLogReporterChange` from Task 5.

- [ ] **Step 1: Write the failing test**

```tsx
// src/ui/views/LogShare.reporter.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  enabled: false,
  flush: vi.fn(async () => {}),
}));
vi.mock('../../lib/debug/logReporter', () => ({
  logReporterEnabled: () => mock.enabled,
  flushLogReporter: mock.flush,
  onLogReporterChange: () => () => {},
}));

import { LogShare } from './LogShare';

afterEach(() => { cleanup(); mock.enabled = false; mock.flush.mockClear(); });

describe('LogShare reporter row', () => {
  it('shows no PC controls when the reporter is off (Pages)', () => {
    render(<LogShare onClose={() => {}} />);
    expect(screen.queryByText(/send to pc/i)).toBeNull();
  });

  it('shows the chip and sends on click when connected', async () => {
    mock.enabled = true;
    render(<LogShare onClose={() => {}} />);
    expect(screen.getByText(/pc: connected/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/send to pc/i));
    expect(mock.flush).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/views/LogShare.reporter.test.tsx`
Expected: FAIL — "send to pc" not found even with `enabled = true`.

- [ ] **Step 3: Implement**

`src/ui/main.tsx` — at module scope, before the render call:

```tsx
import { startLogReporter } from '../lib/debug/logReporter';

// Probe for a LAN log server (scripts/log-server.mjs or the dev server) and
// auto-push the dlog ring if one answers. Inert on GitHub Pages — the probe
// 404s and the reporter never arms. See logReporter.ts.
startLogReporter();
```

`src/ui/views/LogShare.tsx` — subscribe to the reporter and add one row near the existing buttons (reuse the local `btn()` style helper):

```tsx
import { useSyncExternalStore } from 'react';
import { flushLogReporter, logReporterEnabled, onLogReporterChange } from '../../lib/debug/logReporter';
```

Inside the component:

```tsx
const pcConnected = useSyncExternalStore(onLogReporterChange, logReporterEnabled);
```

In the JSX, alongside the share/download/copy buttons:

```tsx
{pcConnected && (
  <>
    <span style={{ fontFamily: T.mono, fontSize: 11, color: T.phosphor }}>PC: connected</span>
    <button
      type="button"
      style={btn(true)}
      onClick={() => {
        void flushLogReporter().then(
          () => setNote('sent to PC'),
          () => setNote('send failed'),
        );
      }}
    >
      send to PC
    </button>
  </>
)}
```

(Adapt placement to the panel's existing button row; `setNote` already exists for share/copy feedback.)

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npx vitest run src/ui/views/LogShare.reporter.test.tsx src/lib/debug` — PASS.
Run: `npm run typecheck` and `npx eslint src/ui/main.tsx src/ui/views/LogShare.tsx` — clean.

- [ ] **Step 5: End-to-end verification (manual, laptop only)**

1. `npm run build && npm run logserver` (background).
2. Open `http://127.0.0.1:8790/` in a browser, open the room UI so dlog emits.
3. Within ~10 s, `ls logs/$(date +%F)/` shows a `dev-*-*.log` growing; ▤ log panel shows "PC: connected"; **send to PC** appends immediately.
4. Kill the server. (Phone check happens next real debug session: phone browses to the printed LAN URL.)

- [ ] **Step 6: Commit**

```bash
git add src/ui/main.tsx src/ui/views/LogShare.tsx src/ui/views/LogShare.reporter.test.tsx
git commit -m "feat(logserver): auto-report on startup + send-to-PC in the log panel"
```

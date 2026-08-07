# LAN log reporting — design

**Date:** 2026-08-07
**Problem:** Debugging real phone↔laptop acoustic sessions needs the phone's dlog
ring on this PC, without touching the phone mid-test. The dlog ring holds only
500 records, so anything not exported promptly is lost; and the Pages site is
https, so it cannot POST to a plain-http LAN address at all.

**Decision (with user):** don't fight mixed content. A small LAN server on the
PC serves the built app over http *and* collects logs. During a debug session
both devices browse to the PC's URL instead of Pages — which also guarantees
both devices run the identical build (probe wire format changes made build
mismatch a real failure class). Pages behavior is unchanged.

## Components

### 1. Shared handler — `scripts/log-endpoint.mjs`

One plain-JS module exporting `handleLogRequest(req, res, {rootDir})` used by
both servers below. Behavior:

- `GET /api/log` → `204` (the client's connectivity probe).
- `POST /api/log` → body is JSON `{device: string, session: string, rows: string[]}`.
  Appends `rows` (newline-joined) to `logs/<yyyy-mm-dd>/<device>-<session>.log`
  under the repo root, creating directories as needed. Responds `204`.
- Sanitizes `device`/`session` to `[A-Za-z0-9_-]` (truncated to 64 chars) so a
  request can never write outside `logs/`.
- Caps body at 1 MB; malformed JSON or oversized body → `400`. Never crashes
  the server.
- Any other `/api/log*` method → `405`.

`logs/` is added to `.gitignore`.

### 2. Standalone server — `scripts/log-server.mjs`, `npm run logserver`

Zero-dependency Node http server:

- Listens on `0.0.0.0`, port `8790` (`PORT` env overrides).
- Routes `/api/log` to the shared handler; everything else is static file
  serving from `dist/` with SPA fallback to `index.html` and correct MIME types
  for the extensions the build emits (html, js, css, map, svg, wasm, json).
- On startup prints the LAN URL(s) (from `os.networkInterfaces()`) and exits
  with a clear message if `dist/` is missing ("run `npm run build` first").
- Serving-note: `vite build` must use base `/` (the default local build), not
  the `/Eardrop/` Pages base — the run script documents this; no VITE_BASE set.

### 3. Vite dev parity

A ~10-line inline plugin in `vite.config.ts` (`configureServer`) mounts the
same shared handler on the dev server, so a phone loading
`http://<pc>:5173` (vite `--host`) reports identically. Relative `/api/log`
therefore works in all three cases: dev server, log server, and (harmlessly
404ing) Pages.

### 4. Client reporter — `src/lib/debug/logReporter.ts`

- `startLogReporter()` called once from app startup. It `fetch`es
  `GET /api/log`; anything but 2xx (or a thrown fetch, i.e. Pages) disables the
  reporter for the session. No settings, no UI dependency.
- When enabled: every 5 s, read the dlog ring and POST only records not yet
  sent, tracked by a cursor. The ring evicts from the front, so the cursor is a
  count of records ever pushed compared against a monotonic per-record sequence
  (dlog already forwards worker records into the main-thread ring, so one
  cursor covers both threads). If dlog exposes no sequence today, the reporter
  adds one at its own layer by observing ring growth — chosen at implementation
  time; the invariant is: **no record sent twice, no record skipped unless the
  ring evicted it before the next tick** (impossible at 5 s ticks vs 500
  records except under pathological log rates, accepted).
- Rows are formatted with the same formatter the raw `dlogDump` uses, so the
  file on disk is the documented dump format (`docs/dump-format.md`).
- `device` is the modem deviceId when available, else a short random suffix;
  `session` is a random id minted at startup.
- A failed POST keeps the cursor unmoved and retries next tick; three
  consecutive failures stretch the interval to 30 s (server was probably shut
  down) but never disable — the server may come back.
- `flushLogReporter()` exported for the manual button; resolves when the
  in-flight push settles.

### 5. UI — LogShare panel

`src/ui/views/LogShare.tsx` gains one row: a status chip ("PC: connected" /
"PC: off") from the reporter's exposed state, and a **send now** button wired
to `flushLogReporter()`, visible only when the reporter is enabled.

## Error handling

- Server: per-request try/catch → 400/500 responses, process never exits on a
  bad request; write errors are logged to the server console.
- Client: the reporter must never surface an error into app code — all fetch
  paths caught; disabled state is sticky only for the probe, not for pushes.

## Testing (vitest)

- Reporter: fake timers + stubbed `fetch` + stubbed ring — probe-404 stays off;
  incremental cursor sends each record exactly once across ticks and ring
  wraps; failed POST retries without loss; backoff engages after 3 failures;
  `flushLogReporter` pushes immediately.
- Handler: start a real `http.Server` on an ephemeral port in the test; assert
  append-across-POSTs, path sanitization, 400 on bad JSON, 405, and the GET
  probe — writing under a temp dir, not the repo `logs/`.

## Out of scope

No https/certs, no auth (LAN-only debug tool), no log viewer UI, no changes to
the Pages deployment, no server-side log rotation.

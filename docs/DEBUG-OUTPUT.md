# Debug Output Format

All runtime debug output goes through `dlog()` (`src/lib/debug/dlog.ts`) and is
**one line per event**: `[TAG] key=value key=value`. No objects, no multi-line
dumps, no stack traces (info lines use `console.log`, never `console.warn`).
Numbers are 3 significant digits; values outside `[0.01, 1000)` are exponential.

`dlogDump(n)` returns the last *n* emitted lines — paste-ready for LLM analysis.
`dlogSetTagEnabled(tag, false)` silences a tag (wired to debug-panel checkboxes).
High-frequency events are rate-limited at the call site (`every: N`).

## Output modes (`dlogSetMode`)

- **`redraw`** (main thread default, set in `app.ts`) — on every event the console
  is cleared and the ENTIRE ring reprinted as **one console entry** (throttled to
  4 Hz). Copying that single entry captures the whole session. Warn/error lines
  are prefixed `!` / `!!` so severity survives the flat dump.
- **`forward`** (workers) — no console output; each line is posted to the main
  thread (`{type:'dlog', line}`) and injected into its ring via `dlogInject`.
  All contexts share one ring, one copy target.
- **`lines`** (default; tests, node) — one console entry per event.

## Tags — production path (BPSK + OFDM atomic frames)

| Tag | Emitted by | Fields | Healthy values |
|-----|-----------|--------|----------------|
| `RX` | rxEngine | `pllPilot`, `scanFrame` | scanFrame=76 per received frame |
| `OFDM-SYNC` | rxEngine WAITING | `e`, `thr`, `sync` (heartbeat, every 25 windows); `detected=true e=…`; `boundary`, `skip`, `aligned` | e > thr during burst; `aligned=true` — `aligned=false` (warn) means CP boundary search failed and decode will likely produce garbage |
| `OFDM-TRAIN` | rxEngine + demodulator | `symbols`, `pilotAmp`, `h` (per-tone `amp@phase°`) | 12 symbols; tone amps within ~10× of each other |
| `OFDM-DEMOD` | demodulator | `firstSym` — per-tone `t0:phase°/sym` for the first data symbol | equalized phases within ±20° of 0/90/180/270 |
| `RX-SCAN` | SentinelScanner | `frame`,`expect` on hit; heartbeat `bits`, `sentinel=false`, `sr` every 8000 bits | sentinel should hit within ~1000 bits of data start; long `sentinel=false` streams = demod producing wrong bits |
| `RX-FRAME` | rxEngine | `valid`, `type`, `seq`, `len`, `crcRx`, `crcCalc`; `dupHeader/dupPayload/dupTail` (diversity mode); `tail`, `assembled`, `size` | `valid=true`, crcRx == crcCalc |
| `TX-OFDM` | txEngine/ofdmEngine | `enabled`, `tones`, `pilot`; `pilotBin`, `bins`; `syncBurst=24`; `frame`, `seq` | TX `bins` must equal RX `OFDM-SYNC` bins |
| `TX-FRAME` | txEngine | `headerCrc` | — |
| `WARBLE` / `PREAMBLE` / `CAL` / `GUARD` | rxEngine BPSK path | reject/corr, timeout/newThr, refs, absBits | `CAL refs`: 0° and 180° clusters clearly separated per tone |
| `SCAN` | pilot scanner | `peak`, `ratio`, `top5` (every 200); `locked`, `amp`; `noiseFloorSamples` | `ratio` > 5 at lock |
| `REC` | recorder | `start`, `ctxRate`, `ctxState`, `gain`, `device`; `running`, `worklet`, `outRate` | ctxRate=48000, outRate=3200 |
| `PLAY` | player | `rate`, `ms`, `n`, `peak`, `vol`, `device`; `autoNorm`; `clipped` (warn) | `clipped` should never appear |

## Self-test / block-protocol tags

The self-test stack (Encoder/Decoder) uses the older tag set documented in
`LLM_PROMPT.md`: `[PILOT] [PLL] [SYNC] [FRAME] [BLK] [BER] [ECC] [SQWK] [END]`.
Field meanings and healthy ranges are in that file.

## Rules for new debug output

- Use `dlog(tag, fields)` — never raw `console.warn`/`console.log` for modem events.
- One line per event. Multi-tone data goes in one field (`h=1.2e+1@-83 …`), not one line per tone.
- Anything emitted per-window or per-symbol MUST be rate-limited (`every: N`) or
  gated to first-occurrence (see `OFDM-DEMOD firstSym`).
- `level: 'warn'` is reserved for conditions a human must act on (clipping,
  failed boundary alignment) — warn triggers DevTools stack traces.
- No module-load banners (`console.warn('… loaded')`) — version-stamp the
  constructor's first `dlog` line instead (`v: 'v4-eq-align'`).

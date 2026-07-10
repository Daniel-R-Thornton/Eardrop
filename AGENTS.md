# Eardrop — Agent Context

File transfer over audio (speaker → mic, sound only, no network). BPSK on 2/4/8 tones with a continuous pilot as phase/amplitude reference; experimental OFDM/QPSK mode. TypeScript + Vite + React, modem sample rate 3200 Hz.

**Read before working:** `STATE.md` (current state, known issues, OFDM continuation notes). Full spec in `docs/MODEM.md`, architecture in `docs/ARCHITECTURE.md`.

## Hard rules

- **Fragile files — do not edit without running replay + loopback tests before AND after:**
  - `src/modem/protocol/preamble.ts` (warble timing is sensitive)
  - `src/modem/protocol/rxEngine.ts` (BPSK detection + calibration tightly coupled)
  - `src/modem/pilot.ts` (PLL Kp/Ki scaling is fragile)
  - `src/audio/recorder.ts` (Hann-sinc worklet is production quality)
- **Root cause before fixes.** No parameter-twiddling patches on demod/timing bugs — instrument, capture a raw dump, explain the mechanism, then fix. The OFDM "worked before" mystery came from stacked unverified fixes.
- **In-memory tests passing ≠ acoustic works.** Any change to the TX/RX path needs a real acoustic check (two tabs, send a file) before calling it done.
- Debug logging goes through `dlog()` (`src/lib/debug/dlog.ts`) — one line per event, `[TAG] key=value` format, rate-limited for per-window events, `console.warn` reserved for actionable problems. Full tag reference and healthy-value ranges: `docs/DEBUG-OUTPUT.md` (production path) and `docs/LLM_PROMPT.md` (self-test stack). Never add raw `console.*` calls or module-load banners to modem code.

## Tests

```bash
npm test          # vitest — 90 tests, 87 pass
npm run lint      # eslint (airbnb-based)
```

3 pre-existing failures — do NOT chase them unless asked: Doppler +2Hz, Doppler −1Hz, Full Stress (pipeline.test.ts).

## Session hygiene

- Before ending a session in which behaviour changed: update `STATE.md` (what works, what broke, key parameters, next steps). It is the handoff document between sessions.
- Commits: imperative, conventional prefix style used in history (`fix:`, `feat:`, `refactor:`).

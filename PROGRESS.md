# Modem Worker Architecture — Progress

**Branch:** `feat/ofdm-throughput-max`  
**Plan:** `docs/superpowers/plans/2026-07-11-modem-worker-architecture.md`  
**Started/Completed:** 2026-07-11

---

## ✅ All 7 Tasks Complete

| Task | Status | Tests |
|------|--------|-------|
| 1: Batch feed API + schema | ✅ done | `feedChunk`, `getProgress`, `modemSchema.ts` |
| 2: ModemService class | ✅ done | RX/TX lifecycle, telemetry, buffer dump |
| 3: Worker shim + chunked capture | ✅ done | `modem.worker.ts`, recorder chunk API |
| 4: ModemController + single config | ✅ done | `buildModemConfig`, app.ts rewired |
| 5: Telemetry channel | ✅ done | `telemetryStore`, store persistence fix |
| 6: Delete legacy plumbing | ✅ done | broadcast/encoder workers removed |
| 7: Guardrail tests | ✅ done | No per-sample messaging regression |

**Final: 122 pass, 3 pre-existing (BPSK pipeline)**

## Changes

- Mic capture delivers `Float32Array` chunks (was per-sample at 48 kHz)
- All modem logic in `modem.worker.ts` via `ModemService` (testable class)
- `ModemController` is the only main-thread code talking to the worker
- `buildModemConfig()` is the single config assembler (prevents TX/RX mismatch)
- Telemetry at 20 Hz through `telemetryStore` — no `localStorage` writes on meter updates
- Old `broadcast.worker.ts` and `encoder.worker.ts` deleted
- Architecture guardrails prevent per-sample messaging regression

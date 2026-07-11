# Modem Worker Architecture — Progress

**Branch:** `feat/ofdm-throughput-max`  
**Plan:** `docs/superpowers/plans/2026-07-11-modem-worker-architecture.md`  
**Started:** 2026-07-11

---

## Overall

| Task | Status | Subagent | Notes |
|------|--------|----------|-------|
| 1: Batch feed API + schema | ✅ done | worker | 114/117 pass |
| 2: ModemService class | ✅ done | - | 118/121 pass |
| 3: Worker shim + chunked capture | ✅ done | - | 118/121 pass |
| 4: ModemController + single config | ✅ done | - | 120/123 pass |
| 5: Telemetry channel | ✅ done | - | 120/123 pass |
| 6: Delete legacy plumbing | pending | — | Remove broadcast/encoder workers |
| 7: Guardrail tests | pending | — | Architecture regression tests |

---

## Task details

### Task 1: Batch feed API + schema
- [ ] rxEngine.test.ts
- [ ] feedChunk + getProgress methods
- [ ] modemSchema.ts
- [ ] Tests pass

### Task 2: ModemService
- [ ] modemService.test.ts
- [ ] modemService.ts
- [ ] Tests pass

### Task 3: Worker shim + chunked capture
- [ ] modem.worker.ts
- [ ] recorder chunk delivery
- [ ] app.ts bridge
- [ ] Live test

### Task 4: ModemController
- [ ] buildModemConfig.test.ts
- [ ] buildModemConfig.ts
- [ ] ModemController
- [ ] app.ts rewire
- [ ] Live test

### Task 5: Telemetry
- [ ] telemetryStore.ts
- [ ] Store persistence fix
- [ ] app.ts wiring
- [ ] MainApp.tsx meter swap
- [ ] Live test

### Task 6: Delete legacy
- [ ] grep for references
- [ ] Delete files
- [ ] Remove dead Store fields
- [ ] Live test

### Task 7: Guardrails
- [ ] architecture.test.ts
- [ ] Passes

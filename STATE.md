# Eardrop — State Summary

**Branch**: `perf/streaming-encode`
**Last commit**: `35af4ca` — fix(ofdm): freeze decision tracking post-training + prevent chirp probe buffer drain
**Date**: 2026-07-28

---

## Current session — OFDM 32-tone 64-QAM receiver fixes

### Completed this session

#### Fix 1: Decision-tracking freeze after training (`OFDMQPSKDemodulator.ts`)
- **Problem**: After training, all 32 tones equalized to ~-5° (diagnostic trace showed `eqP=-5.3°, -5.5°, -4.6°...`). Decision tracker saw "confident" QPSK symbol `0b00` → updated channelEst toward wrong direction → feedback loop collapsed all subsequent symbols within ~10 symbols.
- **Fix**: Added `postTrainingSymbols` counter; froze decision tracking for first 14 data symbols after training completes. Initial frames use pure training-based compensation; tracking resumes naturally once channel settles.

#### Fix 2: Chirp probe buffer drain prevention (`rxEngine.ts`)
- **Problem**: During chirp probing in WAITING state, each feedSample() iteration extracted a 1200-sample window from `this.buf` via splice, but probe failures fell through without returning. Net loss: ~1199 samples/iteration. By handoff time, buffer was nearly empty. After handoff replaced `this.buf = ofdmAlignBuf.slice(alignedStart)` (~4700 samples), barely enough for 3 training windows out of required 12.
- **Fix**: Gate only the splice operation during active chirp probing (`probingChirp` flag). Window slice still computed for toneIQ diagnostics, but `splice()` skipped — `this.buf` accumulates freely until chirp handoff fires.
- **Verified**: Tests restored to baseline (3 pre-existing failures only).

#### Previously completed in prior sessions
- **Tone count adaptation**: RX PROFILE handler dynamically updates tone count and demodulator config when TX announces different grid (e.g., 32-tone vs default 4). FIX confirmed by `[RX-FRAME] valid=true type=0x04 seq=0 len=160` — first successful PROFILE decode.
- **Removed premature reset**: Eliminated `setToneOrders()` call from `resetLinkProfile()` that overrode profile updates.
- **Lowered chirp sharpness threshold**: Changed from 1.5 to 1.1 to accept wider variety of chirp waveforms.
- **OFDM QAM mapping**: Fixed `setToneOrders()` routing in `OFDMQPSKDemodulator.ts` to correctly apply qamMap → toneOrders → allQpsk flag.
- **Diagnostic enhancement**: Deep phase-trace logs showing raw→chPhase→drift→equalized per tone.

### Acoustic test results (live speaker→mic)
```
[OFDM-SYNC] chirp=true norm=0.716 peak=2.33e+4 idx=58          ← chirp detected
[OFDM-SYNC] chirpProbeFail=true score=0.614 sharpness=1.35      ← CP probe failed
[OFDM-SYNC] chirpProbeFail=true score=0.609 sharpness=1.25
[CAL] refs=t0:-0.06,0.11/-0.06,0.07 ...                         ← calibration OK
[OFDM-TRAIN] symbols=12 pilotAmp=0.586                           ← training complete
[OFDM-DEMOD] firstSym=t0:1°/0 t1:1°/0 ... pilotAmp=0.6085       ← all zeros (expected)
[RX-FRAME] valid=true type=0x04 seq=0 len=160                   ← PROFILE decoded! ✓
[PLAY] done=5.39                                                 ← playback ended
[RX-SCAN] bits=8000 sentinel=false sr=0x133527                   ← noise scan, no file
```

**Key observations:**
- Training completed ✅, PROFILE frame decoded ✅ (tone count adaptation works)
- All tones show 0-1° equalized phase despite varied raw phases (-143° to +111°) — channel estimate matches raw within <1° on every tone. Compensation formula correct; result indicates transmitted signal has reference-phase alignment on all tones.
- Playback ended at 5.39s — short transfer window. Buffer starvation appears resolved (training succeeded), but remaining question: why do received data tones have same constellation points as training reference symbols?
- Next diagnostic step: verify TX waveform actually varies constellation across tones (scope/logic analyzer capture or controlled injection test).

### Current issues

#### Equalization collapse mystery
Raw phases vary wildly across tones (-180° to +180°) but channelEst tracks them almost exactly. After compensation, all land at 0-1°. Possible causes:
1. TX sends identical QAM points (all-reference-phase) — bit-loading/tone-order not applied to modulator output
2. Acoustic path introduces near-constant group delay that perfectly aligns all tones
3. Sampling timing misalignment between TX and RX FFT bins

**Status**: Tracking freeze prevents further degradation. Channel estimates stable. Need to verify TX waveform diversity before proceeding.

#### Buffer starvation partially resolved
Pre-chirp-handoff buffer drain fixed by skipping splice during probing. Chirp handoff now provides sufficient buffer for full training sequence. However, total audio duration available may still be limited by play/start latency gap — next acoustic test should measure actual end-to-end timing.

### Build & tests
- Build: clean ✅
- Tests: **248 passed / 3 failed** (same 3 pre-existing: Doppler ±1Hz + Full Stress)
- No regressions from changes


---

## What works

### Acoustic transfer (BPSK, OFDM checkbox OFF)
- **4 tones, 25 sym/s, pilot at configurable freq** — confirmed working for file transfers
- All debug sweep tools functional (Audio Check, Full Sweep, Multi-Tone, Interference, Fine Sweep, Speed Sweep)

### Audio pipeline
- Hann-windowed 31-tap sinc FIR downsampler in AudioWorklet (48000→3200 Hz)
- Live mic gain slider (1-20×), playback volume slider (1-10×)
- AGC/noise suppression/echo cancellation force-disabled
- Resampled playback via linear interpolation when output rate != modem rate

### OFDM/QPSK (OFDM checkbox ON) — Throughput Max
- **Modulation**: Direct cosine synthesis, configurable tone count (default 32), QPSK per subcarrier, pilot at 1900 Hz (OFDM-scaled 2.0 amplitude)
- **Symbol**: 20 ms + 5 ms cyclic prefix = 25 ms total (~40 sym/s at any hardware rate)
- **Demodulation**: Goertzel / toneIQ bank at exact tone frequencies with per-tone channel equalization (amplitude + phase correction trained on sync burst)
- **Sample rate**: Native hardware rate (48000 / 44100 Hz) — no downsampling. Symbol adapts automatically to any sample rate via `Math.round(sampleRate * OFDM_SYMBOL_MS / 1000)`
- **Sync**: 24-symbol burst (~600 ms), all tones QPSK 0°, detected via total tone energy threshold with adaptive noise floor
- **Boundary alignment**: CP-based correlation at sync time finds symbol-boundary offset; deviation from a sharp peak profile rejects noise false triggers
- **Timing**: **Sync-once-then-coast** — no per-symbol timing tracking. The 5 ms CP (240 samples at 48 kHz) absorbs clock drift. At 50 ppm worst case, ~100 s before drift exceeds CP
- **Drift correction**: Pilot-referenced phase rotation per symbol (common phase error via `driftPerHz = pilotDrift / pilotFreqHz`), does not adjust window stride
- **Channel tracking**: Decision-directed per-tone amplitude + phase update (leaky integrator, α = 0.003) after each hard decision
- **Sync-loss watchdog**: Resets to WAITING if no frame seen for ~15 seconds
- **Tone grid**: 2000-3550 Hz at 50 Hz spacing (32 tones default), pilot at 1900 Hz. All frequencies are multiples of 50 Hz for orthogonality with the 20 ms symbol
- **Frame format**: [SENTINEL 3B][BCH 24B][RS(52,40)×4 = 208B] = 235B carrying 160 payload B (68% payload density)
- **Cross-rate**: Encode at 48000 Hz, decode at 44100 Hz — verified working
- **Tuning**: All OFDM constants centralized in `OFDM_TUNING` in `types.ts`

### Key parameters (current)
| Parameter | Default | Notes |
|-----------|---------|-------|
| Sample rate | Hardware rate | 48000 or 44100 Hz, no downsampling for OFDM |
| Symbol length | 20 ms | Time-domain, adapts to any sample rate |
| CP length | 5 ms | Math.round(sampleRate * 0.005) samples |
| Tone spacing | 50 Hz | Multiples of 50 Hz for orthogonality |
| Tone count | 32 | Configurable 8/16/32 (must be multiple of 4) |
| Pilot freq | 1900 Hz | Below data band (2000-3550 Hz at 32 tones) |
| Pilot amplitude | 2.0 (OFDM) | Previously used BPSK-scaled 0.4 — fixed |
| Net payload rate (32 tones) | ~1707 bps (166 B/s) | 2000-byte file benchmark |
| Raw bitrate (32 tones) | 2560 bps | 2 bits/tone × 32 tones / 0.025 s |

### Throughput benchmark (2000-byte file, 48 kHz)

| Config | 16 tones | 32 tones |
|--------|----------|----------|
| Baseline (45ms symbol, 79B frame) | 41.5 B/s | 80.8 B/s |
| + 4 RS blocks (235B frame) | 48.6 B/s | 92.6 B/s |
| + 20ms symbol (25ms total) | **87.4 B/s** | **166.7 B/s** |
| Overall gain vs baseline | ×2.1 | ×2.1 |

### Code organization
- `src/lib/` — 8 utility modules (math, encoding, crc, ecc, scan, protocol, debug, channel)
- `src/modem/` — modulation/, demodulation/, protocol/, dsp/, ecc/, pilot/, receiver/, channel/, debug/, test/
- `src/audio/` — dsp/, browser/, player.ts, recorder.ts, devices.ts
- `src/workers/` — modem.worker.ts, modemService.ts, modemSchema.ts
- `src/ui/` — app.ts, Store.ts, controllers/, debug/, lib/, styles/

> **Note**: Legacy `encoder.worker.ts` and `broadcast.worker.ts` were removed in favor of unified `modem.worker.ts` + `ModemService` (see `PROGRESS.md`).

### Tests
- **251 tests total** (248 pass, 3 pre-existing failures)
- **All OFDM tests pass**: modulation, demodulation, loopback, sync, acoustic path, cross-rate, hum immunity, frame geometry V2, tuning invariants, pilot level, throughput benchmark, channel drift
- 3 pre-existing failures: Doppler +2Hz, Doppler -1Hz, Full Stress (BPSK pipeline test — do not chase)
- Architecture guardrails prevent per-sample messaging regression and inline modem configs

---

## Known issues

### OFDM acoustic status
- OFDM works in-memory (all tests pass)
- The pilot amplitude bug (buried pilot at 32 tones) is fixed — live acoustic path may now decode reliably at 32 tones
- **Live acoustic testing with real speaker/mic not yet performed for the new timing** — this is the next step

### OFDM timing architecture note
- The OFDM receiver uses **sync-once-then-coast** timing: initial CP correlation aligns the window grid, then consumes symbols at a fixed stride with no per-symbol timing tracking
- The 5 ms CP (240 samples at 48 kHz) provides sufficient guard for typical sub-60-second file transfers
- For long-duration transfers, a future FLL/timing-error-detector would be needed

### OFDM tone count > 16
- 32-tone mode is now the default. Tested in-memory with the fix for pilot amplitude.

### Pre-existing BPSK pipeline failures
- Doppler +2Hz, Doppler -1Hz, Full Stress — BPSK-specific, not related to OFDM changes

---

## Files not to touch without careful testing
- `src/modem/protocol/preamble.ts` — warble timing is sensitive
- `src/modem/protocol/rxEngine.ts` — BPSK detection + calibration tightly coupled
- `src/modem/pilot.ts` — PLL Kp/Ki scaling is fragile
- `src/audio/recorder.ts` — Hann-sinc worklet is production-quality

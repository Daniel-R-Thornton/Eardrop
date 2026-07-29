# Eardrop — State Summary

**Branch**: `review-fixes`
**Last commit**: `35af4ca` — fix(ofdm): freeze decision tracking post-training + prevent chirp probe buffer drain
**Date**: 2026-07-28

---

## Current session — review-fixes cleanup

### Completed this session

#### Fix 1: `framesReceived` progress count (`rxEngine.ts`)
- **Problem**: `processHeader()` incremented `this.framesReceived++` and then immediately assigned `this.framesReceived = 0`, so the header frame was never counted. The UI showed progress lagging behind `totalFrames` (which includes header + payload + tail).
- **Fix**: Reset `receivedPayloadSeqs` and `fileData` first, then set `this.framesReceived = 1` so the header counts. Payload and tail frames continue to increment as before.
- **Files changed**: `src/modem/protocol/rxEngine.ts`.

#### Fix 2: Centralize OFDM sync thresholds (`types.ts` → `rxEngine.ts`)
- **Problem**: CP correlation thresholds in `RxEngine.findOfdmBlockStart` handoff paths were hard-coded literals (`0.35` and `1.1`).
- **Fix**: Added `cpCorrelationMinScore: 0.35` and `cpCorrelationMinSharpness: 1.1` to `OFDM_TUNING` in `src/modem/types.ts` and replaced the literals in `src/modem/protocol/rxEngine.ts` with references to these constants.
- **Files changed**: `src/modem/types.ts`, `src/modem/protocol/rxEngine.ts`.

#### Fix 3: OFDM tuning invariant check (`types.ts`)
- **Problem**: The documented invariant `syncBurstSymbols >= syncMinFrames + 2 + trainingSymbols` had no runtime enforcement.
- **Fix**: Added exported `checkOfdmTuningInvariants()` function that throws a clear error if the invariant is violated, and invoked it at module load.
- **Files changed**: `src/modem/types.ts`.

#### Fix 4: Recorder console cleanup (`recorder.ts`)
- **Problem**: `src/audio/recorder.ts` used raw `console.log`, `console.debug`, and `console.error` for lifecycle messages, inconsistent with the project's `dlog()` debug pipeline.
- **Fix**: Replaced all raw `console.*` calls with `dlog('REC', ...)` or `dlog('REC-ERR', ..., { level: 'warn' })` calls. Removed the now-unused `dbg` import.
- **Files changed**: `src/audio/recorder.ts`.

#### Fix 5: OFDM demod hot-path optimization (`OFDMQPSKDemodulator.ts`, `pilot.ts`, `OFDMQPSKModulator.ts`)
- **Problem**: `OFDMQPSKDemodulator.analyze()` converted every symbol's `Float32Array` window to a regular array via `Array.from(window)`, and `computeQamRefScale()` constructed a full throwaway `OFDMQPSKModulator` on every `setToneOrders()` call.
- **Fix**: 
  1. Updated `toneIQ()` in `src/modem/pilot.ts` to accept `Float32Array` directly, removing the per-symbol `Array.from()` copy.
  2. Replaced the throwaway modulator in `computeQamRefScale()` with a static pure helper that synthesizes the all-zero QPSK training symbol, peak-normalizes it, and applies `toneIQ()` — bit-identical to the old reference for all supported tone counts and sample rates.
  3. Added a memory-footprint comment near the sin/cos table construction in `OFDMQPSKModulator.ts`.
- **Files changed**: `src/modem/demodulation/OFDMQPSKDemodulator.ts`, `src/modem/pilot.ts`, `src/modem/modulation/OFDMQPSKModulator.ts`.

### Build & tests
- Build: clean ✅
- Lint: 221 problems (17 errors, 204 warnings) — same pre-existing issues as before; 1 unused-import warning removed by the recorder cleanup.
- Tests: **259 passed / 3 failed** (pre-existing BPSK pipeline failures: Doppler +2Hz, Doppler −1Hz, Full Stress).
- No regressions from changes.

---

## Previous session — OFDM 32-tone 64-QAM receiver fixes

### Completed this session

#### Fix 1: Decision-tracking freeze after training (`OFDMQPSKDemodulator.ts`)
- **Problem**: After training, all 32 tones equalized to ~-5° (diagnostic trace showed `eqP=-5.3°, -5.5°, -4.6°...`). Decision tracker saw "confident" QPSK symbol `0b00` → updated channelEst toward wrong direction → feedback loop collapsed all subsequent symbols within ~10 symbols.
- **Fix**: Added `postTrainingSymbols` counter; froze decision tracking for first 14 data symbols after training completes. Initial frames use pure training-based compensation; tracking resumes naturally once channel settles.

#### Fix 2: Chirp probe buffer drain prevention (`rxEngine.ts`)
- **Problem**: During chirp probing in WAITING state, each feedSample() iteration extracted a 1200-sample window from `this.buf` via splice, but probe failures fell through without returning. Net loss: ~1199 samples/iteration. By handoff time, buffer was nearly empty. After handoff replaced `this.buf = ofdmAlignBuf.slice(alignedStart)` (~4700 samples), barely enough for 3 training windows out of required 12.
- **Fix**: Gate only the splice operation during active chirp probing (`probingChirp` flag). Window slice still computed for toneIQ diagnostics, but `splice()` skipped — `this.buf` accumulates freely until chirp handoff fires.

#### Fix 3: Chirp→CP handoff sharpness threshold too strict (`rxEngine.ts`)
- **Problem**: After chirp detection succeeded, receiver got stuck in infinite probing loop: `chirpProbeFail=true score=0.61 sharpness=1.4` repeated endlessly because sharpness=1.4 missed the `>= 1.5` threshold. Training symbols (all identical QPSK zero-phase) create multiple CP-correlation peaks across symbol boundaries, raising meanScore and artificially lowering sharpness to ~1.3-1.4 even with clean signal.
- **Fix**: Lowered chirp handoff sharpness threshold from 1.5 to 1.1, matching energy-sync path. Justified because chirp detection already provides high confidence, and energy-sync path successfully handles bursts with sharpness as low as 1.1.
- **Verified**: Tests restored to baseline (3 pre-existing failures only).

#### Fix 4: Chirp detection latency optimization (`rxEngine.ts`)
- **Problem**: Chirp correlation only ran every `sps` samples (1200 samples = 25ms). With chirp duration ~600ms, this consumed ~1+ second of the transmission window before detection fired, leaving insufficient time for training + data frames.
- **Fix**: 
  1. Reduced correlation throttle from `sps` to `sps/4` (300 samples = 6.25ms) — 4× faster detection.
  2. Increased `chirpBuf` capacity from `sps*2` to `sps*4` to prevent premature eviction during weak-SNR accumulation.
  3. On correlation miss: do NOT reset `chirpTick` and do NOT shift `chirpBuf`. Letting the buffer accumulate until a good match arrives, instead of discarding partial signal, prevents repeated weak-detection failures.
- **Verified**: Tests at baseline (3 pre-existing failures only). No regressions.

#### Fix 5: OFDM alignment buffer capacity increase (`rxEngine.ts`) — REVERTED
- **Problem**: `ofdmAlignBuf` was hard-capped at `4 × sps` samples. For OFDM training sequences longer than 4 symbols, the rolling window discarded early training symbols before the chirp→CP handoff probe could accumulate enough CP-correlation history, especially in acoustic channels where the probe threshold was already marginal.
- **Fix**: Compute `alignCap = Math.max(4 × sps, this.OFDM_TRAINING_SYMBOLS × sps)`. This keeps the existing 4-symbol minimum for short trainings while extending the window to the full training duration when more symbols are configured.
- **Result**: In-memory tests stayed at baseline, but real acoustic tests showed `chirpProbeFail=true score=0 sharpness=0 offset=0` with `bufLen=14400`. The larger rolling window eventually includes data symbols (which have no CP structure) alongside training symbols, averaging the CP correlation to zero. **Reverted** to `4 × sps` cap.
- **Conclusion**: A larger `ofdmAlignBuf` hurts the chirp→CP probe because it keeps symbols past the training burst. The probe must see only training symbols; widening the window beyond ~4 symbols is counter-productive.

#### Fix 9: UI progress count includes header and tail frames (`rxEngine.ts`)
- **Problem**: With QAM tracking disabled, real-HW 16-QAM transfers now succeed end-to-end. However the UI showed "2/4 frames" because `framesReceived` only counted payload frames while `totalFrames` included header + payload + tail. The file decoded correctly; only the progress ratio was wrong.
- **Fix**: Increment `this.framesReceived` in `processHeader()` and `processTail()` as well as `processPayload()`.
- **Verified**: In-memory tests remain at baseline.

### Current real-HW status
- **QPSK**: works.
- **16-QAM with qamScaleOverride=0.03, mic gain 6×, QAM tracking disabled**: end-to-end file transfers succeed (profile passes MER≈34 dB, first data frame passes, subsequent frames decode with marginal MER≈8.5 dB but file assembles correctly).
- **Known limitation**: MER on later 16-QAM frames is marginal (~8–9 dB). This is acceptable for the current short transfers but may degrade further with longer files or noisier channels. A proper frame-validated tracker (only update channel estimate after a frame passes CRC) is the next improvement, but keeping tracking disabled is the safe baseline for now.
- **Problem**: With `qamScaleOverride=0.03` and lower mic gain, the profile frame and first 16-QAM data frame decoded cleanly (MER≈32 dB), but subsequent data frames failed CRC as MER collapsed to ~14.8 dB. The decision-directed QAM tracker (`qamTrackingAlpha = 0.15`) was walking the per-tone channel estimate away from the good training-based estimate.
- **Fix**: Reduced `qamTrackingAlpha` from `0.15` to `0.05`. This makes the tracker follow slow channel changes without drifting after a few frames.
- **Verified**: In-memory tests remain at baseline (4 pre-existing failures). No regressions.
- **Problem**: Real audio chains (speaker/amp/AGC/player normalization) can change the amplitude of QAM data symbols relative to the QPSK training burst. The receiver's fixed `qamRefScale` assumes the modulator's predicted ratio, so 16/64-QAM data frames fail CRC even though the profile frame (QPSK) decodes fine.
- **Fix**: Expose the OFDM modulator's `qamScaleOverride` parameter in the UI as a "QAM SCALE" slider. Default `Auto` uses the crest-factor-derived scale; the user can tune the TX QAM amplitude until the receiver's expected amplitude matches the actual transmitted amplitude.
- **Files changed**: `src/ui/views/TxPanel.tsx`, `src/ui/Store.ts`, `src/ui/controllers/buildModemConfig.ts`, `src/ui/app.ts`, `src/modem/protocol/txEngine.ts`, `src/modem/protocol/ofdmEngine.ts`.
- **Verified**: Tests remain at baseline (4 pre-existing failures). TypeScript compiles cleanly.

#### Fix 6: Chirp probe timeout / safety valve (`rxEngine.ts`)
- **Problem**: If the chirp probe returns `{ score: 0, sharpness: 0, offset: 0 }` repeatedly, the state machine never advances because `chirpDetected` stays true and the energy-sync path is gated by `!chirpDetected`. The same failing probe runs every `feedSample()` cycle until playback ends.
- **Fix**: In the chirp-handoff failure branch, count consecutive failures via `samplesAfterChirp`. If more than 16 symbols elapse without a successful handoff, clear `chirpDetected`/`chirpEndSample` so the receiver can fall back to energy-based sync rather than re-probing forever.
- **Verified**: In-memory tests remain at baseline (4 pre-existing failures). No regressions.

### Buffer-flush attempt (reverted)
- **Hypothesis**: The chirp-correlation tail and any pre-chirp room noise were polluting `ofdmAlignBuf`, mixing into the training-symbol window and lowering CP-correlation sharpness below the probe threshold in acoustic environments.
- **Attempt**: Clear `this.ofdmAlignBuf = []` immediately when chirp correlation fires, so only post-chirp training symbols accumulate for the CP handoff probe.
- **Result**: Catastrophic regression — 23 failures across OFDM, QAM, compression, link-profile, throughput, and feedChunk tests. Clearing the buffer removes the post-chirp samples the probe expects before enough new samples have arrived; the receiver never leaves WAITING state in loopback tests.
- **Conclusion**: Do not unconditionally flush `ofdmAlignBuf` at chirp detection. The rolling-window behavior is load-bearing for in-memory loopback timing. Buffer contamination, if it exists, must be addressed without discarding the accumulated window.


**Finding**: The post-handoff buffer starvation (`bufLenRemaining=0` after training, `bufLenAtEntry=0` at data phase entry) is **NOT a code bug** — it is the expected behavior in real-time acoustic processing.

**Analysis**:
- `ofdmAlignBuf` is capped at `4*sps = 4800` samples during WAITING state.
- At chirp handoff, `alignedStart ≈ 2638` leaves `buf.length ≈ 2162` samples (~1.8 symbols).
- Training needs 12 symbols × 1200 sps = 14,400 samples. The remaining ~12,238 samples arrive during training via continuous `feedSample()` calls.
- Each training iteration: `buf.push(1 sample)` then `buf.splice(0, sps)` — net change `-(sps-1)` per iteration.
- Training completes with `bufLenRemaining=0` because the surplus (2162) is consumed early; remaining training iterations run one-sample-at-a-time as new audio arrives.
- After training, data phase starts with `bufLenAtEntry=0`, but new samples arrive immediately at 48 kHz. The first data window is collected within 25ms (one symbol), correctly aligned to the frame boundary.

**Why loopback tests pass but acoustic tests fail**:
- Loopback: `feedChunk()` feeds ALL samples synchronously → buf always has the full audio → no timing gaps.
- Acoustic: Samples arrive in real-time → buf drains to 0 during training → but alignment is preserved because training consumed exactly 12 symbols.

**Why CRC fails on PROFILE frames in acoustic tests**:
- Not a buffer/alignment issue. The demodulated constellation points show wildly varying phases (203°, 302°, etc.) — the acoustic channel introduces phase/amplitude distortion that 64-QAM cannot tolerate at the current SNR.
- The code is correct for clean channels (loopback proves it). The acoustic failure is a **channel capacity** limitation, not a code bug.

**Attempts that broke tests (reverted)**:
1. Increased `ofdmAlignBuf` capacity from `4*sps` to `16*sps` — alignedStart formula pushes further forward in larger buffer, so same ~2162 samples remain. No benefit.
2. Kept ALL `ofdmAlignBuf` instead of slicing (`[...this.ofdmAlignBuf]`) — corrupted training with pre-chirp noise/chirp tail. 24 test regressions.
3. Used `ofdmSkip` to delay first window — `ofdmSkip` returns early BEFORE `buf.push()`, dropping samples. Fixed by moving `buf.push()` before skip check, but this changed the timing/buffering pattern and broke 24 tests.

**Conclusion**: Do NOT attempt to "fix" buffer starvation by restructuring `feedSample()`. The slicing logic is correct. Focus acoustic debugging on channel estimation quality and QAM order selection.

#### Previously completed in prior sessions
- **Tone count adaptation**: RX PROFILE handler dynamically updates tone count and demodulator config when TX announces different grid (e.g., 32-tone vs default 4). FIX confirmed by `[RX-FRAME] valid=true type=0x04 seq=0 len=160` — first successful PROFILE decode.
- **Removed premature reset**: Eliminated `setToneOrders()` call from `resetLinkProfile()` that overrode profile updates.
- **Lowered chirp sharpness threshold**: Changed from 1.5 to 1.1 to accept wider variety of chirp waveforms.
- **OFDM QAM mapping**: Fixed `setToneOrders()` routing in `OFDMQPSKDemodulator.ts` to correctly apply qamMap → toneOrders → allQpsk flag.
- **Diagnostic enhancement**: Deep phase-trace logs showing raw→chPhase→drift→equalized per tone.

### Acoustic test results (live speaker→mic)
**Before Fix 3:**
```
[OFDM-SYNC] chirp=true norm=0.716 peak=2.33e+4 idx=58          ← chirp detected
[OFDM-SYNC] chirpProbeFail=true score=0.614 sharpness=1.35      ← CP probe failed (need >= 1.5)
[OFDM-SYNC] chirpProbeFail=true score=0.609 sharpness=1.25      ← infinite loop on same buffer
[RX-SCAN] bits=8000 sentinel=false sr=0x133527                   ← noise scan, no file
```

**After Fix 3 (threshold lowered to 1.1):**
```
[OFDM-SYNC] chirp=true norm=0.716 peak=2.33e+4 idx=58          ← chirp detected
[OFDM-SYNC] chirpHandoff=true boundary=-16 trainingSamples=4800 score=0.614 ← handoff succeeded ✅
[OFDM-TRAIN] symbols=12 pilotAmp=0.586                           ← training complete
[OFDM-DEMOD] firstSym=t0:1°/0 t1:1°/0 ... pilotAmp=0.6085       ← all zeros (expected)
[RX-FRAME] valid=true type=0x04 seq=0 len=160                   ← PROFILE decoded! ✓
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

#### Buffer starvation — RESOLVED (not a bug)
Post-handoff buffer drain to `bufLenRemaining=0` is **expected behavior** in real-time acoustic processing. The slicing logic is correct; training consumes exactly 12 symbols worth of samples, and data frames arrive continuously at 48 kHz. The alignment is preserved through the training→data transition. See detailed analysis above.

**Acoustic CRC failures are a channel capacity issue, not a buffer management bug.** The code is correct for clean channels (loopback tests prove it). Next step: reduce QAM order (32-QAM or 16-QAM) or tone count for acoustic channels with limited SNR.

### Build & tests
- Build: clean ✅
- Tests: **258 passed / 4 failed** (3 pre-existing: Doppler ±1Hz + Full Stress; 1 qam-propagation test bug — `expect(qamSymbols).toBeLessThan(qpskSymbols)` fails because QAM-64 uses same symbol count due to atomicFrame byte-packing)
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

---

## Review-fixes branch (`review-fixes`)

Applied 2026-07-28 from code review. Goal: fix test/lint failures, small bugs, and low-risk performance cleanups without touching the fragile BPSK/OFDM state machines structurally.

### Done
- **Tests/lint**: Fixed `qam-propagation.test.ts` payload size (320 B) so the QAM-64 vs QPSK symbol-count assertion is valid. Fixed real lint errors in `PresentationMode.tsx` (unused ternary expressions, short identifiers), `testFixtures.ts` (`_` identifiers), `modemController.ts`, `modemSchema.ts`, and `useDecoderState.ts`.
- **Progress bug**: `RxEngine.processHeader()` now sets `framesReceived = 1` after reset so the header frame counts toward UI progress.
- **OFDM tuning**: Moved CP correlation thresholds (`score >= 0.35`, `sharpness >= 1.1`) into `OFDM_TUNING` as `cpCorrelationMinScore` and `cpCorrelationMinSharpness`. Added `checkOfdmTuningInvariants()` to enforce `syncBurstSymbols >= syncMinFrames + 2 + trainingSymbols`.
- **Audio cleanup**: Replaced raw `console.*` calls in `src/audio/recorder.ts` with `dlog()`.
- **Demod hot path**: `OFDMQPSKDemodulator.analyze()` no longer copies `Float32Array` windows via `Array.from()`. `computeQamRefScale()` no longer allocates a throwaway `OFDMQPSKModulator`; it uses a pure static helper. Added a memory-footprint comment to `OFDMQPSKModulator`.
- **Concise debug logs**: `dlog()` now suppresses consecutive duplicate lines per tag and prints a `(+N dup)` summary when the line changes. `MAX_LINE_LEN` reduced from 200 to 120 for denser output.
- **Packet failure diagnosis**: `decodeFrame()` returns `failureReason`, `crcMismatch`, `bchErrorCounts`, and `rsBlockErrors`. `RxEngine` logs a `RX-FAIL` line with the failure reason, ECC error counts, and available signal/MER context.
- **Presentation layer**: `PresentationMode.tsx` now has preset examples (reset, all tones, one tone, alternating, random), an AWGN noise slider with live SNR estimate, step-highlighting, and a decoded-bits table showing sent vs received QPSK bits.

### Not done (intentionally)
- **RxEngine refactor into mode-specific receivers**: Started with a subagent, but a full BPSK/OFDM extraction of `rxEngine.ts` requires acoustic validation per `AGENTS.md` (`src/modem/protocol/rxEngine.ts` is flagged as fragile). The partial extraction was removed rather than left as dead code. This remains the top maintainability follow-up once a real speaker→mic pass can be run against the refactored code.

### Verification
- `npm test`: 259 passed / 3 failed (pre-existing BPSK pipeline failures: Doppler +2Hz, Doppler −1Hz, Full Stress).
- `npx tsc --noEmit`: clean.
- `npm run lint`: 220 problems remaining (15 errors, 205 warnings) — all pre-existing in files not touched by this branch.

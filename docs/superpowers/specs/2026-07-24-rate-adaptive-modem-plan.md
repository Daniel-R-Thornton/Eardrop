# Rate-Adaptive Modem Plan — Higher Throughput for the Eardrop Acoustic OFDM Modem

**Date:** 2026-07-24 · **Branch:** `perf/streaming-encode` · **Status:** planned

## Baseline (where the numbers come from)

Physical layer, grounded in code:

- Symbol clock: `OFDM_SYMBOL_MS = 20` + `OFDM_CP_MS = 5` (`src/modem/types.ts`) → 25 ms/symbol, 40 symbols/s. At 48 kHz: `ofdmSamples()` → 960 FFT + 240 CP = 1200 samples.
- Payload packing: `OFDMEngine.modulateFrame()` (`src/modem/protocol/ofdmEngine.ts`) groups tones into 4-tone blocks, 1 byte/block/symbol → 32 tones = 8 wire bytes/symbol = **320 wire B/s**.
- Frame: `src/modem/protocol/atomicFrame.ts` — `FRAME_SIZE = 235` wire bytes (3 sentinel + 24 BCH(63,30)×3 header + 4×RS(52,40)) carrying `PAYLOAD_DATA_SIZE = 160` data bytes → efficiency 160/235 ≈ 0.68 → **~218 B/s**, ~213 B/s measured after preamble (24 chirp + 12 training symbols = 900 ms fixed).
- 6 MB file ≈ 8.2 h of audio at baseline.

Measured link reality (live acoustic tests):

- In-frame MER: 9–12 dB quiet/far (QPSK only); 21–22 dB loud/well-leveled (16-QAM viable, brushing 64-QAM). Headroom exists but is *level-managed*, not free.
- Per-tone channel gain spread ~12 dB across the 32 tones (`OFDM-TRAIN` log, 3.6e-2 → 1.4e-1) → uniform constellation wastes the good tones and over-drives the bad ones. Bit-loading is the right shape.
- Reverb: CP is currently 5 ms; trimming is only safe where measured echo decay allows.

**Hard blocker for any amplitude modulation:** `OFDMQPSKModulator.generateSymbol()` (src/modem/modulation/OFDMQPSKModulator.ts:101–105) peak-normalizes *each symbol independently* — per-symbol scale varies with data, so amplitude is not a stable axis. Must be fixed before 16/64-QAM.

**Metric honesty problem:** MER accumulates on every demodulated window while `RxState.FRAMES` persists (the watchdog holds FRAMES up to ~15 s, `rxEngine.ts` `OFDM_WATCHDOG_WINDOWS`), so silence between sends drags the rolling MER to a ~7 dB "marginal" — the number that will drive rate adaptation is currently a lie between transmissions.

## Phase order and dependency graph

```
P1 MER gating ──────────┐
                        ├─→ P2 adaptive ECC ──┐
P4 link-profile frame ──┤                     ├─→ (full adaptive modem)
                        ├─→ P3 bit-loading ───┘
TX normalize fix (P3a) ─┘
P5 CP/preamble trim  (needs P4 to carry cpId; gated by measured reverb)
P6 compression       (orthogonal — parallel track, needs only a header byte)
P7 BICM/LDPC         (stretch, after P3)
```

Ordered by value/risk: P1 (tiny, foundational) → P6 (parallel, zero SNR cost) → P2 (cheap big win) → P4 (keystone protocol work) → P3 (the star, biggest change) → P5 (small gain, reverb-gated) → P7 (future).

---

## Phase 1 — Gate MER to sync'd, valid-frame windows (+ per-tone MER)

**Goal:** make `getMER()` trustworthy so it can drive rate decisions; add per-tone MER (needed by P3 bit-loading). No throughput change (×1.0 — enabler).

**Changes**

- `src/modem/demodulation/OFDMQPSKDemodulator.ts`
  - Split the accumulators (`merErrPow/merRefPow/merCount`, lines 53–55) into *staged* (current window run) and *committed* sets. `demodulate()` accumulates into staged only.
  - New methods: `commitMER()` (fold staged → committed) and `discardMER()`; `getMER()` reads committed only. Keep the `OFDM-MER` dlog on the committed report path.
  - Add per-tone accumulators (`Float64Array(toneCount)` err/ref) and `getPerToneMER(): number[]` — same code path, near-zero cost; also expose trained per-tone channel magnitude (already in `channelEstRe/Im`).
- `src/modem/protocol/rxEngine.ts`
  - In `processFrame()` (line 981): after `decodeFrame(frame)`, call `ofdmDemod.commitMER()` when `decoded.valid`, `discardMER()` when not. Also `discardMER()` on watchdog reset (line 637) and on state transitions back to WAITING. Symbols demodulated during inter-send silence never straddle a valid frame, so they never commit.
- Surface the honest MER + per-tone table through the existing telemetry path (`getProgress()` in rxEngine / `src/workers/modemService.ts` snapshot) so the UI verdict line stops flapping between sends.

**Wire format:** none.

**Tests (vitest):** extend `src/modem/test/ofdm_mer.test.ts` — (a) feed valid frames → MER reported; (b) feed noise/silence after a valid transfer → committed MER unchanged; (c) per-tone MER differentiates a tone with injected narrowband noise (reuse the seeded-LCG noise helper already in that file). End-to-end sanity via `ofdm_endtoend.test.ts` harness.

**Rollback:** commit/discard is additive; reverting restores the old always-accumulate behavior. No protocol impact.

---

## Phase 2 — Adaptive ECC (code-rate selection)

**Goal:** drop redundancy on clean links. RS(52,40) t=6 is sized for the worst case; at 20+ dB MER post-Phase-1, t=2 suffices. **~×1.15–1.25** (RS(52,48): 192 data bytes per 235-byte frame vs 160 → ×1.20).

**Changes**

- `src/modem/ecc/reedsolomon.ts`: `rsGeneratorPoly(t)` already exists (line 76) but `GEN_POLY = rsGeneratorPoly(6)` is a module constant (line 92). Parameterize `rsEncode`/`rsDecode` with `t` (cache generator polys per t; keep default 6).
- `src/modem/protocol/atomicFrame.ts`: turn `RS_BLOCK_DATA`/parity split into a per-transmission parameter (an `EccProfile` = t ∈ {6, 4, 2}) threaded through `encodeFrame`/`decodeFrame`. Keep `PAYLOAD_BLOCKS = 4` and wire `RS_BLOCK_SIZE = 52` fixed so `FRAME_SIZE` and symbol count per frame never change — only the data/parity split moves. This keeps `SentinelScanner` (fixed `FRAME_SIZE` collection) and all timing untouched.
- `src/modem/protocol/txEngine.ts` / `rxEngine.ts`: accept the ECC profile in config; RX learns it from the link-profile frame (Phase 4) — until P4 lands, ship as a manual TX+RX preset in `src/ui/controllers/buildModemConfig.ts` (the single UI→config funnel).
- Header BCH(63,30)×3 stays untouched — the header must always decode at the most robust rate.
- **Sensing honesty:** the audio link is one-way; TX cannot see RX's MER. First delivery: RX displays the Phase-1 verdict, operator picks the preset on the sending device (acoustic transfers are same-room). Automated reverse-channel report (short squawk from RX using the existing `src/modem/protocol/squawk.ts` machinery) is a follow-up, not a prerequisite.

**Wire format:** none on the frame itself (fixed 235B); the *interpretation* (data/parity split) is carried by the P4 profile or preset. Until P4: TX/RX must agree by config.

**Tests:** `src/modem/test/ecc.test.ts` — parameterized encode/decode roundtrips per t, correction capability at each t (inject t and t+1 symbol errors). `atomicFrameV2.test.ts` for frame-level. `throughput.test.ts` `[BENCH]` lines rerun per preset (the file header says: run after every throughput change). Full-pipeline: `ofdm_loopback.test.ts` + `production.test.ts` with noise at each preset.

**Rollback:** default t=6 profile is bit-identical to today; adaptive presets are opt-in config.

---

## Phase 3 — Per-tone bit-loading (QPSK / 16-QAM / 64-QAM per tone) — the star

**Goal:** assign each tone a constellation matched to its measured SNR. Average 3–4 bits/tone on a good link vs 2 today. **~×1.5–2.0 on well-leveled links; ×1.0 (all-QPSK) on poor ones.** Depends on P3a (TX normalize) and P4 (profile carriage).

### 3a — Fix TX amplitude stability (prerequisite, independently shippable)

- `src/modem/modulation/OFDMQPSKModulator.ts` `generateSymbol()`: replace the per-symbol peak-normalize (lines 101–105) with a **fixed global scale** computed once in the constructor from the worst-case sum (`numTones × maxConstellationAmp + pilotAmplitude`), target ~0.95 peak worst case (or a measured-PAPR back-off constant). Every symbol then has identical per-tone amplitude.
- Ripple: `TxEngine.frameSegments()`/`streamChunks()` comments (txEngine.ts:148–150, 213–214) rely on "each symbol peak-normed to 0.95" for the streaming path — fixed scale still bounds |sample| ≤ 0.95 so `AudioPlayer.playStream` (`src/audio/player.ts`) is safe, but average loudness drops (fixed scale ≪ per-symbol peak norm). Verify live level management; consider a mild clip-safe gain.
- Ship alone: QPSK is phase-only so decode is unaffected; live MER should *improve* slightly (stable amplitude helps the decision-directed tracker in the demodulator).

### 3b — Generalize modulator/demodulator beyond fixed QPSK

- `OFDMQPSKModulator`: `setSymbols(number[])` becomes per-tone complex points `(re, im)` from a per-tone constellation table (QPSK/16/64-QAM, Gray-mapped, normalized to equal mean power). The precomputed sin/cos tables still work — synthesis becomes `re·cos + im·(−sin)` per tone: two table reads + two multiplies instead of the current sign-select. Keep a fast path when everything is QPSK.
- `OFDMQPSKDemodulator.demodulate()`: replace the hard 4-phase slicer (line 234) with a per-tone slicer keyed by that tone's QAM order. 16/64-QAM need amplitude reference — use the trained per-tone channel magnitude (`channelEstRe/Im`) for full complex equalization (today only phase is corrected, line 197–205). Extend the decision-directed tracker and MER math to nearest-constellation-point (drop the unit-magnitude normalization at lines 242–249 once TX amplitude is stable).
- Bit transport: the 4-tone/nibble-lane byte packing assumes 2 bits/tone everywhere — `OFDMEngine.modulateFrame()` (ofdmEngine.ts:106–129) on TX and the `blockCount` loop in `rxEngine.feedSample()` (rxEngine.ts:663–679) on RX. Replace both with a generic bit-serializer: TX drains frame bytes MSB-first into per-tone bit allocations per symbol; RX accumulates demodulated bits into a bit buffer and emits bytes to `SentinelScanner.feedByte()` as they fill. Frame boundaries stay byte-aligned by padding the last symbol of each frame (echoes today's zero-padding in `modulateFrame`).
- Bit-loading policy: pure function `chooseBitLoading(perToneMerDb: number[]): qamOrder[]` with conservative thresholds from the measured data (≥22 dB → 64-QAM, ≥16 dB → 16-QAM, ≥9 dB → QPSK, else tone off/QPSK) minus a 2–3 dB safety margin. Lives next to types; unit-testable in isolation.

**Wire format:** the per-tone QAM map is carried by the Phase 4 profile. Training burst and header path remain QPSK-at-heaviest-ECC always.

**Tests:** new `ofdm_qam_loopback.test.ts` (mod→demod roundtrip per QAM order per tone, with seeded noise sweeps to verify slicer thresholds); extend `ofdm_endtoend.test.ts` and `ofdm_acoustic_path.test.ts` with mixed-order tone maps; `throughput.test.ts` bench at all-QPSK vs mixed vs all-16QAM; `streamChunks.test.ts` for the streaming path with the new fixed scale; `chooseBitLoading` unit tests. Then live acoustic A/B (the only true test of the QAM thresholds).

**Rollback:** all-QPSK map + old ECC = today's waveform exactly (fixed scale being the only diff, shipped and validated in 3a). Adaptive maps are profile-gated.

---

## Phase 4 — Link-profile frame (the keystone)

**Goal:** a wire artifact that tells RX how the rest of the transmission is encoded: per-tone QAM orders, ECC rate, CP length. Everything adaptive hangs off this. Slight negative throughput (~1 extra frame, negligible).

**Design**

- New frame type `0x04` (PROFILE), sent **after training, before HEADER**, always at the lowest rate: all-tone QPSK + heaviest ECC (RS t=6) + full 5 ms CP — i.e., exactly today's modulation, so it decodes before any profile is known. It reuses the standard 235-byte atomic frame (sentinel + BCH header + RS payload), so `SentinelScanner` and `processFrame()` need no timing changes.
- Profile payload (inside the 160-byte base-rate payload; version-tagged):

  ```
  [ver:1][flags:1][eccT:1][cpId:1][toneCount:1]
  [qamMap: ceil(toneCount·2/8) bytes]   // 2 bits/tone: 0=QPSK 1=16QAM 2=64QAM 3=reserved → 8B for 32 tones
  [crc32:4]                             // over all preceding profile bytes
  [zero pad → 160]
  ```
- Repeat the PROFILE frame ×2 (it's ~30 symbols; cheap insurance — a lost profile kills the whole transmission).
- TX: `TxEngine.frameSegments()` yields it between the training segment and the header frame; profile content comes from config (P2/P3 policy). RX: `rxEngine.processFrame()` gains `case 0x04:` → validate crc32 + ver → reconfigure demod slicer map, ECC t, and (P5) CP for subsequent frames; reset to base profile on every new sync detection and on watchdog reset.
- **Backward compat:** legacy RX's `switch (decoded.header!.type)` silently drops unknown types — a legacy receiver ignores the profile frame and still decodes any transmission whose profile is {all-QPSK, t=6, 5 ms CP}. TX default remains exactly that; adaptive profiles are opt-in (`buildModemConfig.ts` + worker `modemSchema.ts` config plumbing). A new RX decodes legacy TX (no profile frame ⇒ stay on base profile).

**Tests:** `atomicFrameV2.test.ts`-style profile pack/unpack roundtrip; `ofdm_endtoend.test.ts` full pipeline: profile announcing 16-QAM tones → payload decodes; corrupted-profile-frame → RX stays at base profile and (with all-QPSK payload) still succeeds; legacy-RX simulation (RX without 0x04 handling) against base-profile TX.

**Rollback:** feature-flagged; TX omits the frame → byte-identical legacy stream.

---

## Phase 5 — CP trim + preamble/framing overhead reduction (reverb-gated)

**Goal:** shave fixed overheads. CP 5 → 2.5 ms cuts symbol time 25 → 22.5 ms (**×1.11**); trimming `OFDM_TUNING.syncBurstSymbols`/`trainingSymbols` (24+12 = 900 ms) and tail silence helps short transfers (~×1.02–1.05 amortized on large files). **Combined ~×1.1–1.15.**

**Changes**

- `src/modem/types.ts`: make CP a parameter — `ofdmSamples(sampleRate, cpMs = OFDM_CP_MS)`; the profile's `cpId` selects {5 ms, 2.5 ms}. Thread through `OFDMQPSKModulator`, `OFDMQPSKDemodulator`, `OFDMEngine`, and rxEngine's `sps`/`findOfdmBlockStart()` (CP correlation length = `sps − fft` is already derived, rxEngine.ts:866).
- Gate: preamble + training + profile frame always use 5 ms CP (sync detection and `findOfdmBlockStart` depend on it); only post-profile data symbols shrink. RX switches window size at the profile boundary — this is the trickiest cutover in the plan; test symbol-boundary bookkeeping hard.
- Reverb measurement to *decide* the gate: reuse CP-correlation sharpness (`findOfdmBlockStart` already computes it) and/or trailing-echo energy after the sync burst; expose next to MER in telemetry. Only offer short-CP when echo at 2.5 ms is below threshold.
- Preamble: reduce `syncBurstSymbols` 24 → 16 and `trainingSymbols` 12 → 8 behind the same measurements (the `OFDM_TUNING` invariant `syncBurstSymbols ≥ syncMinFrames + 2 + trainingSymbols` in types.ts:186 must keep holding). Sentinel/BCH header overhead (27B/235B) is *not* worth attacking yet — it's ~11% and load-bearing for resync.

**Tests:** `ofdm_sync.test.ts`, `rxEngine_chunk.test.ts`, `ofdm_channel_drift.test.ts` parameterized over cpId; a synthetic-echo test in `ofdm_acoustic_path.test.ts` (convolve with decaying impulse response, assert 2.5 ms CP fails where 5 ms passes — proving the gate matters); `throughput.test.ts` bench.

**Rollback:** cpId=5ms in the profile ⇒ identical to today; short CP is per-transmission and self-describing.

---

## Phase 6 — Compression codec (parallel track, no SNR cost)

**Goal:** fewer bytes on the wire. Static per-file-type dictionary + optional Huffman entropy stage + raw fallback. **×1.0 on already-compressed data (guaranteed no regression via raw fallback); ×1.5–4 on text/JSON/source.** Effective throughput, not physical.

**Changes**

- New module `src/modem/compression/` (detector via magic bytes; scheme registry: `0=raw, 1=dict+huffman, 2=huffman-only`, room to grow). Compress at the service layer *before* framing — `src/workers/modemService.ts` `encodeStreamStart` (line 91) compresses the ArrayBuffer before `tx.streamChunks(...)`; decompression in the RX completion path where `RxEngine.getFile()` is consumed. Keep TxEngine/RxEngine byte-agnostic.
- Header carriage: `TxEngine.buildHeaderPayload()` currently packs `[fileID:4][totalSize:4][nameLen:1][name…][zeros]` into the 160-byte header payload; `rxEngine.processHeader()` parses the same offsets and ignores the zero-pad region. Append `[schemeId:1][origSize:4]` immediately after the name — legacy RX ignores them (safe); new RX reads them, treats absent/0 as raw. `totalSize` remains the *wire* (compressed) size so legacy progress math keeps working; `origSize` restores the true size after decompression.
- Always compare compressed vs raw size and fall back to raw — never ship a regression.

**Tests:** new `compression.test.ts` (roundtrip per scheme, magic-byte detection, incompressible-input fallback); `modemService.test.ts` end-to-end with a compressible payload asserting fewer frames on the wire and byte-exact recovery; legacy-RX compat test (schemeId=0 stream decodes on an RX without the feature).

**Rollback:** schemeId=0 is the wire format of today; the whole stage is a pre/post filter.

---

## Phase 7 (stretch) — Coded modulation: BICM + LDPC, probabilistic shaping

Note only. Replacing RS+hard-decision with bit-interleaved coded modulation over an LDPC code (soft LLRs from the QAM slicer — `reedsolomon.ts` already sketches soft-decision syndrome weighting as prior art in this repo) is worth ~1–2 dB, i.e. one constellation step on marginal tones (**~×1.2–1.3 on top of P3**). Probabilistic shaping is beyond that. Biggest effort, touches every layer P2–P4 touched; only after bit-loading has soaked in the field.

---

## Combined outlook (honest)

| Phase | Multiplier | Cumulative (good link) |
|---|---|---|
| Baseline | — | ~213 B/s |
| P1 MER gating | ×1.0 (enabler) | 213 B/s |
| P2 adaptive ECC | ×1.2 | ~256 B/s |
| P3 bit-loading | ×1.5–2.0 | ~380–510 B/s |
| P5 CP/preamble | ×1.1–1.15 | **~420–590 B/s physical** |
| P6 compression | ×1–4 (content-dependent) | ~0.4–2 KB/s effective |
| P7 BICM/LDPC | ×1.2–1.3 (future) | — |

Realistic physical ceiling **~2–2.75× (≈450–550 B/s)** on a loud, well-leveled, low-reverb link; a 6 MB file drops from ~8 h to ~3–3.5 h, and to ~1–2 h if the content compresses. On quiet/far links the adaptive machinery correctly degrades to today's rate — that's the point: this is an SNR-gated, per-tone-varying, reverb-limited acoustic channel, and every gain above is conditional on the measured link, never assumed.

## Test strategy summary

Every phase keeps `npx vitest run src/modem/test` green: `ofdm_loopback` / `loopback` (mod↔demod), `ofdm_endtoend` (frame pipeline), `ofdm_mer` (metric), `throughput` (`[BENCH]` record — rerun after every throughput change per its header), `streamChunks` + `modemService` (streaming path), `ecc`/`bch63`/`atomicFrameV2` (codes and framing), `ofdm_acoustic_path`/`ofdm_channel_drift`/`ofdm_sync` (channel robustness). Each phase adds live acoustic A/B on the real speaker/mic pair before its flag defaults on.

# OFDM Throughput Maximization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise OFDM file-transfer payload throughput from ~89 B/s to ~213 B/s (2.4×) at 32 tones by fixing the buried pilot tone, slimming the frame format, and halving the OFDM symbol duration — without weakening sync robustness or hum immunity.

**Architecture:** The eardrop acoustic modem's OFDM stack transmits 79-byte atomic frames (3B sentinel + 24B BCH-encoded header + 52B RS(52,40) payload block) as QPSK symbols on a fixed 45 ms symbol grid (40 ms window + 5 ms cyclic prefix, defined in time so any hardware sample rate works). This plan (1) adds a throughput benchmark to lock a baseline, (2) fixes the TX pilot amplitude bug that makes 32-tone reception unreliable, (3) centralizes all tuning constants into one "levers" object, (4) packs 4 RS blocks per frame to amortize sentinel+header overhead, (5) shortens the symbol to 20 ms + 5 ms CP, and (6) makes the UI report truthful net bitrate. Every step is gated by the existing vitest suite plus the new benchmark.

**Tech Stack:** TypeScript, vitest (`npx vitest run`), Vite dev server, Web Audio (browser side — not touched except UI display).

## Global Constraints

- All work is in the **OFDM/atomic-frame stack only**. NEVER modify the legacy BPSK stack: `src/modem/protocol/encoder.ts`, `decoder.ts`, `blockProcessor.ts`, `framing.ts`, `preamble.ts`, `squawk.ts`, `src/modem/modulation/BPSKModulator.ts`. They are a separate pipeline used by the self-test/combo tools.
- Every tone frequency and the pilot frequency MUST remain an exact integer multiple of `1000 / OFDM_SYMBOL_MS` Hz (the orthogonality grid). Current plan keeps pilot 1900 Hz and tones 2000 + n·50 Hz, which are multiples of both 25 Hz (40 ms window) and 50 Hz (20 ms window) — do not introduce any frequency that is not a multiple of 50.
- `toneCount` MUST be a multiple of 4. Both `OFDMEngine` (`src/modem/protocol/ofdmEngine.ts:21`) and `RxEngine.initOfdmDemod` (`src/modem/protocol/rxEngine.ts:696`) silently clamp non-multiples to 4, which is an 8× slowdown at 32 tones. Never pass 12, 20, etc.
- Do NOT change `OFDM_CP_MS` (5 ms) in this plan. The cyclic prefix absorbs room echo and timing misalignment; shrinking it is a separate, riskier experiment (see Appendix).
- Do NOT "fix" the forced-1 interleaved bits in `rxEngine.ts` (lines ~563-566 push, ~668-684 consume) or `OFDMQPSKDemodulator.ts` `frameBits`. This looks like wasted padding but it is an **internal in-memory representation only** — the wire format carries a full byte per 4-tone block per symbol with zero waste. Changing it breaks the scanner handoff and gains nothing.
- The UI `symbolsPerSec` setting is **BPSK-only**. It has no effect on OFDM timing (OFDM symbol length comes from `OFDM_SYMBOL_MS`/`OFDM_CP_MS`). Never wire it into OFDM math.
- After every task: `npx tsc --noEmit` clean and `npx vitest run` green before committing.
- If the hum-immunity or sync tests (`src/modem/test/ofdm_sync.test.ts`) fail after a timing change, STOP and report — do not blindly loosen the detection thresholds at `rxEngine.ts:266` (`score < 0.35 || sharpness < 1.5`); those reject false sync triggers on mains hum.

## Background: where the time actually goes (verified against code)

At 48 kHz, 32 tones, today:

| Item | Value | Source |
|---|---|---|
| Symbol duration | 40 + 5 = 45 ms → 22.22 sym/s | `types.ts:161-162` |
| Bytes per symbol | toneCount/4 = 8 (QPSK 2 bits/tone, 4-tone blocks carry 1 byte) | `ofdmEngine.ts:64-81` |
| Wire rate | 8 × 22.22 = 177.8 B/s | derived |
| Frame | 79 B = 3 sentinel + 24 BCH header + 52 RS → carries 40 payload B | `atomicFrame.ts:30-40` |
| Frame airtime | ceil(79/8) = 10 symbols = 450 ms per 40 payload B | `ofdmEngine.ts:67` |
| **Steady-state payload rate** | **88.9 B/s (711 bit/s)** | derived |
| Per-transmission overhead | sync burst 24 sym (1.08 s) + header frame + tail frame + 6 sym silence | `txEngine.ts:120,182` |

The 79-byte frame is only 50.6% payload. The BCH header alone (9 bytes → 24 bytes via 3×BCH(63,30)) plus sentinel is 27 B of overhead per 40 B of data.

Known live-path bug (observed 2026-07-11, root-caused): `TxEngine` passes the BPSK pilot amplitude (`DEFAULT_CONFIG.pilotAmplitude = 0.4`) into `OFDMEngine`, so the OFDM default of 2.0 (`ofdmEngine.ts:27` `?? 2.0`) never applies. After peak normalization the pilot is ~1% of the composite at 32 tones; the receiver's pilot-referenced drift correction (`OFDMQPSKDemodulator.ts:152-158`) then corrects phases using noise, and every tone decodes garbage. Task 2 fixes this — it is a correctness prerequisite for everything after.

Expected after this plan (32 tones): frame = 235 B carrying 160 payload B (68%), symbol = 25 ms (40 sym/s), steady-state ≈ **213 B/s (1.7 kbit/s)** — a 52-90 s transfer becomes ~22-37 s, and the Appendix experiments can go beyond.

---

### Task 1: Throughput benchmark (baseline lock)

**Files:**
- Create: `src/modem/test/throughput.test.ts`

**Interfaces:**
- Consumes: `TxEngine.transmitFile(fileName, data): Float32Array` (`src/modem/protocol/txEngine.ts:112`), `RxEngine.feedSample(sample)`. The file-complete result lives in the private `completedFile` field; use the same cast-to-internals pattern as `src/modem/test/ofdm_acoustic_path.test.ts:42`.
- Produces: tests named `OFDM throughput benchmark — <n> tones, 2000-byte file` that later tasks re-run to measure gains. They log `[BENCH] tones=<n> payloadBytes=<n> audioSec=<n> rate=<B/s>` lines.

- [ ] **Step 1: Write the benchmark test**

Create `src/modem/test/throughput.test.ts` with exactly:

```ts
/**
 * OFDM end-to-end throughput benchmark.
 *
 * Full pipeline: TxEngine.transmitFile → RxEngine.feedSample, byte-exact
 * verification, payload-rate computed from generated audio duration.
 * Run after every throughput change; the [BENCH] log lines are the record.
 */
import { expect, test } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;

function makePayload(n: number): Uint8Array {
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = (i * 131 + 7) & 0xff;
  return data;
}

function runTransfer(toneCount: number, payloadBytes: number): {
  received: ReceivedFile | null;
  audioSec: number;
} {
  const data = makePayload(payloadBytes);
  const tx = new TxEngine({
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount,
    useOFDM: true,
  } as ConstructorParameters<typeof TxEngine>[0]);
  const audio = tx.transmitFile('bench.bin', data);

  const rx = new RxEngine({
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount,
    useOFDM: true,
  } as ConstructorParameters<typeof RxEngine>[0]);

  for (const s of audio) rx.feedSample(s);
  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  for (let i = 0; i < symSamples * 8; i++) rx.feedSample(0);

  const received = (rx as unknown as { completedFile: ReceivedFile | null }).completedFile;
  return { received, audioSec: audio.length / SAMPLE_RATE };
}

for (const toneCount of [16, 32]) {
  test(`OFDM throughput benchmark — ${toneCount} tones, 2000-byte file`, () => {
    const payloadBytes = 2000;
    const { received, audioSec } = runTransfer(toneCount, payloadBytes);

    expect(received, 'file should complete').not.toBeNull();
    expect(received!.data.length).toBe(payloadBytes);
    expect(Array.from(received!.data)).toEqual(Array.from(makePayload(payloadBytes)));

    const rate = payloadBytes / audioSec;
    // eslint-disable-next-line no-console
    console.log(
      `[BENCH] tones=${toneCount} payloadBytes=${payloadBytes} audioSec=${audioSec.toFixed(2)} rate=${rate.toFixed(1)} B/s`,
    );
    // Floor guards against silent regression; raise it as levers land.
    expect(rate).toBeGreaterThan(toneCount === 32 ? 60 : 30);
  });
}
```

Note: `ReceivedFile` is exported from `src/modem/protocol/rxEngine.ts:43`. If the import errors, check the export name there.

- [ ] **Step 2: Run the new test**

Run: `npx vitest run src/modem/test/throughput.test.ts`
Expected: PASS (2 tests), with `[BENCH]` lines printed. Record both rates — at 32 tones expect roughly 70-85 B/s including the sync/header/tail overhead on a 2000-byte file (steady-state is 88.9 B/s; overhead drags the whole-file number down). If it FAILS because the file never completes, debug before proceeding — the benchmark must be trustworthy before anything else changes. (A plausible failure cause is the pilot-amplitude bug fixed in Task 2: in the clean loopback there is no noise, so the weak pilot usually still decodes — but if this test is flaky at 32 tones, do Task 2 first and come back.)

- [ ] **Step 3: Run the full suite to confirm nothing else moved**

Run: `npx vitest run`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modem/test/throughput.test.ts
git commit -m "test(modem): end-to-end OFDM throughput benchmark"
```

---

### Task 2: Fix OFDM pilot amplitude (correctness prerequisite)

`TxEngine` always passes `this.cfg.pilotAmplitude` (= `DEFAULT_CONFIG.pilotAmplitude` = 0.4, a BPSK-scaled value) into `OFDMEngine` (`txEngine.ts:77`), so `ofdmEngine.ts:27`'s `?? 2.0` fallback never fires. `OFDMQPSKModulator.generateSymbol` peak-normalizes the composite of pilot + N unit tones, so at 32 tones the pilot lands at ~1% amplitude — at real-room noise levels the receiver's pilot-referenced drift correction runs on noise and every tone demodulates garbage (observed live: `OFDM-TRAIN pilotAmp=6.15e-3`, all frames `valid=false`).

**Files:**
- Modify: `src/modem/protocol/txEngine.ts:77`
- Create: `src/modem/test/ofdm_pilot_level.test.ts`

**Interfaces:**
- Consumes: `OFDM_DEFAULTS.pilotAmplitude` (= 2.0, `src/modem/types.ts:177`), `toneIQ(samples, freqHz, sampleRate)` from `src/modem/pilot.ts`.
- Produces: OFDM transmissions whose pilot measures ≥ 1.5× the mean data-tone amplitude at any tone count.

- [ ] **Step 1: Write the failing test**

Create `src/modem/test/ofdm_pilot_level.test.ts`:

```ts
/**
 * The pilot must stay well above the per-tone level after peak
 * normalization, at every tone count — the receiver's drift correction is
 * pilot-referenced and dies quietly when the pilot is buried.
 */
import { expect, test } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { toneIQ } from '../pilot';
import { ofdmSamples, ofdmToneFrequencies } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;

for (const toneCount of [8, 16, 32]) {
  test(`OFDM pilot ≥ 1.5× mean tone amplitude at ${toneCount} tones`, () => {
    const tx = new TxEngine({
      sampleRate: SAMPLE_RATE,
      pilotFreqHz: PILOT_FREQ,
      toneCount,
      useOFDM: true,
    } as ConstructorParameters<typeof TxEngine>[0]);

    // Sync burst = all tones at 0° — analyze one full FFT window past the CP
    const burst = (tx as unknown as {
      ofdmEngine: { generateSyncBurst(n: number): Float32Array };
    }).ofdmEngine.generateSyncBurst(2);
    const { fftSamples, cpSamples } = ofdmSamples(SAMPLE_RATE);
    const win = Array.from(burst.slice(cpSamples, cpSamples + fftSamples));

    const pilot = toneIQ(win, PILOT_FREQ, SAMPLE_RATE);
    const pilotAmp = Math.hypot(pilot.i, pilot.q);

    const freqs = ofdmToneFrequencies({ toneCount });
    let toneSum = 0;
    for (const f of freqs) {
      const iq = toneIQ(win, f, SAMPLE_RATE);
      toneSum += Math.hypot(iq.i, iq.q);
    }
    const meanTone = toneSum / toneCount;

    expect(pilotAmp).toBeGreaterThan(1.5 * meanTone);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modem/test/ofdm_pilot_level.test.ts`
Expected: FAIL — with pilotAmplitude 0.4 the pilot measures ~0.4× the mean tone, not ≥1.5×.

- [ ] **Step 3: Fix TxEngine**

In `src/modem/protocol/txEngine.ts`, add `OFDM_DEFAULTS` to the line-16 import from `'../types'`, then change line 77 in the OFDMEngine construction from:

```ts
        pilotAmplitude: this.cfg.pilotAmplitude,
```
to:
```ts
        // BPSK's pilotAmplitude (0.4) is scaled for 4 tones; OFDM peak-
        // normalizes pilot + N unit tones together, so the pilot needs the
        // OFDM-scaled value or it vanishes at high tone counts.
        pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
```

- [ ] **Step 4: Run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all PASS including the new pilot-level test. Re-run the benchmark and note whether rates moved (they may tick down ~2% — the pilot now takes a slightly larger share of the normalized power budget; that is the correct trade).

- [ ] **Step 5: Live check**

`npm run dev`, OFDM 32 tones: Send Single Frame → console must show `OFDM-TRAIN` with `pilotAmp` within ~2× of the tone amplitudes (previously 6e-3 vs 1.5e-1) and `RX-FRAME valid=true`.

- [ ] **Step 6: Commit**

```bash
git add src/modem/protocol/txEngine.ts src/modem/test/ofdm_pilot_level.test.ts
git commit -m "fix(modem): use OFDM-scaled pilot amplitude in TX (0.4 BPSK value buried pilot at 32 tones)"
```

---

### Task 3: Centralize tuning levers into OFDM_TUNING

Right now the same numbers are duplicated across files (training symbol count exists in TWO places that must always agree). Centralize so later tasks and future experiments turn one knob.

**Files:**
- Modify: `src/modem/types.ts` (add export after `OFDM_DEFAULTS`, ~line 181)
- Modify: `src/modem/protocol/txEngine.ts:118-120` (sync burst 24), `:182` (tail silence 6)
- Modify: `src/modem/protocol/rxEngine.ts:71` (`ofdmSyncMinFrames = 8`), `:76` (`OFDM_TRAINING_SYMBOLS = 12`)
- Modify: `src/modem/demodulation/OFDMQPSKDemodulator.ts:41` (`TRAINING_SYMBOLS = 12`)
- Modify: `src/ui/app.ts:970` (`generateSyncBurst(24)` in `sendSingleFrame`)
- Create: `src/modem/test/tuning.test.ts`

**Interfaces:**
- Produces: `export const OFDM_TUNING = { syncBurstSymbols: 24, trainingSymbols: 12, syncMinFrames: 8, tailSilenceSymbols: 6 }` in `src/modem/types.ts`. Later tasks import `OFDM_TUNING` from `../types` (modem code) or `../modem/types` (UI code).

- [ ] **Step 1: Write the failing test**

Create `src/modem/test/tuning.test.ts`:

```ts
/**
 * OFDM_TUNING invariants — the levers file must keep the sync burst long
 * enough to contain detection + alignment slack + training.
 */
import { expect, test } from 'vitest';
import { OFDM_TUNING } from '../types';

test('sync burst covers detection + alignment slack + training', () => {
  const floor = OFDM_TUNING.syncMinFrames + 2 + OFDM_TUNING.trainingSymbols;
  expect(OFDM_TUNING.syncBurstSymbols).toBeGreaterThanOrEqual(floor);
});

test('current default values', () => {
  expect(OFDM_TUNING).toEqual({
    syncBurstSymbols: 24,
    trainingSymbols: 12,
    syncMinFrames: 8,
    tailSilenceSymbols: 6,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modem/test/tuning.test.ts`
Expected: FAIL — `OFDM_TUNING` is not exported.

- [ ] **Step 3: Add OFDM_TUNING to types.ts**

In `src/modem/types.ts`, directly after the `OFDM_DEFAULTS` block (ends ~line 181), add:

```ts
/**
 * OFDM tuning levers — every knob that trades robustness for speed, in one
 * place. Invariant: syncBurstSymbols >= syncMinFrames + 2 + trainingSymbols
 * (detection consumes syncMinFrames windows, boundary alignment can skip up
 * to ~1 symbol, and training needs trainingSymbols full sync symbols).
 */
export const OFDM_TUNING = {
  /** TX: repeated all-zero-phase symbols prepended to every transmission */
  syncBurstSymbols: 24,
  /** RX: sync symbols consumed to train per-tone channel estimates */
  trainingSymbols: 12,
  /** RX: consecutive above-threshold windows required to declare sync */
  syncMinFrames: 8,
  /** TX: trailing silence symbols after the tail frame */
  tailSilenceSymbols: 6,
};
```

- [ ] **Step 4: Point all five call sites at OFDM_TUNING**

1. `src/modem/protocol/txEngine.ts` — `OFDM_TUNING` is importable from the existing `../types` import (line 16). Replace lines 119-120:
```ts
      dlog('TX-OFDM', { syncBurst: OFDM_TUNING.syncBurstSymbols });
      preamble = this.ofdmEngine.generateSyncBurst(OFDM_TUNING.syncBurstSymbols);
```
Replace line 182:
```ts
    frameAudios.push(new Float32Array(this.getSymbolLengthInSamples() * OFDM_TUNING.tailSilenceSymbols));
```

2. `src/modem/protocol/rxEngine.ts` — add `OFDM_TUNING` to the `../types` import (line 22). Replace line 71:
```ts
  private ofdmSyncMinFrames = OFDM_TUNING.syncMinFrames;
```
Replace line 76:
```ts
  private readonly OFDM_TRAINING_SYMBOLS = OFDM_TUNING.trainingSymbols;
```

3. `src/modem/demodulation/OFDMQPSKDemodulator.ts` — extend the line-13 import: `import { ofdmSamples, OFDM_TUNING } from '../types';`. Replace line 41:
```ts
  private readonly TRAINING_SYMBOLS = OFDM_TUNING.trainingSymbols;
```

4. `src/ui/app.ts:970` — in `sendSingleFrame`, replace `generateSyncBurst(24)` with `generateSyncBurst(OFDM_TUNING.syncBurstSymbols)` and add `OFDM_TUNING` to the existing `../modem/types` import near the top of the file (search for the import that brings in `DEFAULT_CONFIG`).

- [ ] **Step 5: Run tests and typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all PASS, including new `tuning.test.ts`. (Test files keep their own local `SYNC_COUNT = 24` constants — that is fine, they pin behavior deliberately.)

- [ ] **Step 6: Commit**

```bash
git add src/modem/types.ts src/modem/protocol/txEngine.ts src/modem/protocol/rxEngine.ts src/modem/demodulation/OFDMQPSKDemodulator.ts src/ui/app.ts src/modem/test/tuning.test.ts
git commit -m "refactor(modem): centralize OFDM tuning levers in OFDM_TUNING"
```

---

### Task 4: Frame geometry V2 — 4 RS blocks per frame (+33%)

Amortize the 27-byte sentinel+header cost over 160 payload bytes instead of 40. Frame becomes 235 B = 3 sentinel + 24 BCH header + 4 × RS(52,40). Each RS block still independently corrects up to 6 byte errors. `SentinelScanner`, `TxEngine`, and `RxEngine` all derive sizes from `atomicFrame.ts` exports, so almost everything adapts automatically.

Trade-off (document, don't fear): a frame whose noise burst exceeds one block's correction budget loses 160 B instead of 40 B. `PAYLOAD_BLOCKS` is the lever — 1 restores today's format.

**Files:**
- Modify: `src/modem/protocol/atomicFrame.ts` (constants + `encodeFrame` + `decodeFrame`)
- Modify: `src/modem/test/ofdm_native_rate.test.ts:119` (hardcodes `79`)
- Create: `src/modem/test/atomicFrameV2.test.ts`

**Interfaces:**
- Consumes: `rsEncode(data: Uint8Array): Uint8Array` (returns 52 B — `src/modem/ecc/reedsolomon.ts:97`), `rsDecode(block: Uint8Array): { data: Uint8Array; valid: boolean; errors: number }`. WARNING: `rsEncode` pads short input at the FRONT (`reedsolomon.ts:109-110`) — always hand it exactly-40-byte chunks (see Step 3).
- Produces: `PAYLOAD_BLOCKS = 4`, `PAYLOAD_DATA_SIZE = 160`, `RS_PAYLOAD_SIZE = 208`, `FRAME_SIZE = 235` exported from `atomicFrame.ts`. `encodeFrame(header, payload)` accepts up to 160 B payload; `decodeFrame(frame)` returns 160 B payload. Function signatures unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/modem/test/atomicFrameV2.test.ts`:

```ts
/**
 * Frame geometry V2 — multiple RS(52,40) blocks per frame.
 */
import { expect, test } from 'vitest';
import {
  encodeFrame,
  decodeFrame,
  FRAME_SIZE,
  PAYLOAD_DATA_SIZE,
  PAYLOAD_BLOCKS,
  SENTINEL_SIZE,
  BCH_HEADER_SIZE,
} from '../protocol/atomicFrame';

test('frame geometry: 4 RS blocks, 160-byte payload, 235-byte frame', () => {
  expect(PAYLOAD_BLOCKS).toBe(4);
  expect(PAYLOAD_DATA_SIZE).toBe(160);
  expect(FRAME_SIZE).toBe(235);
});

test('roundtrip: full 160-byte payload survives encode → decode', () => {
  const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 0xff;
  const frame = encodeFrame({ type: 0x02, seqNum: 7, totalFrames: 9, crc: 0 }, payload);
  expect(frame.length).toBe(FRAME_SIZE);

  const dec = decodeFrame(frame);
  expect(dec.valid).toBe(true);
  expect(dec.header!.type).toBe(0x02);
  expect(dec.header!.seqNum).toBe(7);
  expect(dec.header!.totalFrames).toBe(9);
  expect(dec.payload.length).toBe(PAYLOAD_DATA_SIZE);
  expect(Array.from(dec.payload)).toEqual(Array.from(payload));
});

test('each RS block independently corrects up to 6 byte errors', () => {
  const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 53 + 3) & 0xff;
  const frame = encodeFrame({ type: 0x02, seqNum: 1, totalFrames: 2, crc: 0 }, payload);

  const rsStart = SENTINEL_SIZE + BCH_HEADER_SIZE;
  for (let b = 0; b < PAYLOAD_BLOCKS; b++) {
    // 6 corrupted bytes per 52-byte block — RS(52,40) correction limit
    for (const off of [0, 9, 18, 27, 36, 51]) {
      frame[rsStart + b * 52 + off] ^= 0xff;
    }
  }

  const dec = decodeFrame(frame);
  expect(dec.valid).toBe(true);
  expect(Array.from(dec.payload)).toEqual(Array.from(payload));
});

test('short payload (40 bytes) still encodes — remaining blocks zero-pad', () => {
  const payload = new Uint8Array(40).fill(0xab);
  const frame = encodeFrame({ type: 0x01, seqNum: 0, totalFrames: 1, crc: 0 }, payload);
  const dec = decodeFrame(frame);
  expect(dec.valid).toBe(true);
  expect(Array.from(dec.payload.slice(0, 40))).toEqual(Array.from(payload));
  expect(dec.payload.slice(40).every((b) => b === 0)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modem/test/atomicFrameV2.test.ts`
Expected: FAIL — `PAYLOAD_BLOCKS` not exported, sizes are 79/40.

- [ ] **Step 3: Implement in atomicFrame.ts**

In `src/modem/protocol/atomicFrame.ts`, replace the constants block (lines 29-40) with:

```ts
/** RS blocks packed into one frame — the frame-size lever (1 = legacy 79B) */
export const PAYLOAD_BLOCKS = 4;
/** Data bytes carried by one RS(52,40) block */
export const RS_BLOCK_DATA = 40;
/** Wire bytes of one RS(52,40) block */
export const RS_BLOCK_SIZE = 52;
/** Sentinel bytes (3) */
export const SENTINEL_SIZE = 3;
/** BCH(63,30) × 3 header size (bytes) */
export const BCH_HEADER_SIZE = 24;
/** RS payload+parity size (bytes) */
export const RS_PAYLOAD_SIZE = RS_BLOCK_SIZE * PAYLOAD_BLOCKS;
/** Raw (unencoded) header size (bytes) */
export const RAW_HEADER_SIZE = 9;
/** Payload data size before RS encoding (bytes) */
export const PAYLOAD_DATA_SIZE = RS_BLOCK_DATA * PAYLOAD_BLOCKS;
/** Total frame size on the wire (bytes) */
export const FRAME_SIZE = SENTINEL_SIZE + BCH_HEADER_SIZE + RS_PAYLOAD_SIZE;
```

(Keep the doc comment at the top of the file, but update the wire-format description to `[SENTINEL 3B][BCH_HEADER 24B][RS(52,40) × PAYLOAD_BLOCKS]`.)

In `encodeFrame` (line ~170), replace steps 4-5 (single `rsEncode` + assembly) with:

```ts
  // 4. Normalize payload to exactly PAYLOAD_DATA_SIZE (zero-pad at the END —
  // rsEncode pads short input at the FRONT, which would misplace bytes)
  const fullPayload = new Uint8Array(PAYLOAD_DATA_SIZE);
  fullPayload.set(payload.slice(0, PAYLOAD_DATA_SIZE), 0);

  // 5. RS(52,40) encode each 40-byte chunk and assemble the frame
  const frame = new Uint8Array(FRAME_SIZE);
  frame.set(SENTINEL_BYTES, 0);
  frame.set(bchHeader, SENTINEL_SIZE);
  for (let b = 0; b < PAYLOAD_BLOCKS; b++) {
    const chunk = fullPayload.slice(b * RS_BLOCK_DATA, (b + 1) * RS_BLOCK_DATA);
    frame.set(rsEncode(chunk), SENTINEL_SIZE + BCH_HEADER_SIZE + b * RS_BLOCK_SIZE);
  }
  return frame;
```

In `decodeFrame` (line ~203), replace steps 5-6 (single `rsDecode` + return) with:

```ts
  // 5. RS(52,40) decode each block
  const rsStart = SENTINEL_SIZE + BCH_HEADER_SIZE;
  const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
  let allBlocksValid = true;
  for (let b = 0; b < PAYLOAD_BLOCKS; b++) {
    const rsResult = rsDecode(
      frame.slice(rsStart + b * RS_BLOCK_SIZE, rsStart + (b + 1) * RS_BLOCK_SIZE),
    );
    payload.set(rsResult.data.slice(0, RS_BLOCK_DATA), b * RS_BLOCK_DATA);
    if (!rsResult.valid || rsResult.errors < 0) allBlocksValid = false;
  }

  // 6. Return result
  const valid = crcOk && allBlocksValid;
  return { header, payload, valid };
```

- [ ] **Step 4: Fix the one test that hardcodes 79**

`src/modem/test/ofdm_native_rate.test.ts:119` reads:
```ts
  expect(audio.length).toBe(Math.ceil(79 / 4) * symSamples);
```
Change to (adding `FRAME_SIZE` to that file's imports — `import { FRAME_SIZE } from '../protocol/atomicFrame';` if absent):
```ts
  expect(audio.length).toBe(Math.ceil(FRAME_SIZE / 4) * symSamples);
```
Check the surrounding test — if it builds its own frame with `encodeFrame`, `frame.length` is now 235 and the expectation stays self-consistent.

- [ ] **Step 5: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all PASS. Failures to expect and how to react:
- `ofdm_acoustic_path.test.ts` / `ofdm_endtoend.test.ts` / `ofdm_loopback.test.ts` use `frame.length` dynamically — should pass unchanged.
- Anything else asserting 79/40/52 sizes: update it to import the constants rather than hardcode.

Consumers that adapt automatically (verify, don't modify): `SentinelScanner` (`collectBytes = FRAME_SIZE - 3`, `SentinelScanner.ts:39`), `TxEngine.splitDataIntoFrames`/`calcFrameCount`/`buildHeaderPayload` (all use `PAYLOAD_DATA_SIZE`), `RxEngine.processHeader` name parsing (`rxEngine.ts:880` uses `PAYLOAD_DATA_SIZE`). `app.ts` `sendSingleFrame` builds a 40-byte payload — still valid, blocks 2-4 zero-pad; its `FRAME-TEST txBytes` log becomes 235.

- [ ] **Step 6: Re-run the benchmark and record the gain**

Run: `npx vitest run src/modem/test/throughput.test.ts`
Expected: PASS, `[BENCH]` rate at 32 tones ≈ +25-35% over the Task 1 number (steady-state math: 160 B per ceil(235/8)=30 symbols = 118.5 B/s vs 88.9). Update the rate floor in `throughput.test.ts` from `60` to `85` (32 tones) and `30` to `45` (16 tones).

- [ ] **Step 7: Commit**

```bash
git add src/modem/protocol/atomicFrame.ts src/modem/test/atomicFrameV2.test.ts src/modem/test/ofdm_native_rate.test.ts src/modem/test/throughput.test.ts
git commit -m "feat(modem): pack 4 RS blocks per atomic frame (79B->235B, payload 51%->68%)"
```

---

### Task 5: 20 ms symbol — 40 sym/s (×1.8)

Halve `OFDM_SYMBOL_MS` from 40 to 20. The orthogonality grid becomes 1000/20 = 50 Hz; pilot 1900 (= 38×50) and tones 2000 + n·50 are all exact multiples of 50, so **no frequency changes**. CP stays 5 ms (overhead rises 11%→20% — already netted into the 1.8× figure). Watchdog, UI readout, `ofdmSamples()`, and all sample counts derive from the constant and adapt automatically.

Physics cost to verify, not assume: each tone's per-symbol integration window halves (−3 dB noise averaging) and sync/hum discrimination windows shrink. The existing hum-immunity and sync tests are the gate.

**Files:**
- Modify: `src/modem/types.ts:161`
- Modify: `src/modem/test/ofdm_native_rate.test.ts` (pins the 25 Hz grid)

- [ ] **Step 1: Change the constant**

`src/modem/types.ts:161`:
```ts
export const OFDM_SYMBOL_MS = 20; // FFT-equivalent window: 50 Hz tone grid
```
(Leave `OFDM_CP_MS = 5` untouched.)

- [ ] **Step 2: Run the full suite and triage**

Run: `npx vitest run`
Expected: `ofdm_native_rate.test.ts` FAILS where it pins the old grid — read each failure:
- Line ~27 `const grid = 1000 / OFDM_SYMBOL_MS; // 25 Hz` — the variable is derived; update only the comment (`// 50 Hz`) and any literal `25` assertions to use `grid`.
- Any assertion of the form `expect(OFDM_SYMBOL_MS).toBe(40)` → `toBe(20)`.
- `expect(OFDM_CP_MS).toBe(5)` (line ~35) must STILL pass — do not touch CP.
- Sample-count assertions using `ofdmSamples(...)` derive automatically.

CRITICAL GATE: `ofdm_sync.test.ts` (hum immunity) and `ofdm_acoustic_path.test.ts` (misaligned grid, delay-inside-CP, 32 tones) must pass WITHOUT changing any threshold in `rxEngine.ts`. If they fail, STOP, revert Step 1, and report the failing assertions — shorter symbols weakening sync discrimination is a real outcome, not a test bug.

- [ ] **Step 3: Re-run benchmark**

Run: `npx vitest run src/modem/test/throughput.test.ts`
Expected: PASS, 32-tone rate ≈ 1.8× the Task 4 number (steady-state 160 B / (30 × 25 ms) = 213 B/s). Raise the floors again: 32 tones `85` → `150`, 16 tones `45` → `75`.

- [ ] **Step 4: Typecheck + full suite green**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all PASS.

- [ ] **Step 5: Live sanity check in the browser (real acoustic path)**

Run: `npm run dev`, open the app, enable OFDM, 32 tones, then: Send Single Frame (expect `[RX-FRAME] valid=true` in console), then Send Test (expect hello.txt to decode). This is the one step automated tests can't cover — real speaker/mic, real room. If the single frame decodes but sync feels flaky (repeated `falseTrigger` warnings), report before committing.

- [ ] **Step 6: Commit**

```bash
git add src/modem/types.ts src/modem/test/ofdm_native_rate.test.ts src/modem/test/throughput.test.ts
git commit -m "feat(modem): 20ms OFDM symbol (40 sym/s, 50Hz grid) for 1.8x throughput"
```

---

### Task 6: Truthful UI — net bitrate readout, hide the no-op control, default 32 tones

Three UI lies to fix: (a) the Symbol Rate select renders in OFDM mode but does nothing; (b) the bitrate readout shows raw PHY bits, not what a file actually gets; (c) the OFDM default is 16 tones though 32 is confirmed working.

**Files:**
- Modify: `src/ui/MainApp.tsx:381-412` (Symbol Rate block + readout)
- Modify: `src/modem/types.ts:180` (`OFDM_DEFAULTS.toneCount: 16` → `32`)
- Modify: `src/modem/protocol/ofdmEngine.ts:20` (`cfg.toneCount ?? 16` → `?? OFDM_DEFAULTS.toneCount`)

**Interfaces:**
- Consumes: `FRAME_SIZE`, `PAYLOAD_DATA_SIZE` from `src/modem/protocol/atomicFrame.ts` (Task 4 values), `OFDM_SYMBOL_MS`, `OFDM_CP_MS`, `OFDM_DEFAULTS` from `src/modem/types.ts` (already imported at `MainApp.tsx:20`).

- [ ] **Step 1: Change the defaults**

`src/modem/types.ts` `OFDM_DEFAULTS`: `toneCount: 16,` → `toneCount: 32,`.
`src/modem/protocol/ofdmEngine.ts:20`: `const toneCount = cfg.toneCount ?? 16;` → `const toneCount = cfg.toneCount ?? OFDM_DEFAULTS.toneCount;` and extend the line-9 import: `import { ofdmSamples, ofdmToneFrequencies, OFDM_DEFAULTS } from '../types';`.
Note `MainApp.tsx:61-62` already auto-applies `OFDM_DEFAULTS.toneCount` when OFDM is enabled with `toneCount < 8` — no change needed there.

- [ ] **Step 2: Hide the Symbol Rate control in OFDM mode and show net bitrate**

In `src/ui/MainApp.tsx`, wrap the Symbol Rate block (the `<div>` starting at the `{/* Symbol Rate */}` comment, ~line 381, through its closing `</div>` at ~line 407) in a conditional so it renders only for BPSK:

```tsx
            {!s.useOFDM && (
              /* existing Symbol Rate div, unchanged */
            )}
```

Replace the readout `<div>` (~lines 408-412) with:

```tsx
            <div style={{ fontSize: 10, color: '#4b5563', marginTop: -4, marginBottom: 8 }}>
              {s.useOFDM
                ? (() => {
                    const symbolSec = (OFDM_SYMBOL_MS + OFDM_CP_MS) / 1000;
                    const bytesPerSym = Math.max(1, Math.floor(s.toneCount / 4));
                    const frameSyms = Math.ceil(FRAME_SIZE / bytesPerSym);
                    const netBps = Math.round((PAYLOAD_DATA_SIZE * 8) / (frameSyms * symbolSec));
                    const rawBps = Math.round((s.toneCount * 2) / symbolSec);
                    return `≈${netBps} bit/s net (${rawBps} raw)`;
                  })()
                : `${s.symbolsPerSec * s.toneCount} bit/s`}
            </div>
```

Add to `MainApp.tsx` imports: `import { FRAME_SIZE, PAYLOAD_DATA_SIZE } from '../modem/protocol/atomicFrame';`.

- [ ] **Step 3: Typecheck + suite + visual check**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. Then `npm run dev`: in OFDM mode the Symbol Rate select is gone and the readout shows ≈`1707 bit/s net (2560 raw)` at 32 tones (with Tasks 4+5 landed); in BPSK mode the select is back.

- [ ] **Step 4: Commit**

```bash
git add src/ui/MainApp.tsx src/modem/types.ts src/modem/protocol/ofdmEngine.ts
git commit -m "feat(ui): net OFDM bitrate readout, hide no-op symbol rate, default 32 tones"
```

---

### Task 7 (OPTIONAL, gated): trim sync burst 24 → 18

Saves 6 symbols per transmission (150 ms at 25 ms symbols) by cutting training 12 → 8. Floor: `syncMinFrames (8) + 2 slack + training (8) = 18`. Worthwhile only for many small transfers; skip freely.

**Files:**
- Modify: `src/modem/types.ts` `OFDM_TUNING` (`syncBurstSymbols: 18, trainingSymbols: 8`)
- Modify: `src/modem/test/tuning.test.ts` (`current default values` expectation)

- [ ] **Step 1:** Change both values in `OFDM_TUNING` and the pinned expectation in `tuning.test.ts` (the floor invariant test must still pass: 8+2+8=18 ≤ 18).
- [ ] **Step 2:** Run `npx vitest run`. The test files that hardcode `SYNC_COUNT = 24` and train 12 symbols locally (`ofdm_endtoend.test.ts:14,25`, `ofdm_acoustic_path.test.ts:16`, `ofdm_loopback.test.ts:33`, `ofdm_native_rate.test.ts:120,128,158`, `ofdm_sync.test.ts:36`) keep passing because they generate their own bursts — they gate nothing here. The full-pipeline gates are `throughput.test.ts` and `ofdm_acoustic_path.test.ts`.
- [ ] **Step 3:** Live browser check exactly as Task 5 Step 5 — training on only 8 symbols in a real room is the risk. If `OFDM-TRAIN` channel estimates come out with wildly uneven amplitudes/phases (compare against a Send Single Frame at defaults), revert this task entirely.
- [ ] **Step 4:** Commit only if both gates pass:
```bash
git add src/modem/types.ts src/modem/test/tuning.test.ts
git commit -m "feat(modem): trim OFDM sync burst 24->18 symbols (training 12->8)"
```

---

### Task 8: Final verification, numbers, docs

**Files:**
- Modify: `docs/MODEM.md` (OFDM section, ~lines 230-280: symbol length, frame layout, rates)
- Modify: `STATE.md` (current-state summary)

- [ ] **Step 1: Full suite + benchmark, record the before/after table**

Run: `npx vitest run` then `npx vitest run src/modem/test/throughput.test.ts`.
Collect the `[BENCH]` lines from Task 1 (baseline) through now and write the table into the commit message and `STATE.md`:

| Config | Payload rate |
|---|---|
| Baseline: 45 ms symbol, 79 B frame, 32 tones | (Task 1 number, ≈75 B/s) |
| + pilot fix | (Task 2 number, ≈unchanged) |
| + 235 B frame | (Task 4 number, ≈+33%) |
| + 20 ms symbol | (Task 5 number, ≈×1.8) |

- [ ] **Step 2: Update docs/MODEM.md**

In the OFDM spec section: `Symbol length: 20 ms + 5 ms cyclic prefix = 25 ms`, `Tone grid: multiples of 50 Hz`, frame layout `[SENTINEL 3B][BCH_HEADER 24B][RS(52,40) × 4 = 208B]` = 235 B carrying 160 B, sample counts at 48 kHz: `960 + 240 = 1200 samples`, pilot amplitude 2.0 (OFDM), and the payload-rate table above. Keep the "TX and RX may run at different hardware rates" paragraph — still true.

- [ ] **Step 3: Live end-to-end transfer of a real file**

`npm run dev`, OFDM + 32 tones, send a multi-KB file speaker→mic. Confirm received byte count matches and note wall-clock seconds vs the old 52-90 s.

- [ ] **Step 4: Commit**

```bash
git add docs/MODEM.md STATE.md
git commit -m "docs: OFDM throughput spec update (25ms symbol, 235B frame, bench numbers)"
```

---

## Appendix: further levers — documented, deliberately NOT in this plan

Ranked by value/risk for whoever picks them up later. Each needs its own plan + the Task 1 benchmark as the gate.

1. **16-QAM per tone (×2).** Requires amplitude equalization — `OFDMQPSKDemodulator` currently does phase-only correction (`demodulate`, decision `Math.round(phase / (π/2))`); channel amplitude `hypot(channelEstRe, channelEstIm)` is already estimated during training, so the plumbing exists. Needs real-room SNR headroom measurement first (per-tone EVM logging).
2. **Adaptive tone loading.** Training already measures per-tone `h` (`OFDM-TRAIN` log). Skip/derate tones whose channel amplitude is < ~25% of the median (the speaker-rolloff victims at the top of the band) instead of letting them poison frames. Needs a TX↔RX handshake or a fixed mask convention.
3. **CP 5 → 2.5 ms (+11%).** Fine in small rooms/loopback, fails in reverberant ones. Make it an `OFDM_TUNING` lever with a live A/B; the acoustic-path delay test (100-sample delay must sit inside CP) bounds how low it can go.
4. **More tones (48 = 2000-4350 Hz).** Peak normalization in `OFDMQPSKModulator.generateSymbol` divides every tone's amplitude by the composite peak — more tones = less power per tone, and the top of the band hits speaker/mic rolloff. Only after lever 2 exists to prune dead tones automatically.
5. **Slimmer header.** 9 B → 24 B BCH is generous; type+seq+total+CRC8 fits 2 BCH codewords (16 B), saving 8 B/frame (~3% at 235 B frames). Low value now that the frame is big — that's why it's here and not a task.
6. **Byte interleaving across the 4 RS blocks.** Spreads a burst error over all blocks (each corrects 6). Cheap to add in `atomicFrame.ts` encode/decode as a lever; do it if real-room testing shows burst-loss-dominated frame failures.

## What NOT to do (hard-won, verified against this codebase)

- The forced-1 bit interleave in `rxEngine.ts`/`OFDMQPSKDemodulator.ts` is NOT wasted wire capacity. Wire packing is already 100%: one byte per 4-tone block per symbol. Leave it alone.
- `symbolsPerSec` never touches OFDM timing. Don't "unify" it with `OFDM_SYMBOL_MS`.
- Never emit a pilot/tone frequency off the `1000/OFDM_SYMBOL_MS` grid — orthogonality dies quietly (adjacent-tone leakage, no error, just bit rot).
- Never pass a `toneCount` that isn't a multiple of 4 — both engines clamp it to 4 silently.
- Don't tune `rxEngine.ts:266` sync thresholds (`score`, `sharpness`) to make a failing test pass — they are the hum-rejection defense (see `ofdm_sync.test.ts`).
- Don't touch the legacy BPSK files listed in Global Constraints.
- The worker TX config in `src/ui/app.ts` (both `eardrop-send` and `eardrop-send-test` handlers) MUST keep passing `toneCount` — omitting it silently falls back to `DEFAULT_CONFIG.toneCount = 4` in the worker while RX runs the UI value, and nothing decodes. This exact bug was fixed on 2026-07-10; don't regress it.
- `recvSamples` in `src/ui/app.ts:716-718` is capped at 10 s and trimmed to 5 s — diagnostic `rxSamples` counts in `FRAME-TEST` logs go negative on long plays. Cosmetic, known, not a data-loss bug; don't chase it.

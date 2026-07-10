# Native Hardware-Rate OFDM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the OFDM modem at the hardware AudioContext rate (48000/44100/whatever the device reports) — no downsampling, no resampling, tones in the 2–4 kHz hardware sweet spot, device-rate independent.

**Architecture:** The protocol is redefined in **time and hertz instead of samples and bins**: symbol window 40 ms + 5 ms cyclic prefix, tone frequencies on a 25 Hz grid (integer cycles per window ⇒ orthogonal at any sample rate). Modulation becomes direct cosine synthesis (no IFFT, no power-of-two constraint); demodulation becomes a Goertzel/`toneIQ` bank at the exact tone frequencies (no FFT). The capture worklet becomes a pass-through chunker for OFDM (decimation retained only for the legacy 3200 Hz BPSK stack). TX and RX may run at *different* hardware rates — frequencies are absolute, so a 44100 Hz sender decodes on a 48000 Hz receiver.

**Tech Stack:** TypeScript, Web Audio (AudioWorklet `processorOptions`), Vitest. Reuses `toneIQ` (src/modem/pilot.ts), `resample` (src/lib/math), block packing + sync detection + CP alignment + watchdog from the current rxEngine.

## Global Constraints

- Absolute frequencies only in the protocol; never bins. Tone grid = multiples of `1000 / OFDM_SYMBOL_MS` Hz (25 Hz at 40 ms).
- All sample counts derived at runtime: `Math.round(fs * ms / 1000)`.
- Legacy BPSK stack stays at 3200 Hz and must keep passing its tests untouched.
- OFDM tone count stays a multiple of 4 (byte-block packing).
- Debug output via `dlog` only, per `docs/DEBUG-OUTPUT.md`.
- No `any`, repo eslint rules apply (`max-params: 3` — new functions take option objects).
- Every task: failing test → implement → pass → commit (conventional commits, no AI attribution).

## New protocol defaults (single source of truth: Task 1)

| Parameter | Value | Rationale |
|---|---|---|
| `OFDM_SYMBOL_MS` | 40 | 25 Hz tone grid; 22.2 sym/s with CP |
| `OFDM_CP_MS` | 5 | absorbs ±240 samples @48k timing error, > typical room multipath |
| `ofdmPilotFreqHz` | 1900 | just below tone band, shares channel response, far above hum/fan noise |
| `ofdmPilotAmplitude` | 2.0 | pilot must dominate single data tones (phase reference) |
| `ofdmToneSpacingHz` | 50 | 2× grid spacing for drift margin |
| `ofdmToneStartHz` | 2000 | hardware sweet spot 2–4 kHz, above room-noise band |
| `ofdmToneCount` default | 16 | 16 tones → 2000–2750 Hz; UI offers 8/16/32 |
| Sync burst | 24 symbols (~1.08 s) | unchanged count; detect(8) + align + train(12) + slack |
| Raw bitrate | 16 tones: **711 bps**, 32 tones: **1422 bps** | tones × 2 bits × 22.2 sym/s |
| Watchdog | 15 s worth of symbols | replaces fixed 150-window count |

Hum note: sync-energy detection reads the tone frequencies (≥2 kHz), so 50 Hz
hum is invisible to the trigger; the sharpness gate stays as a second layer.

## File map

| File | Change |
|---|---|
| `src/modem/types.ts` | add `OfdmTiming` constants + `ofdmSamples()` helper + new defaults |
| `src/modem/modulation/OFDMQPSKModulator.ts` | rewrite: direct cosine synthesis, arbitrary fs |
| `src/modem/demodulation/OFDMQPSKDemodulator.ts` | rewrite: toneIQ bank, f-ratio drift correction |
| `src/modem/protocol/ofdmEngine.ts` | rate-aware sizes, new defaults |
| `src/modem/protocol/rxEngine.ts` | rate-derived `sps`/CP/watchdog; no bin math |
| `src/modem/protocol/txEngine.ts` | pass fs through; OFDM path only |
| `src/audio/recorder.ts` | worklet `processorOptions.ratio` (1 = pass-through, 15 = legacy) |
| `src/audio/player.ts` | no change needed (buffer already at signal rate — now equals ctx rate) |
| `src/ui/app.ts` | plumb `audioCtx.sampleRate` into TX/RX config when `useOFDM` |
| `src/ui/MainApp.tsx` | pilot slider 500–4000 default 1900; live bitrate readout |
| `src/modem/test/ofdm_native_rate.test.ts` | new: roundtrip @48k & @44.1k, cross-rate, hum immunity |
| `src/modem/test/ofdm_acoustic_path.test.ts` | switch to 48000/new defaults |
| `docs/MODEM.md`, `STATE.md` | update spec tables |

---

### Task 1: Time-domain OFDM constants and helpers

**Files:**
- Modify: `src/modem/types.ts`
- Test: `src/modem/test/ofdm_native_rate.test.ts` (create)

**Interfaces:**
- Produces: `OFDM_SYMBOL_MS = 40`, `OFDM_CP_MS = 5`,
  `ofdmSamples(sampleRate: number): { fftSamples: number; cpSamples: number; symSamples: number }`,
  `OFDM_DEFAULTS = { pilotFreqHz: 1900, pilotAmplitude: 2.0, toneStartHz: 2000, toneSpacingHz: 50, toneCount: 16 }`,
  `ofdmToneFrequencies(opts: { toneCount: number; startHz?: number; spacingHz?: number }): Float32Array`

- [ ] **Step 1: Write the failing test**

```ts
// src/modem/test/ofdm_native_rate.test.ts
import { expect, test } from 'vitest';
import {
  OFDM_SYMBOL_MS,
  OFDM_CP_MS,
  ofdmSamples,
  ofdmToneFrequencies,
  OFDM_DEFAULTS,
} from '../types';

test('ofdmSamples derives integer windows at both common hardware rates', () => {
  expect(ofdmSamples(48000)).toEqual({ fftSamples: 1920, cpSamples: 240, symSamples: 2160 });
  expect(ofdmSamples(44100)).toEqual({ fftSamples: 1764, cpSamples: 221, symSamples: 1985 });
});

test('tone frequencies are absolute, on the symbol-duration grid', () => {
  const freqs = ofdmToneFrequencies({ toneCount: 16 });
  expect(freqs.length).toBe(16);
  expect(freqs[0]).toBe(2000);
  expect(freqs[15]).toBe(2750);
  const grid = 1000 / OFDM_SYMBOL_MS; // 25 Hz
  for (const f of freqs) expect(f % grid).toBe(0);
});

test('defaults: pilot below tone band, on grid', () => {
  expect(OFDM_DEFAULTS.pilotFreqHz).toBe(1900);
  expect(OFDM_DEFAULTS.pilotFreqHz % (1000 / OFDM_SYMBOL_MS)).toBe(0);
  expect(OFDM_DEFAULTS.pilotAmplitude).toBe(2.0);
  expect(OFDM_CP_MS).toBe(5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modem/test/ofdm_native_rate.test.ts`
Expected: FAIL — `ofdmSamples` is not exported.

- [ ] **Step 3: Implement in types.ts**

```ts
// append to src/modem/types.ts

/** OFDM symbol timing — defined in TIME so any hardware rate works. */
export const OFDM_SYMBOL_MS = 40; // FFT-equivalent window: 25 Hz tone grid
export const OFDM_CP_MS = 5; // cyclic prefix / timing guard

export function ofdmSamples(sampleRate: number): {
  fftSamples: number;
  cpSamples: number;
  symSamples: number;
} {
  const fftSamples = Math.round((sampleRate * OFDM_SYMBOL_MS) / 1000);
  const cpSamples = Math.round((sampleRate * OFDM_CP_MS) / 1000);
  return { fftSamples, cpSamples, symSamples: fftSamples + cpSamples };
}

/** Native-rate OFDM defaults — tones in the 2–4 kHz hardware sweet spot. */
export const OFDM_DEFAULTS = {
  pilotFreqHz: 1900,
  pilotAmplitude: 2.0,
  toneStartHz: 2000,
  toneSpacingHz: 50,
  toneCount: 16,
} as const;

export function ofdmToneFrequencies(opts: {
  toneCount: number;
  startHz?: number;
  spacingHz?: number;
}): Float32Array {
  const start = opts.startHz ?? OFDM_DEFAULTS.toneStartHz;
  const spacing = opts.spacingHz ?? OFDM_DEFAULTS.toneSpacingHz;
  const freqs = new Float32Array(opts.toneCount);
  for (let t = 0; t < opts.toneCount; t++) freqs[t] = start + t * spacing;
  return freqs;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modem/test/ofdm_native_rate.test.ts` → PASS

- [ ] **Step 5: Commit** — `feat(modem): time-domain OFDM constants for native-rate operation`

---

### Task 2: Modulator — direct cosine synthesis at any rate

**Files:**
- Modify: `src/modem/modulation/OFDMQPSKModulator.ts` (full rewrite, same class name)
- Test: `src/modem/test/ofdm_native_rate.test.ts` (extend)

**Interfaces:**
- Consumes: `ofdmSamples`, `OFDM_DEFAULTS` (Task 1); `toneIQ(window, freq, sampleRate)` from `../pilot`
- Produces: `new OFDMQPSKModulator({ sampleRate, toneFrequencies, pilotFreqHz, pilotAmplitude })`,
  `.setSymbols(symbols: number[])` (0–3 per tone, unchanged), `.generateSymbol(): Float32Array`
  (length `symSamples` for its rate, CP-prefixed, peak-normalized to 0.95)

- [ ] **Step 1: Write the failing tests**

```ts
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { toneIQ } from '../pilot';
import { ofdmSamples, ofdmToneFrequencies, OFDM_DEFAULTS } from '../types';

function makeMod(sampleRate: number, toneCount = 16) {
  return new OFDMQPSKModulator({
    sampleRate,
    toneFrequencies: ofdmToneFrequencies({ toneCount }),
    pilotFreqHz: OFDM_DEFAULTS.pilotFreqHz,
    pilotAmplitude: OFDM_DEFAULTS.pilotAmplitude,
  });
}

for (const rate of [48000, 44100]) {
  test(`synthesis @${rate}: correct length, QPSK phases recoverable per tone`, () => {
    const mod = makeMod(rate);
    const { fftSamples, cpSamples, symSamples } = ofdmSamples(rate);
    const sent = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
    mod.setSymbols(sent);
    const audio = mod.generateSymbol();
    expect(audio.length).toBe(symSamples);

    // Demodulate directly with toneIQ over the CP-stripped window
    const win = audio.slice(cpSamples, cpSamples + fftSamples);
    const freqs = ofdmToneFrequencies({ toneCount: 16 });
    sent.forEach((sym, t) => {
      const { i, q } = toneIQ(win, freqs[t], rate);
      let phase = Math.atan2(q, i);
      if (phase < 0) phase += 2 * Math.PI;
      const got = Math.round(phase / (Math.PI / 2)) % 4;
      expect(got, `tone ${t}`).toBe(sym);
    });
  });
}

test('cross-tone leakage below -30 dB (orthogonality on the 25 Hz grid)', () => {
  const mod = makeMod(48000, 4); // tones 2000..2150
  mod.setSymbols([0, 0, 0, 0]);
  const { fftSamples, cpSamples } = ofdmSamples(48000);
  const audio = mod.generateSymbol();
  const win = audio.slice(cpSamples, cpSamples + fftSamples);
  const on = toneIQ(win, 2000, 48000);
  const off = toneIQ(win, 2025, 48000); // grid neighbour, not transmitted
  const ratio = Math.hypot(off.i, off.q) / Math.hypot(on.i, on.q);
  expect(ratio).toBeLessThan(0.03);
});
```

- [ ] **Step 2: Run** → FAIL (constructor signature mismatch / lengths wrong)

- [ ] **Step 3: Rewrite the modulator**

```ts
/**
 * OFDMQPSKModulator — native-rate multitone QPSK synthesis.
 *
 * No IFFT: tone frequencies are absolute Hz on the 1/OFDM_SYMBOL_MS grid, so
 * each completes an integer number of cycles per window and the set is
 * orthogonal at ANY sample rate. Direct cosine synthesis; the cyclic prefix
 * is the tail of the window copied to the front, exactly as before.
 */
import { ofdmSamples } from '../types';

export interface OFDMQPSKModulatorConfig {
  sampleRate: number;
  toneFrequencies: Float32Array;
  pilotFreqHz: number;
  pilotAmplitude: number;
}

function qpskPhase(symbol: number): number {
  return (symbol % 4) * (Math.PI / 2);
}

export class OFDMQPSKModulator {
  private cfg: OFDMQPSKModulatorConfig;
  private phases: number[];
  private fftSamples: number;
  private cpSamples: number;

  constructor(config: OFDMQPSKModulatorConfig) {
    this.cfg = config;
    this.phases = new Array(config.toneFrequencies.length).fill(0);
    const { fftSamples, cpSamples } = ofdmSamples(config.sampleRate);
    this.fftSamples = fftSamples;
    this.cpSamples = cpSamples;
  }

  setSymbols(symbols: number[]): void {
    if (symbols.length !== this.cfg.toneFrequencies.length) {
      throw new Error(
        `Expected ${this.cfg.toneFrequencies.length} symbols, got ${symbols.length}`,
      );
    }
    this.phases = symbols.map(qpskPhase);
  }

  generateSymbol(): Float32Array {
    const { sampleRate, toneFrequencies, pilotFreqHz, pilotAmplitude } = this.cfg;
    const body = new Float32Array(this.fftSamples);
    const twoPiOverFs = (2 * Math.PI) / sampleRate;
    for (let n = 0; n < this.fftSamples; n++) {
      let acc = pilotAmplitude * Math.cos(twoPiOverFs * pilotFreqHz * n);
      for (let t = 0; t < toneFrequencies.length; t++) {
        acc += Math.cos(twoPiOverFs * toneFrequencies[t] * n + this.phases[t]);
      }
      body[n] = acc;
    }
    // Peak-normalize to 0.95
    let peak = 0;
    for (let n = 0; n < body.length; n++) peak = Math.max(peak, Math.abs(body[n]));
    const scale = peak > 0 ? 0.95 / peak : 1;
    for (let n = 0; n < body.length; n++) body[n] *= scale;
    // Cyclic prefix
    const out = new Float32Array(this.fftSamples + this.cpSamples);
    out.set(body.subarray(this.fftSamples - this.cpSamples), 0);
    out.set(body, this.cpSamples);
    return out;
  }
}
```

Note: QPSK phase must match the demodulator's quadrant decode — `cos(2πft + φ)`
measured by `toneIQ` yields I=cos φ, Q=−sin φ or +sin φ depending on `toneIQ`'s
convention. **Step 1's roundtrip test pins the convention** — if the recovered
symbol is rotated/reflected, negate the phase sign here (`− this.phases[t]`),
not in the demodulator.

- [ ] **Step 4: Run** → PASS (adjust phase sign per the note if the roundtrip is reflected)

- [ ] **Step 5: Commit** — `feat(modem): native-rate cosine-synthesis OFDM modulator`

---

### Task 3: Demodulator — toneIQ bank, frequency-ratio drift correction

**Files:**
- Modify: `src/modem/demodulation/OFDMQPSKDemodulator.ts`
- Test: `src/modem/test/ofdm_native_rate.test.ts` (extend)

**Interfaces:**
- Consumes: `toneIQ`, `ofdmSamples`
- Produces: same public API as today — `resetTraining()`, `isTraining()`,
  `trainOnSyncSymbol(window)`, `demodulate(window): OFDMQPSKResult` — but config is
  `{ sampleRate, toneFrequencies, pilotFreqHz }` (no `fftSize`, no `cpLength`).

Keep the existing training accumulation, phase-only EQ, and pilot-drift logic
verbatim, with two mechanical substitutions:

1. `analyze()` uses `toneIQ(symSamples, f, sampleRate)` per tone + pilot instead of FFT bins.
2. Drift correction `-pilotDrift * bin / this.pilotBin` becomes
   `-pilotDrift * (this.cfg.toneFrequencies[t] / this.cfg.pilotFreqHz)` —
   same linear-in-frequency model, no bins.

Window slicing: `const { fftSamples, cpSamples } = ofdmSamples(cfg.sampleRate)`
computed once in the constructor; `demodulate`/`trainOnSyncSymbol` slice
`buf.slice(cpSamples, cpSamples + fftSamples)`.

- [ ] **Step 1: Failing test — modulator→demodulator roundtrip with training, both rates**

```ts
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';

for (const rate of [48000, 44100]) {
  test(`mod→demod roundtrip with sync training @${rate}`, () => {
    const freqs = ofdmToneFrequencies({ toneCount: 16 });
    const mod = makeMod(rate);
    const demod = new OFDMQPSKDemodulator({
      sampleRate: rate,
      toneFrequencies: freqs,
      pilotFreqHz: OFDM_DEFAULTS.pilotFreqHz,
    });
    const { symSamples } = ofdmSamples(rate);

    // 12 sync symbols (all zeros) to train
    mod.setSymbols(new Array(16).fill(0));
    for (let s = 0; s < 12; s++) demod.trainOnSyncSymbol(mod.generateSymbol());
    expect(demod.isTraining()).toBe(false);

    const sent = Array.from({ length: 16 }, (_unused, t) => (t * 3) % 4);
    mod.setSymbols(sent);
    const audio = mod.generateSymbol();
    expect(audio.length).toBe(symSamples);
    const result = demod.demodulate(audio);
    const got = [];
    for (let t = 0; t < 16; t++) got.push((result.bits[t * 2] << 1) | result.bits[t * 2 + 1]);
    expect(got).toEqual(sent);
  });
}
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Apply the two substitutions above; delete `fftSize`/bin fields and the DSP/FFT import; keep `OFDM-TRAIN` / `OFDM-DEMOD` dlog lines (report `f` in Hz, not bins).**
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** — `feat(modem): toneIQ-bank OFDM demodulator, rate-independent`

---

### Task 4: OFDMEngine — rate-aware framing

**Files:**
- Modify: `src/modem/protocol/ofdmEngine.ts`
- Test: `src/modem/test/ofdm_native_rate.test.ts` (extend)

**Interfaces:**
- Produces: `new OFDMEngine({ sampleRate, pilotFreqHz?, toneCount? })` — pilot defaults to
  `OFDM_DEFAULTS.pilotFreqHz` when caller passes the legacy BPSK default; `generateSyncBurst(count)`
  and `modulateFrame(frame)` unchanged signatures; static `FFT_SIZE`/`CP_LENGTH` **removed**
  (callers use `ofdmSamples`).

Body: replace `makeToneOffsets`/`makeToneFrequencies` with `ofdmToneFrequencies`;
keep the 4-tone-block byte packing exactly as is; drop the `amplitude` field
(modulator normalizes internally now).

- [ ] **Step 1: Failing test — airtime & sync length at 48 k, 16 tones**

```ts
import { OFDMEngine } from '../protocol/ofdmEngine';
import { encodeFrame } from '../protocol/atomicFrame';

test('engine @48k/16 tones: 2 bytes per symbol, sync burst sized in time', () => {
  const engine = new OFDMEngine({ sampleRate: 48000, toneCount: 16 });
  const { symSamples } = ofdmSamples(48000);
  const frame = encodeFrame({ type: 0x01, seqNum: 0, totalFrames: 1, crc: 0 }, new Uint8Array(40));
  const audio = engine.modulateFrame(frame); // 79 bytes / 4 blocks = 20 symbols
  expect(audio.length).toBe(Math.ceil(79 / 4) * symSamples);
  expect(engine.generateSyncBurst(24).length).toBe(24 * symSamples);
});
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** (blockCount = toneCount/4 already generalizes; wire `ofdmSamples`, `ofdmToneFrequencies`, `OFDM_DEFAULTS`)
- [ ] **Step 4: Run** → PASS
- [ ] **Step 5: Commit** — `feat(modem): rate-aware OFDMEngine with native-rate defaults`

---

### Task 5: RxEngine — rate-derived windows, alignment, watchdog

**Files:**
- Modify: `src/modem/protocol/rxEngine.ts`
- Test: `src/modem/test/ofdm_acoustic_path.test.ts` (rewrite constants)

Changes (all inside the `useOFDM` paths — BPSK untouched):
- `initOfdmDemod()`: `const { symSamples } = ofdmSamples(this.cfg.sampleRate); this.sps = symSamples;`
  tone freqs from `ofdmToneFrequencies({ toneCount })`; demod constructed with
  `{ sampleRate, toneFrequencies, pilotFreqHz }`.
- `findOfdmBlockStart()`: `const fft = ofdmSamples(this.cfg.sampleRate).fftSamples; const cp = this.sps - fft;` (drop `ofdmFftSize` field).
- Watchdog: `this.OFDM_WATCHDOG_WINDOWS` becomes a getter:
  `Math.round(15000 / (OFDM_SYMBOL_MS + OFDM_CP_MS))` (≈ 333 windows = 15 s).
- Sync threshold: keep `ofdmSyncThreshold = 0.06` as the static floor — the
  adaptive `3× EMA` dominates in practice; re-baseline empirically in Task 9's
  live test if bursts fail to trigger.

- [ ] **Step 1: Rewrite `ofdm_acoustic_path.test.ts` header constants to the native config, all four tests**

```ts
const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;
const { symSamples: SYM_LEN } = ofdmSamples(SAMPLE_RATE);
const SYNC_COUNT = 24;
// buildTransmission(toneCount = 16), receive(audio, toneCount = 16)
// misalignment offset: 1000 samples (was 100) — still well outside the CP
// delay test: 100-sample delay (~2 ms, inside the 240-sample CP)
// 8-tone test becomes 16 vs 32 tones: 32-tone airtime = half of 16-tone
```

- [ ] **Step 2: Run** → FAIL (rxEngine still builds 3200-rate windows)
- [ ] **Step 3: Implement the rxEngine changes above**
- [ ] **Step 4: Run full modem suite** — `npx vitest run src/modem/test/`
  Expected: acoustic-path + native-rate green; the 3 pre-existing pipeline
  failures (Doppler ±Hz, Full Stress) remain; legacy BPSK/loopback untouched.
- [ ] **Step 5: Commit** — `feat(modem): native-rate RX path`

---

### Task 6: Cross-rate test — 44.1 kHz sender, 48 kHz receiver

**Files:**
- Test: `src/modem/test/ofdm_native_rate.test.ts` (extend)

This is the test that proves device independence — the whole point of
absolute frequencies. Uses `resample` from `src/lib/math` to emulate the
air gap between different-rate devices.

- [ ] **Step 1: Write the test (goes red only if Tasks 2–5 broke rate independence)**

```ts
import { RxEngine } from '../protocol/rxEngine';
import { resample } from '../../lib/math';

test('cross-rate: TX @44100 decodes on RX @48000', () => {
  const engine = new OFDMEngine({ sampleRate: 44100, toneCount: 16 });
  const frame = encodeFrame({ type: 0x01, seqNum: 0, totalFrames: 1, crc: 0 }, new Uint8Array(40));
  const sync = engine.generateSyncBurst(24);
  const data = engine.modulateFrame(frame);
  const tx44 = new Float32Array(sync.length + data.length);
  tx44.set(sync, 0);
  tx44.set(data, sync.length);

  const tx48 = resample(tx44, 44100, 48000);
  const padded = new Float32Array(1000 + tx48.length);
  padded.set(tx48, 1000);

  const rx = new RxEngine({
    sampleRate: 48000, pilotFreqHz: 1900, toneCount: 16, useOFDM: true,
  } as ConstructorParameters<typeof RxEngine>[0]);
  let received: Uint8Array | null = null;
  (rx as unknown as { scanner: { onFrame: (f: Uint8Array) => void } }).scanner.onFrame =
    (f: Uint8Array) => { received ??= f; };
  for (const s of padded) rx.feedSample(s);
  for (let i = 0; i < 5000; i++) rx.feedSample(0);
  expect(Array.from(received as Uint8Array)).toEqual(Array.from(frame));
});
```

If `resample` in `src/lib/math` is linear-interpolation (check before use):
acceptable here — at 2–3 kHz carriers the sinc² droop is < 1 dB and images
land above 4 kHz where no demod reads. If the test fails only from resampler
artifacts, upgrade `resample` to windowed-sinc as part of this task.

- [ ] **Step 2–4: Run → fix anything rate-coupled → PASS**
- [ ] **Step 5: Commit** — `test(modem): cross-rate 44.1k→48k decode proves device independence`

---

### Task 7: Hum immunity test

**Files:**
- Test: `src/modem/test/ofdm_native_rate.test.ts` (extend)

- [ ] **Step 1: Write the test**

```ts
test('50 Hz hum at high level neither triggers sync nor blocks decode', () => {
  const engine = new OFDMEngine({ sampleRate: 48000, toneCount: 16 });
  const frame = encodeFrame({ type: 0x01, seqNum: 0, totalFrames: 1, crc: 0 }, new Uint8Array(40));
  const sync = engine.generateSyncBurst(24);
  const data = engine.modulateFrame(frame);

  // 2 s of hum-only lead-in, then the burst riding on hum
  const lead = Math.round(48000 * 2);
  const total = lead + sync.length + data.length + 5000;
  const audio = new Float32Array(total);
  for (let n = 0; n < total; n++) audio[n] = 0.3 * Math.sin((2 * Math.PI * 50 * n) / 48000);
  for (let n = 0; n < sync.length; n++) audio[lead + n] += sync[n];
  for (let n = 0; n < data.length; n++) audio[lead + sync.length + n] += data[n];

  const rx = new RxEngine({
    sampleRate: 48000, pilotFreqHz: 1900, toneCount: 16, useOFDM: true,
  } as ConstructorParameters<typeof RxEngine>[0]);
  let received: Uint8Array | null = null;
  (rx as unknown as { scanner: { onFrame: (f: Uint8Array) => void } }).scanner.onFrame =
    (f: Uint8Array) => { received ??= f; };
  for (const s of audio) rx.feedSample(s);
  expect(Array.from(received as Uint8Array)).toEqual(Array.from(frame));
});
```

Detection energy is measured at the tone frequencies (≥2 kHz), so the hum
lead-in must not fire sync; if it does, the energy/sharpness gates regressed.

- [ ] **Step 2–4: Run → PASS** (any failure here is a real detection regression)
- [ ] **Step 5: Commit** — `test(modem): hum-immunity regression for OFDM sync`

---

### Task 8: Recorder — pass-through worklet mode

**Files:**
- Modify: `src/audio/recorder.ts`

**Interfaces:**
- Produces: `recorder.start(modemRate, onSample, deviceId?)` unchanged signature;
  when `modemRate === ctx.sampleRate` the worklet is constructed with
  `new AudioWorkletNode(ctx, 'recorder-processor', { processorOptions: { ratio: 1 } })`
  and forwards raw samples (no filter); when `modemRate === 3200` it uses
  `{ ratio: 15 }` with the existing sinc path (legacy BPSK).

Worklet changes: read `options.processorOptions.ratio` in the constructor;
`ratio === 1` branch bypasses history/filter entirely and posts input chunks
directly. Keep the 127-tap sinc for `ratio > 1`. `dlog('REC', …)` reports
`worklet: ratio === 1 ? 'native' : 'sinc127-v2'` and the rate.

- [ ] **Step 1: Manual pipe-verification plan (worklet is browser-only, not unit-testable in vitest):**
  after Task 9, the live single-frame test at 48 k IS the verification. For now: `npx tsc --noEmit` green.
- [ ] **Step 2: Implement**
- [ ] **Step 3: Commit** — `feat(audio): pass-through worklet mode for native-rate capture`

---

### Task 9: App plumbing — hardware rate through TX/RX

**Files:**
- Modify: `src/ui/app.ts`

Changes:
- Where listening starts (`startListening`, ~line 690): when `getState().useOFDM`,
  `const modemRate = audioCtx.sampleRate;` else `DEFAULT_CONFIG.sampleRate`.
  Pass `sampleRate: modemRate` in the worker `startListening` config and to
  `recorder.start(modemRate, …)`.
- Both send paths (`eardrop-send`, `eardrop-send-test`) and `sendSingleFrame`/
  `runCalOnly`: include `sampleRate: audioCtx.sampleRate` in the TxEngine /
  encoder-worker config when `useOFDM`, and `player.play(samples, thatRate, …)`.
- The shared AudioContext must be the same one recorder/player use (it already
  is — `this.ctx` is shared); read its `sampleRate` once at startup and
  `dlog('APP', { hwRate: audioCtx.sampleRate })`.

Verification: `npm run dev`, OFDM on, 16 tones, single-frame test. Healthy log:
`[REC] running=true worklet=native` at 48000, `[RX-OFDM] … sps=2160`,
`score` > 0.7, flat `h`, `[RX-FRAME] valid=true`.

- [ ] **Step 1: Implement**
- [ ] **Step 2: `npx tsc --noEmit` + full vitest suite green**
- [ ] **Step 3: Live browser check (dev server, console log via copy-log button)**
- [ ] **Step 4: Commit** — `feat(app): drive OFDM at hardware sample rate end to end`

---

### Task 10: UI defaults and bitrate readout

**Files:**
- Modify: `src/ui/MainApp.tsx`, `src/ui/Store.ts`

Changes:
- Pilot slider: range 500–4000, step 25, default 1900 when `useOFDM` (Store
  default stays for BPSK; on OFDM toggle, if pilot < 1500 set it to 1900 —
  mirror of the existing OFDM auto-restart subscription in app.ts).
- Tone count select for OFDM: options 8 / 16 / 32 (multiples of 4 enforced in engine already).
- Replace the static `symbolsPerSec` text for OFDM with a computed readout:
  `const symPerSec = 1000 / (OFDM_SYMBOL_MS + OFDM_CP_MS); const bps = toneCount * 2 * symPerSec;`
  displayed as `≈711 bit/s raw` (16 tones).
- PipelineStrip: no change (mode label already reads `useOFDM`).

- [ ] **Step 1: Implement**
- [ ] **Step 2: `npx tsc --noEmit` green; visual check on dev server (config tab)**
- [ ] **Step 3: Commit** — `feat(ui): native-rate OFDM defaults and live bitrate readout`

---

### Task 11: Docs

**Files:**
- Modify: `docs/MODEM.md` (OFDM section → time/Hz spec table from this plan's defaults),
  `STATE.md` (current state, thresholds, what's verified live vs in-memory),
  `docs/DEBUG-OUTPUT.md` (`RX-OFDM`/`OFDM-SYNC` fields now report Hz + sps per rate),
  `README.md` modem-specs table (sample rate row → "hardware rate (48/44.1 kHz)", throughput row).

- [ ] **Step 1: Update all four**
- [ ] **Step 2: Commit** — `docs: native-rate OFDM spec`

---

## Risks / open items

- **toneIQ phase convention** (Task 2 note) — pinned by test, one sign flip max.
- **CPU**: demod = (tones+1) × fftSamples × 22.2/s ≈ 0.75 M mult/s @16 tones — trivial.
  Alignment probe = symSamples × cpSamples × 3 ≈ 1.5 M one-shot — trivial.
- **Legacy BPSK**: untouched at 3200 via worklet ratio 15; its tests are the regression net.
- **`selectOFDMFFT` / old bin helpers** in `src/lib/math` become dead for OFDM — delete only
  if nothing else imports them (grep first), else leave.
- **Threshold re-baseline**: `ofdmSyncThreshold` floor may need lowering/raising at 48 k
  window sizes — the adaptive 3× floor makes this low-stakes; check in Task 9 live run.

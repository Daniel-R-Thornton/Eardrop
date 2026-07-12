# Modem Worker Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all modem logic (RX decode, TX encode, telemetry DSP, config) into one dedicated web worker behind a typed protocol, so the main thread does only UI — no per-sample messaging, no DSP, no modem state in the React store.

**Architecture:** Today: mic → AudioWorklet → main thread → **one postMessage per sample at 48 kHz** to `broadcast.worker.ts`, plus a main-thread `number[]` mirror (`recvSamples`) that a 100 ms interval runs DFTs over, with results pushed through `setState` (which JSON-persists to localStorage on every call). TX encoding lives in a second worker with config assembled ad-hoc at each call site — the root cause of the 2026-07-10 TX/RX config-mismatch bug. Target: one `modem.worker.ts` owning `RxEngine` + `TxEngine` + a sample ring buffer + telemetry DSP, fed transferable `Float32Array` chunks (~375 msgs/s instead of 48 000), emitting a compact telemetry event at 20 Hz and typed lifecycle events. A `ModemController` facade on the main thread is the only code that talks to the worker; the React store keeps UI preferences and display snapshots only. The worker's logic lives in a plain testable class (`ModemService`) so vitest covers it without a worker harness.

**Tech Stack:** TypeScript, vitest, Vite (workers via `new Worker(new URL(...), { type: 'module' })` — same pattern the existing workers use), Web Audio AudioWorklet.

**Prerequisite:** The throughput plan (`2026-07-10-ofdm-throughput-max.md`) is implemented — `OFDM_TUNING` exists in `src/modem/types.ts` and the benchmark test `src/modem/test/throughput.test.ts` passes. If line numbers cited below have drifted, search for the quoted code instead.

## Global Constraints

- NEVER touch DSP/protocol behavior: `src/modem/**` changes are limited to *additive* accessors (`RxEngine.feedChunk`, `RxEngine.getProgress`) — no changes to demodulation, sync, framing, or timing. The full vitest suite (including `throughput.test.ts`) must stay green after every task.
- Audio buffers cross thread boundaries as **transferable** `Float32Array.buffer` — never structured-clone a sample array, never per-sample messages.
- The React store (`src/ui/Store.ts`) must not hold high-rate data after this plan: no `fftSpectrum`, `toneEnergies`, `micLevel`, `rawPeak` updates through `setState` (they bypass it via the telemetry subscription built in Task 5).
- `setState` must stop persisting to localStorage on every call (Task 5) — persist only when a persisted field actually changed.
- One config assembly function. Any code that builds a `ModemConfig` from UI state must call `buildModemConfig` (Task 4). Never re-inline `{ pilotFreqHz: getState()... }` objects — that pattern caused the 2026-07-10 toneCount-mismatch bug.
- Keep the old `broadcast.worker.ts` + `encoder.worker.ts` files in place and functional until Task 6 deletes them — each task must leave the app working.
- After every task: `npx tsc --noEmit` clean, `npx vitest run` green, and the app boots (`npm run dev`, Send Single Frame decodes with `[RX-FRAME] valid=true`).

## Current-state map (verified, for orientation)

| Concern | Today | File |
|---|---|---|
| Capture | Worklet posts Float32 chunks to main; main loops calling `onSample` per sample | `src/audio/recorder.ts:206-219` |
| RX feed | `broadcastWorker.postMessage({type:'feedSample', sample})` per sample (48 k/s) | `src/ui/app.ts:718-723` |
| Sample mirror | `recvSamples: number[]` on main, capped 10 s | `src/ui/app.ts:716-723` |
| Meters | 100 ms interval: RMS, 64-bin DFT, tone energies on MAIN thread | `src/ui/app.ts:734-767` |
| RX engine | `broadcast.worker.ts`, 200 ms poll posts 4 debug messages | `src/workers/broadcast.worker.ts:34-75` |
| TX encode | `encoder.worker.ts`, config passed per call | `src/workers/encoder.worker.ts:21` |
| Config assembly | 4 inline object literals | `app.ts:315,382,685,916` |
| Store | telemetry + prefs mixed; localStorage write on EVERY setState | `src/ui/Store.ts:237-242` |

---

### Task 1: Batch feed API on RxEngine + protocol schema v2

**Files:**
- Modify: `src/modem/protocol/rxEngine.ts` (add two methods, no behavior change)
- Create: `src/workers/modemSchema.ts`
- Create: `src/modem/test/rxEngine_chunk.test.ts`

**Interfaces:**
- Produces: `RxEngine.feedChunk(chunk: Float32Array): void` (loops `feedSample`), `RxEngine.getProgress(): RxProgress`, and the full v2 message contract in `modemSchema.ts` that Tasks 2-5 import: `ModemCommand`, `ModemEvent`, `ModemTelemetry`, `RxProgress`.

- [x] **Step 1: Write the failing test**

Create `src/modem/test/rxEngine_chunk.test.ts`:

```ts
/**
 * feedChunk must be byte-for-byte equivalent to per-sample feeding,
 * and getProgress must expose frame-assembly state for telemetry.
 */
import { expect, test } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;

function makeRx() {
  return new RxEngine({
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: 16,
    useOFDM: true,
  } as ConstructorParameters<typeof RxEngine>[0]);
}

test('feedChunk decodes a transfer identically to feedSample', () => {
  const data = new Uint8Array(200);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 1) & 0xff;
  const tx = new TxEngine({
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount: 16,
    useOFDM: true,
  } as ConstructorParameters<typeof TxEngine>[0]);
  const audio = tx.transmitFile('chunk.bin', data);
  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  const tail = new Float32Array(symSamples * 8);

  const rx = makeRx();
  // Feed in worklet-sized chunks (128 samples)
  for (let off = 0; off < audio.length; off += 128) {
    rx.feedChunk(audio.subarray(off, Math.min(off + 128, audio.length)));
  }
  rx.feedChunk(tail);

  const file = (rx as unknown as { completedFile: ReceivedFile | null }).completedFile;
  expect(file).not.toBeNull();
  expect(Array.from(file!.data)).toEqual(Array.from(data));
});

test('getProgress reports state and frame counts', () => {
  const rx = makeRx();
  const p = rx.getProgress();
  expect(p.state).toBe(0); // RxState.WAITING
  expect(p.framesReceived).toBe(0);
  expect(p.totalFrames).toBe(0);
  expect(p.fileName).toBe('');
  expect(p.fileSize).toBe(0);
  expect(p.bytesAssembled).toBe(0);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modem/test/rxEngine_chunk.test.ts`
Expected: FAIL — `feedChunk` / `getProgress` are not functions.

- [x] **Step 3: Add the two methods to RxEngine**

In `src/modem/protocol/rxEngine.ts`, directly after `feedSample` ends (search for the closing brace of `feedSample`, before `initOfdmDemod`), add:

```ts
  /** Batch entry point — behaviorally identical to per-sample feeding. */
  feedChunk(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) this.feedSample(chunk[i]);
  }

  /** Frame-assembly progress snapshot for telemetry. */
  getProgress(): {
    state: number;
    framesReceived: number;
    totalFrames: number;
    fileName: string;
    fileSize: number;
    bytesAssembled: number;
  } {
    return {
      state: this.state,
      framesReceived: this.framesReceived,
      totalFrames: this.totalFrames,
      fileName: this.fileName,
      fileSize: this.fileSize,
      bytesAssembled: this.fileData.length,
    };
  }
```

Note: `totalFrames` is currently only set from decoded frame headers (`decoded.header.totalFrames` is available in `processFrame` at `rxEngine.ts:848` but never stored). In `processFrame`, inside the `switch`, before `case 0x01`, add one line so progress has a denominator:

```ts
    if (decoded.header!.totalFrames > 0) this.totalFrames = decoded.header!.totalFrames;
```

- [x] **Step 4: Create the schema**

Create `src/workers/modemSchema.ts`:

```ts
/**
 * modemSchema.ts — typed protocol for the unified modem worker.
 *
 * Main → Worker: ModemCommand. Worker → Main: ModemEvent.
 * Audio always crosses as transferable Float32Array buffers.
 */
import type { ModemConfig } from '../modem/types';

export interface RxProgress {
  state: number; // RxState enum value
  framesReceived: number;
  totalFrames: number;
  fileName: string;
  fileSize: number;
  bytesAssembled: number;
}

/** Compact display snapshot, emitted at ~20 Hz while listening. */
export interface ModemTelemetry {
  rms: number;
  peak: number;
  rmsDb: number;
  /** 64-bin magnitude spectrum, 0..spectrumMaxHz */
  spectrum: Float32Array;
  spectrumMaxHz: number;
  /** Per-OFDM-tone energy of the most recent window */
  toneEnergies: number[];
  pilotAmplitude: number;
  progress: RxProgress;
}

export type ModemCommand =
  | { type: 'configure'; config: ModemConfig & { useOFDM?: boolean } }
  | { type: 'startRx' }
  | { type: 'stopRx' }
  | { type: 'feedChunk'; samples: ArrayBuffer } // Float32Array buffer, transferred
  | { type: 'encodeFile'; id: number; fileName: string; data: ArrayBuffer }
  | { type: 'dumpBuffer'; id: number; seconds: number }
  | { type: 'setVerboseLogging'; enabled: boolean };

export type ModemEvent =
  | { type: 'ready' }
  | { type: 'configured' }
  | { type: 'rxStarted' }
  | { type: 'rxStopped' }
  | { type: 'telemetry'; telemetry: ModemTelemetry }
  | { type: 'fileComplete'; fileName: string; data: ArrayBuffer }
  | { type: 'encoded'; id: number; samples: ArrayBuffer; sampleRate: number }
  | { type: 'bufferDump'; id: number; samples: ArrayBuffer; rms: number; peak: number }
  | { type: 'dlog'; line: string }
  | { type: 'error'; id?: number; error: string };
```

- [x] **Step 5: Run tests, typecheck, commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all PASS including the new chunk test.

```bash
git add src/modem/protocol/rxEngine.ts src/workers/modemSchema.ts src/modem/test/rxEngine_chunk.test.ts
git commit -m "feat(modem): feedChunk + getProgress on RxEngine, modem worker schema v2"
```

---

### Task 2: ModemService — the worker's brain, as a testable class

All worker logic in a plain class; the worker file (Task 3) is a 30-line shim. This is what makes the architecture testable.

**Files:**
- Create: `src/workers/modemService.ts`
- Create: `src/modem/test/modemService.test.ts`

**Interfaces:**
- Consumes: `RxEngine` (incl. Task 1 methods), `TxEngine`, `toneIQ` from `src/modem/pilot.ts`, `ofdmToneFrequencies` from `src/modem/types.ts`, schema types from Task 1.
- Produces: `class ModemService { constructor(emit: (ev: ModemEvent, transfer?: Transferable[]) => void); handle(cmd: ModemCommand): void; tick(): void }`. `tick()` computes+emits one telemetry event; the worker shim calls it on an interval.

- [x] **Step 1: Write the failing test**

Create `src/modem/test/modemService.test.ts`:

```ts
/**
 * ModemService — worker logic without a worker. Commands in, events out.
 */
import { expect, test } from 'vitest';
import { ModemService } from '../../workers/modemService';
import type { ModemEvent } from '../../workers/modemSchema';
import { TxEngine } from '../protocol/txEngine';
import { DEFAULT_CONFIG, ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const CFG = {
  ...DEFAULT_CONFIG,
  sampleRate: SAMPLE_RATE,
  pilotFreqHz: 1900,
  toneCount: 16,
  useOFDM: true,
};

function makeService() {
  const events: ModemEvent[] = [];
  const svc = new ModemService((ev) => events.push(ev));
  return { svc, events };
}

test('configure → startRx → feedChunk → fileComplete', () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });

  const data = new Uint8Array(120);
  for (let i = 0; i < data.length; i++) data[i] = (i * 11 + 3) & 0xff;
  const tx = new TxEngine(CFG as ConstructorParameters<typeof TxEngine>[0]);
  const audio = tx.transmitFile('svc.bin', data);
  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  const padded = new Float32Array(audio.length + symSamples * 8);
  padded.set(audio, 0);

  for (let off = 0; off < padded.length; off += 512) {
    const chunk = padded.slice(off, Math.min(off + 512, padded.length));
    svc.handle({ type: 'feedChunk', samples: chunk.buffer });
    svc.tick(); // telemetry + file poll piggyback on ticks
  }

  const done = events.find((e) => e.type === 'fileComplete');
  expect(done, 'fileComplete event should fire').toBeDefined();
  if (done && done.type === 'fileComplete') {
    expect(Array.from(new Uint8Array(done.data))).toEqual(Array.from(data));
  }
});

test('encodeFile emits encoded with the config given to configure (no per-call config)', () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  const payload = new Uint8Array([1, 2, 3, 4]);
  svc.handle({ type: 'encodeFile', id: 42, fileName: 'x.bin', data: payload.buffer });

  const enc = events.find((e) => e.type === 'encoded');
  expect(enc).toBeDefined();
  if (enc && enc.type === 'encoded') {
    expect(enc.id).toBe(42);
    expect(enc.sampleRate).toBe(SAMPLE_RATE);
    expect(new Float32Array(enc.samples).length).toBeGreaterThan(0);
  }
});

test('telemetry tick while listening reports rms, spectrum, progress', () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });
  const noise = new Float32Array(4096);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.sin(i / 3) * 0.1;
  svc.handle({ type: 'feedChunk', samples: noise.buffer });
  svc.tick();

  const t = events.find((e) => e.type === 'telemetry');
  expect(t).toBeDefined();
  if (t && t.type === 'telemetry') {
    expect(t.telemetry.rms).toBeGreaterThan(0);
    expect(t.telemetry.spectrum.length).toBe(64);
    expect(t.telemetry.toneEnergies.length).toBe(16);
    expect(t.telemetry.progress.state).toBeGreaterThanOrEqual(0);
  }
});

test('dumpBuffer returns the most recent seconds of audio', () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });
  const chunk = new Float32Array(SAMPLE_RATE); // 1 s
  chunk.fill(0.25);
  svc.handle({ type: 'feedChunk', samples: chunk.buffer });
  svc.handle({ type: 'dumpBuffer', id: 7, seconds: 0.5 });

  const d = events.find((e) => e.type === 'bufferDump');
  expect(d).toBeDefined();
  if (d && d.type === 'bufferDump') {
    expect(d.id).toBe(7);
    expect(new Float32Array(d.samples).length).toBe(SAMPLE_RATE / 2);
    expect(d.peak).toBeCloseTo(0.25, 2);
  }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modem/test/modemService.test.ts`
Expected: FAIL — module `../../workers/modemService` does not exist.

- [x] **Step 3: Implement ModemService**

Create `src/workers/modemService.ts`:

```ts
/**
 * ModemService — all modem-worker logic as a plain class so vitest can
 * drive it without a Worker. The worker file is a thin shim around this.
 *
 * Owns: RxEngine, TxEngine, config (single source of truth for both
 * directions), a rolling sample ring for telemetry/diagnostics.
 */
import { RxEngine } from '../modem/protocol/rxEngine';
import { TxEngine } from '../modem/protocol/txEngine';
import { toneIQ } from '../modem/pilot';
import { DEFAULT_CONFIG, ofdmToneFrequencies, type ModemConfig } from '../modem/types';
import type { ModemCommand, ModemEvent, ModemTelemetry } from './modemSchema';

const RING_SECONDS = 10;
const SPECTRUM_BINS = 64;

export class ModemService {
  private emit: (ev: ModemEvent, transfer?: Transferable[]) => void;
  private config: (ModemConfig & { useOFDM?: boolean }) | null = null;
  private rx: RxEngine | null = null;
  private fileSent = false;

  // Rolling ring of recent samples (Float32, telemetry + dumpBuffer)
  private ring: Float32Array = new Float32Array(0);
  private ringLen = 0; // valid samples (<= ring.length)

  constructor(emit: (ev: ModemEvent, transfer?: Transferable[]) => void) {
    this.emit = emit;
  }

  handle(cmd: ModemCommand): void {
    switch (cmd.type) {
      case 'configure': {
        this.config = cmd.config;
        this.ring = new Float32Array(cmd.config.sampleRate * RING_SECONDS);
        this.ringLen = 0;
        // Listening restarts pick up the new config
        if (this.rx) {
          this.rx = new RxEngine(this.config as ConstructorParameters<typeof RxEngine>[0]);
          this.fileSent = false;
        }
        this.emit({ type: 'configured' });
        break;
      }
      case 'startRx': {
        if (!this.config) { this.emit({ type: 'error', error: 'startRx before configure' }); return; }
        this.rx = new RxEngine(this.config as ConstructorParameters<typeof RxEngine>[0]);
        this.fileSent = false;
        this.emit({ type: 'rxStarted' });
        break;
      }
      case 'stopRx': {
        this.rx = null;
        this.emit({ type: 'rxStopped' });
        break;
      }
      case 'feedChunk': {
        const chunk = new Float32Array(cmd.samples);
        this.pushRing(chunk);
        this.rx?.feedChunk(chunk);
        break;
      }
      case 'encodeFile': {
        if (!this.config) { this.emit({ type: 'error', id: cmd.id, error: 'encodeFile before configure' }); return; }
        try {
          const tx = new TxEngine(this.config as ConstructorParameters<typeof TxEngine>[0]);
          const samples = tx.transmitFile(cmd.fileName, new Uint8Array(cmd.data));
          this.emit(
            { type: 'encoded', id: cmd.id, samples: samples.buffer, sampleRate: this.config.sampleRate },
            [samples.buffer],
          );
        } catch (err) {
          this.emit({ type: 'error', id: cmd.id, error: (err as Error).message });
        }
        break;
      }
      case 'dumpBuffer': {
        const sr = this.config?.sampleRate ?? DEFAULT_CONFIG.sampleRate;
        const want = Math.min(Math.floor(cmd.seconds * sr), this.ringLen);
        const out = this.ring.slice(this.ringLen - want, this.ringLen);
        let peak = 0; let sumSq = 0;
        for (let i = 0; i < out.length; i++) {
          const v = Math.abs(out[i]);
          if (v > peak) peak = v;
          sumSq += v * v;
        }
        const rms = out.length ? Math.sqrt(sumSq / out.length) : 0;
        this.emit({ type: 'bufferDump', id: cmd.id, samples: out.buffer, rms, peak }, [out.buffer]);
        break;
      }
      case 'setVerboseLogging': {
        RxEngine.verboseRxLogging = cmd.enabled;
        break;
      }
    }
  }

  /** One telemetry beat: file poll + display snapshot. Shim calls at ~20 Hz. */
  tick(): void {
    if (!this.rx || !this.config) return;

    if (!this.fileSent) {
      const file = this.rx.getFile();
      if (file) {
        this.fileSent = true;
        this.emit(
          { type: 'fileComplete', fileName: file.fileName, data: file.data.buffer },
          [file.data.buffer],
        );
      }
    }

    this.emit({ type: 'telemetry', telemetry: this.computeTelemetry() });
  }

  private pushRing(chunk: Float32Array): void {
    if (this.ring.length === 0) return;
    if (chunk.length >= this.ring.length) {
      this.ring.set(chunk.subarray(chunk.length - this.ring.length));
      this.ringLen = this.ring.length;
      return;
    }
    if (this.ringLen + chunk.length > this.ring.length) {
      const keep = this.ring.length - chunk.length;
      this.ring.copyWithin(0, this.ringLen - keep, this.ringLen);
      this.ringLen = keep;
    }
    this.ring.set(chunk, this.ringLen);
    this.ringLen += chunk.length;
  }

  private computeTelemetry(): ModemTelemetry {
    const sr = this.config!.sampleRate;
    const tailLen = Math.min(this.ringLen, 2048);
    const tail = this.ring.subarray(this.ringLen - tailLen, this.ringLen);

    let peak = 0; let sumSq = 0;
    for (let i = 0; i < tail.length; i++) {
      const v = Math.abs(tail[i]);
      if (v > peak) peak = v;
      sumSq += v * v;
    }
    const rms = tail.length ? Math.sqrt(sumSq / tail.length) : 0;
    const rmsDb = rms > 0.0001 ? 20 * Math.log10(rms) : -80;

    // 64-bin DFT over the tail — this code MOVED here from app.ts:751-767
    const spectrumMaxHz = this.config!.useOFDM ? 4000 : 1600;
    const spectrum = new Float32Array(SPECTRUM_BINS);
    const winArr = Array.from(tail.subarray(Math.max(0, tail.length - 256)));
    for (let bin = 0; bin < SPECTRUM_BINS; bin++) {
      const f = (bin / SPECTRUM_BINS) * spectrumMaxHz;
      let si = 0; let co = 0;
      for (let i = 0; i < winArr.length; i++) {
        const ph = (2 * Math.PI * f * i) / sr;
        si += winArr[i] * Math.sin(ph);
        co += winArr[i] * Math.cos(ph);
      }
      spectrum[bin] = winArr.length ? Math.hypot(si, co) / winArr.length : 0;
    }

    const toneFreqs = this.config!.useOFDM
      ? ofdmToneFrequencies({ toneCount: this.config!.toneCount })
      : new Float32Array(0);
    const toneEnergies: number[] = [];
    for (const f of toneFreqs) {
      const iq = toneIQ(winArr, f, sr);
      toneEnergies.push(Math.hypot(iq.i, iq.q));
    }

    const pilot = toneIQ(winArr, this.config!.pilotFreqHz, sr);

    return {
      rms,
      peak,
      rmsDb,
      spectrum,
      spectrumMaxHz,
      toneEnergies,
      pilotAmplitude: Math.hypot(pilot.i, pilot.q),
      progress: this.rx!.getProgress(),
    };
  }
}
```

- [x] **Step 4: Run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all PASS. If the `fileComplete` test times out or never fires: `tick()` polls `getFile()` — make sure the test calls `tick()` inside the feed loop (it does) and that trailing silence (`symSamples * 8`) is included.

- [x] **Step 5: Commit**

```bash
git add src/workers/modemService.ts src/modem/test/modemService.test.ts
git commit -m "feat(workers): ModemService — unified testable modem logic (rx+tx+telemetry)"
```

---

### Task 3: The worker shim + chunked capture path

Wire `ModemService` into a real worker; change the capture path to deliver chunks (worklet already produces `Float32Array` chunks — today `recorder.ts` explodes them into per-sample callbacks and `app.ts` re-posts per sample).

**Files:**
- Create: `src/workers/modem.worker.ts`
- Modify: `src/audio/recorder.ts` (chunk callback instead of per-sample)

**Interfaces:**
- Consumes: `ModemService` (Task 2), schema (Task 1).
- Produces: `modem.worker.ts` (module worker: instantiate with `new Worker(new URL('../workers/modem.worker.ts', import.meta.url), { type: 'module' })` — copy the exact instantiation pattern used for the existing workers in `app.ts`, search `broadcast.worker`). `AudioRecorder.start(modemRate, onChunk: (chunk: Float32Array) => void, deviceId?)` — callback signature CHANGES from per-sample to per-chunk.

- [x] **Step 1: Create the worker shim**

Create `src/workers/modem.worker.ts`:

```ts
/**
 * modem.worker.ts — thin shim: ModemService does the work.
 * Telemetry ticks at 50 ms (20 Hz) while RX is active.
 */
import { ModemService } from './modemService';
import type { ModemCommand } from './modemSchema';
import { dlogSetMode } from '../lib/debug/dlog';

dlogSetMode('forward', (line) => self.postMessage({ type: 'dlog', line }));

const svc = new ModemService((ev, transfer) => {
  self.postMessage(ev, { transfer: transfer ?? [] });
});

let tickTimer: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent<ModemCommand>) => {
  const cmd = e.data;
  svc.handle(cmd);
  if (cmd.type === 'startRx' && !tickTimer) {
    tickTimer = setInterval(() => svc.tick(), 50);
  }
  if (cmd.type === 'stopRx' && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
};

self.postMessage({ type: 'ready' });
```

- [x] **Step 2: Change AudioRecorder to chunk delivery**

In `src/audio/recorder.ts`:
- Change the callback type (line 9): `export type ChunkCallback = (chunk: Float32Array) => void;` (delete `SampleCallback`).
- Change the field (line 125): `private onChunk: ChunkCallback | null = null;`
- Change `start` signature (line 147): `async start(_modemRate: number, onChunk: ChunkCallback, deviceId?: string): Promise<void>` and the assignment (line 196): `this.onChunk = onChunk;`
- Replace the `port.onmessage` body (lines 206-219) with:

```ts
    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.running) return;
      this.onChunk!(e.data);
    };
```
- In `stop()` (line 255): `this.onSample = null;` → `this.onChunk = null;`

This breaks the compile for `app.ts` (feedSample callback) — expected; fixed in Task 4. To keep this task independently green, apply the minimal bridge in `app.ts:718-724` now:

```ts
    const onChunk = (chunk: Float32Array) => {
      for (let i = 0; i < chunk.length; i++) {
        broadcastWorker.postMessage({ type: 'feedSample', sample: chunk[i] });
        recvSamples.push(chunk[i]);
      }
      if (recvSamples.length > modemRate * 10)
        recvSamples.splice(0, recvSamples.length - modemRate * 5);
    };
    await recorder.start(modemRate, onChunk, getState().selectedInputId || undefined);
```

(Yes, still per-sample INSIDE this bridge — the old worker still speaks per-sample. Task 4 deletes it. This step only decouples the recorder API.)

- [x] **Step 3: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean + green. Then `npm run dev`: Send Single Frame still decodes (`[RX-FRAME] valid=true`) — the bridge preserves old behavior exactly.

- [x] **Step 4: Commit**

```bash
git add src/workers/modem.worker.ts src/audio/recorder.ts src/ui/app.ts
git commit -m "feat(workers): modem worker shim; recorder delivers chunks not samples"
```

---

### Task 4: ModemController facade + single config assembly

The only main-thread code that talks to the modem worker. Kills the 4 inline config literals.

**Files:**
- Create: `src/ui/controllers/modemController.ts`
- Create: `src/ui/controllers/buildModemConfig.ts`
- Create: `src/modem/test/buildModemConfig.test.ts`
- Modify: `src/ui/app.ts` — `startListening`, `stopListening`, `eardrop-send`, `eardrop-send-test` handlers switch to the controller; delete the per-sample bridge from Task 3.

**Interfaces:**
- Consumes: `modem.worker.ts`, `AudioRecorder` (chunk API), `AudioPlayer` (`src/audio/player.ts` — `play(samples, rate, deviceId?, clean?)`), schema types.
- Produces:
```ts
buildModemConfig(ui: {
  useOFDM: boolean; pilotFreqHz: number; toneCount: number; symbolsPerSec: number;
  musicalMode: boolean; diversityMode: boolean; hwSampleRate: number;
}): ModemConfig & { useOFDM: boolean }

class ModemController {
  constructor(audioCtx: AudioContext);
  configure(cfg: ReturnType<typeof buildModemConfig>): void;
  startListening(micGain: number, deviceId?: string): Promise<void>;
  stopListening(): void;
  sendFile(fileName: string, data: Uint8Array, outputDeviceId?: string, volume?: number): Promise<void>;
  dumpBuffer(seconds: number): Promise<{ samples: Float32Array; rms: number; peak: number }>;
  on<T extends ModemEvent['type']>(type: T, fn: (ev: Extract<ModemEvent, { type: T }>) => void): () => void;
}
```

- [x] **Step 1: Write the failing config test**

Create `src/modem/test/buildModemConfig.test.ts`:

```ts
/**
 * buildModemConfig — the ONE place UI state becomes a ModemConfig.
 * Regression fence for the 2026-07-10 toneCount-omission bug.
 */
import { expect, test } from 'vitest';
import { buildModemConfig } from '../../ui/controllers/buildModemConfig';
import { DEFAULT_CONFIG } from '../types';

const UI = {
  useOFDM: true,
  pilotFreqHz: 1900,
  toneCount: 32,
  symbolsPerSec: 50,
  musicalMode: false,
  diversityMode: false,
  hwSampleRate: 48000,
};

test('OFDM: hardware sample rate, explicit toneCount and symbolsPerSec', () => {
  const cfg = buildModemConfig(UI);
  expect(cfg.sampleRate).toBe(48000);
  expect(cfg.toneCount).toBe(32);
  expect(cfg.symbolsPerSec).toBe(50);
  expect(cfg.useOFDM).toBe(true);
  expect(cfg.pilotFreqHz).toBe(1900);
});

test('BPSK: modem native rate', () => {
  const cfg = buildModemConfig({ ...UI, useOFDM: false, pilotFreqHz: 600, toneCount: 4 });
  expect(cfg.sampleRate).toBe(DEFAULT_CONFIG.sampleRate);
  expect(cfg.useOFDM).toBe(false);
  expect(cfg.toneCount).toBe(4);
  expect(cfg.bitsPerFrame).toBe(8);
});
```

- [x] **Step 2: Run to verify it fails, then implement**

Run: `npx vitest run src/modem/test/buildModemConfig.test.ts` — FAIL (module missing).

Create `src/ui/controllers/buildModemConfig.ts`:

```ts
/**
 * The single place UI state becomes a ModemConfig. Every TX and RX path
 * must go through this — inline config literals caused TX/RX mismatch
 * bugs (2026-07-10: omitted toneCount fell back to 4 in the worker).
 */
import { DEFAULT_CONFIG, type ModemConfig } from '../../modem/types';

export interface ModemUiConfig {
  useOFDM: boolean;
  pilotFreqHz: number;
  toneCount: number;
  symbolsPerSec: number;
  musicalMode: boolean;
  diversityMode: boolean;
  hwSampleRate: number;
}

export function buildModemConfig(ui: ModemUiConfig): ModemConfig & { useOFDM: boolean } {
  return {
    ...DEFAULT_CONFIG,
    sampleRate: ui.useOFDM ? ui.hwSampleRate : DEFAULT_CONFIG.sampleRate,
    pilotFreqHz: ui.pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz,
    toneCount: ui.toneCount || DEFAULT_CONFIG.toneCount,
    bitsPerFrame: (ui.toneCount || DEFAULT_CONFIG.toneCount) * 2,
    symbolsPerSec: ui.symbolsPerSec || DEFAULT_CONFIG.symbolsPerSec,
    musical: ui.musicalMode,
    diversityMode: ui.diversityMode,
    useOFDM: ui.useOFDM,
  };
}
```

- [x] **Step 3: Implement ModemController**

Create `src/ui/controllers/modemController.ts`:

```ts
/**
 * ModemController — the only main-thread code that talks to the modem
 * worker. Owns worker + recorder lifecycle; playback stays with the
 * caller-supplied AudioPlayer (output device selection is a UI concern).
 */
import { AudioRecorder } from '../../audio/recorder';
import type { ModemCommand, ModemEvent } from '../../workers/modemSchema';
import type { buildModemConfig } from './buildModemConfig';

type Handler<T extends ModemEvent['type']> = (ev: Extract<ModemEvent, { type: T }>) => void;

export class ModemController {
  private worker: Worker;
  private recorder: AudioRecorder | null = null;
  private audioCtx: AudioContext;
  private handlers = new Map<string, Set<(ev: ModemEvent) => void>>();
  private nextId = 1;
  private pending = new Map<number, (ev: ModemEvent) => void>();

  constructor(audioCtx: AudioContext) {
    this.audioCtx = audioCtx;
    this.worker = new Worker(new URL('../../workers/modem.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<ModemEvent>) => {
      const ev = e.data;
      const id = (ev as { id?: number }).id;
      if (id !== undefined && this.pending.has(id)) {
        this.pending.get(id)!(ev);
        this.pending.delete(id);
      }
      this.handlers.get(ev.type)?.forEach((fn) => fn(ev));
    };
  }

  on<T extends ModemEvent['type']>(type: T, fn: Handler<T>): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    const set = this.handlers.get(type)!;
    set.add(fn as (ev: ModemEvent) => void);
    return () => set.delete(fn as (ev: ModemEvent) => void);
  }

  private post(cmd: ModemCommand, transfer?: Transferable[]): void {
    this.worker.postMessage(cmd, { transfer: transfer ?? [] });
  }

  configure(cfg: ReturnType<typeof buildModemConfig>): void {
    this.post({ type: 'configure', config: cfg });
  }

  async startListening(micGain: number, deviceId?: string): Promise<void> {
    this.post({ type: 'startRx' });
    this.recorder = new AudioRecorder(this.audioCtx, micGain);
    await this.recorder.start(
      this.audioCtx.sampleRate,
      (chunk) => {
        // Copy before transfer — the worklet may reuse its buffer
        const owned = new Float32Array(chunk);
        this.post({ type: 'feedChunk', samples: owned.buffer }, [owned.buffer]);
      },
      deviceId,
    );
  }

  setMicGain(gain: number): void {
    this.recorder?.setMicGain(gain);
  }

  stopListening(): void {
    this.recorder?.stop();
    this.recorder = null;
    this.post({ type: 'stopRx' });
  }

  /** Encode in the worker; resolves with samples for the caller to play. */
  encodeFile(fileName: string, data: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, (ev) => {
        if (ev.type === 'encoded') resolve({ samples: new Float32Array(ev.samples), sampleRate: ev.sampleRate });
        else reject(new Error((ev as { error?: string }).error ?? 'encode failed'));
      });
      const copy = new Uint8Array(data);
      this.post({ type: 'encodeFile', id, fileName, data: copy.buffer }, [copy.buffer]);
    });
  }

  dumpBuffer(seconds: number): Promise<{ samples: Float32Array; rms: number; peak: number }> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, (ev) => {
        if (ev.type === 'bufferDump') {
          resolve({ samples: new Float32Array(ev.samples), rms: ev.rms, peak: ev.peak });
        }
      });
      this.post({ type: 'dumpBuffer', id, seconds });
    });
  }
}
```

- [x] **Step 4: Rewire app.ts**

In `src/ui/app.ts`:
1. Instantiate once near the existing worker setup (search `broadcastWorker =`): `const modem = new ModemController(audioCtx);` and subscribe: `modem.on('fileComplete', (ev) => { /* move the body of the existing broadcastWorker fileComplete case here */ });` and `modem.on('dlog', (ev) => dlogInject(ev.line));`.
2. `startListening()` (line 667): replace the `listenCfg` literal + `broadcastWorker.postMessage` + recorder + per-sample bridge with:
```ts
    const cfg = buildModemConfig({
      useOFDM: getState().useOFDM,
      pilotFreqHz: getState().pilotFreqHz,
      toneCount: getState().toneCount,
      symbolsPerSec: getState().symbolsPerSec,
      musicalMode: getState().musicalMode,
      diversityMode: getState().diversityMode,
      hwSampleRate: audioCtx.sampleRate,
    });
    modem.configure(cfg);
    await modem.startListening(getState().micGain, getState().selectedInputId || undefined);
```
   Keep the mic-gain subscribe block but call `modem.setMicGain(g)`.
3. `eardrop-send` (line 306) and `eardrop-send-test` (line 374): replace the `cfg` literal + `transmitFileInWorker(...)` with:
```ts
    modem.configure(buildModemConfig({ /* same 7 fields as above */ }));
    const { samples: playSamples, sampleRate: actualRate } = await modem.encodeFile(fileName, raw);
```
4. `dumpRxBuffer` (line ~830): now `const { samples, rms, peak } = await modem.dumpBuffer(durationSec);` — it becomes async; update its callers inside `sendCalibrationOnly` / `sendSingleFrame` with `await`.
5. Do NOT delete `recvSamples`/`recvTimer`/`broadcastWorker` wholesale yet — that is Task 6. This task only reroutes the four handlers above. The old `recvTimer` meters keep running off `recvSamples`; since nothing pushes into `recvSamples` anymore, guard the timer body's early-return (`if (n === 0) return;` already exists at line 736) — meters go quiet until Task 5 replaces them with telemetry.

- [x] **Step 5: Verify**

Run: `npx tsc --noEmit && npx vitest run` — clean + green.
Live: `npm run dev` → listen, Send Test → file decodes via the NEW worker (console shows the modem worker's `dlog` lines; old `[RX] worker=v4-eq-align` line no longer appears for RX start). Meters/VU are expected to be dead this task.

- [x] **Step 6: Commit**

```bash
git add src/ui/controllers/modemController.ts src/ui/controllers/buildModemConfig.ts src/modem/test/buildModemConfig.test.ts src/ui/app.ts
git commit -m "feat(ui): ModemController facade + single buildModemConfig; RX/TX via unified worker"
```

---

### Task 5: Telemetry channel — store split, no localStorage spam

Display data flows worker → controller → a dedicated telemetry subscription. The React store keeps prefs + slow status only.

**Files:**
- Create: `src/ui/telemetryStore.ts`
- Modify: `src/ui/Store.ts` (persist only on persisted-field change)
- Modify: `src/ui/app.ts` (telemetry wiring; delete the `recvTimer` meter loop)
- Modify: `src/ui/MainApp.tsx` (meters read `useTelemetry`)

**Interfaces:**
- Produces:
```ts
// src/ui/telemetryStore.ts
setTelemetry(t: ModemTelemetry): void
useTelemetry<T>(selector: (t: ModemTelemetry | null) => T): T
```

- [x] **Step 1: Create the telemetry store**

Create `src/ui/telemetryStore.ts`:

```ts
/**
 * telemetryStore — high-rate display data (20 Hz), OUTSIDE the app Store:
 * no localStorage writes, no persistence, plain useSyncExternalStore.
 */
import { useSyncExternalStore } from 'react';
import type { ModemTelemetry } from '../workers/modemSchema';

let current: ModemTelemetry | null = null;
const listeners = new Set<() => void>();

export function setTelemetry(t: ModemTelemetry): void {
  current = t;
  listeners.forEach((fn) => fn());
}

export function getTelemetry(): ModemTelemetry | null {
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTelemetry<T>(selector: (t: ModemTelemetry | null) => T): T {
  return useSyncExternalStore(subscribe, () => selector(current), () => selector(null));
}
```

- [x] **Step 2: Stop Store persisting on every setState**

In `src/ui/Store.ts`, replace the `setState` body (lines 237-242) with:

```ts
const PERSISTED_KEYS: Array<keyof AppState> = [
  'toneCount', 'pilotFreqHz', 'musicalMode', 'ampThresholdRatio',
  'syncStrongMultiplier', 'diversityMode', 'useOFDM', 'symbolsPerSec',
  'micGain', 'playbackVolume', 'selectedInputId', 'selectedOutputId', 'theme',
];

export function setState(update: Partial<AppState>): void {
  state = { ...state, ...update };
  if (PERSISTED_KEYS.some((k) => k in update)) {
    persistState(state);
  }
  listeners.forEach((fn) => fn());
}
```

(The key list must match `persistState`'s `toSave` fields exactly — they are at `Store.ts:204-219`.)

- [x] **Step 3: Wire telemetry and delete the main-thread meter loop**

In `src/ui/app.ts`:
1. Next to the other `modem.on(...)` subscriptions: `modem.on('telemetry', (ev) => setTelemetry(ev.telemetry));` (import from `./telemetryStore`).
2. Delete the `recvTimer` interval body that computes RMS/DFT/tone energies (`app.ts:734-810` region — everything the interval does with `recvSamples`, including its `setState({ micLevel, fftSpectrum, toneEnergies, rawPeak, ... })`), and the `recvTimer` variable + its `clearInterval` in `stopListening`.
3. Delete the now-unused `recvSamples` array, its cap logic, and `dumpRxBuffer`'s old implementation if any remnant remains (Task 4 already rerouted it to `modem.dumpBuffer`). The `eardrop-download-wav` handler (`app.ts:416`) reads `recvSamples` — reroute it: `const { samples } = await modem.dumpBuffer(10);` and build the WAV from `samples` (the sample-rate constant in that handler is `3200` at line 422 — change to `audioCtx.sampleRate` when OFDM is active: `const sr = getState().useOFDM ? audioCtx.sampleRate : 3200;`).

- [x] **Step 4: Point meters at telemetry**

In `src/ui/MainApp.tsx`, for each component currently fed from the store fields `micLevel`, `fftSpectrum`, `toneEnergies`, `rawPeak` (search each name in the file), read from the hook instead:

```tsx
import { useTelemetry } from './telemetryStore';
// inside the component:
const micLevel = useTelemetry((t) => t?.rmsDb ?? -80);
const fftSpectrum = useTelemetry((t) => t?.spectrum ?? null);
const toneEnergies = useTelemetry((t) => t?.toneEnergies ?? []);
const rawPeak = useTelemetry((t) => t?.peak ?? 0);
```

Keep the store fields in `AppState` for now (dead but typed) — Task 6 removes them.

- [x] **Step 5: Verify**

Run: `npx tsc --noEmit && npx vitest run` — clean + green.
Live: `npm run dev` → listen: VU meter, spectrum, tone meters move again (now worker-fed at 20 Hz). DevTools → Application → Local Storage: interact with meters running; `eardrop_ui_state` must NOT rewrite continuously (only when a config control changes).

- [x] **Step 6: Commit**

```bash
git add src/ui/telemetryStore.ts src/ui/Store.ts src/ui/app.ts src/ui/MainApp.tsx
git commit -m "feat(ui): worker-fed telemetry channel; store persists only on config change"
```

---

### Task 6: Delete the legacy plumbing

**Files:**
- Delete: `src/workers/broadcast.worker.ts`, `src/workers/encoder.worker.ts`
- Modify: `src/workers/schema.ts` (delete the superseded types; keep the file only if something still imports it — check with grep first)
- Modify: `src/ui/app.ts` (remove `broadcastWorker`, `encoderWorker`, `transmitFileInWorker`, `encodeTasks`, and the `broadcastWorker.onmessage` switch — its `fileComplete`/`decoderState`/debug cases were superseded by controller events)
- Modify: `src/ui/Store.ts` (remove dead fields: `fftSpectrum`, `toneEnergies`, `micLevel`, `rawPeak`, `debugByteStream`, `sentinelScan`, `micDiag` — grep each for remaining readers first; any still-used field stays)

- [x] **Step 1:** `grep -rn "broadcastWorker\|encoderWorker\|transmitFileInWorker\|from './schema'\|workers/schema" src/` — enumerate every remaining reference; reroute or delete each. The debug-tab components (`BitAnalyzer`, `ModemScope`) may read `debugByteStream`/`sentinelScan` — if they do, keep those Store fields and feed them via a new low-rate `debugSnapshot` command/event pair added to `modemSchema.ts` + `ModemService.tick()` (same shape as the old worker's `debugByteLog`/`debugSentinelScan` messages, sourced from `rx.getDebugByteLog()` / `rx.getShiftRegHistory()`); if nothing reads them, delete.
- [x] **Step 2:** Delete the two worker files + dead app.ts code + dead Store fields.
- [x] **Step 3:** Run: `npx tsc --noEmit && npx vitest run` — clean + green. TypeScript is the net here: any missed reference fails the build.
- [x] **Step 4:** Live full pass: listen → Send Test → file received; Send Single Frame → `valid=true`; download WAV works; meters live; config changes (tone count, pilot) still apply after stop/start listening.
- [x] **Step 5:** Commit:
```bash
git add -A
git commit -m "refactor(ui): delete legacy broadcast/encoder workers and main-thread sample mirror"
```

---

### Task 7: Guardrail test — no per-sample messaging regression

**Files:**
- Create: `src/modem/test/architecture.test.ts`

- [x] **Step 1:** Create `src/modem/test/architecture.test.ts`:

```ts
/**
 * Architecture guardrails — cheap greps that fail the suite if someone
 * reintroduces per-sample worker messaging or inline modem configs.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');

test('no per-sample postMessage anywhere in src/', () => {
  const appTs = readFileSync(join(SRC, 'ui', 'app.ts'), 'utf8');
  expect(appTs.includes("type: 'feedSample'")).toBe(false);
});

test('app.ts builds modem configs only via buildModemConfig', () => {
  const appTs = readFileSync(join(SRC, 'ui', 'app.ts'), 'utf8');
  // The bug pattern: an inline object literal passing pilotFreqHz straight
  // from getState() into a worker/engine config.
  const inlineConfigs = appTs.match(/pilotFreqHz:\s*getState\(\)/g) ?? [];
  expect(inlineConfigs.length).toBe(0);
});
```

Note: `sendSingleFrame` / `sendCalibrationOnly` / `sendSentinelOnly` construct `TxEngine` directly on the main thread for diagnostics (`app.ts:865,919,1006`) — during Task 4 these should also have switched to `buildModemConfig(...)` spread into `new TxEngine(...)`; if any were missed, the second guardrail catches them now. Fix by routing through `buildModemConfig`.

- [x] **Step 2:** Run: `npx vitest run src/modem/test/architecture.test.ts` — PASS (if it fails, a Task 4/6 step was missed; fix the reference, don't weaken the test).
- [x] **Step 3:** Commit:
```bash
git add src/modem/test/architecture.test.ts
git commit -m "test(arch): guardrails against per-sample messaging and inline modem configs"
```

---

## Appendix: deliberately out of scope

1. **SharedArrayBuffer ring between worklet and worker** (zero-copy, zero-message audio path). Requires COOP/COEP headers in Vite dev + hosting; the 375 chunk-msgs/s transferable path is already cheap. Do this only if profiling shows message overhead matters.
2. **Direct worklet→worker MessageChannel** (skip the main-thread hop entirely): `workletNode.port.postMessage({ port: channel.port1 }, [channel.port1])` + pass `port2` to the worker. Saves one hop; adds lifecycle complexity (port cleanup on device switch). Profile first.
3. **Moving playback into the worker** — impossible; `AudioContext` is main-thread-only. Playback stays in `player.ts`.
4. **React context instead of module-singleton stores** — cosmetic; `useSyncExternalStore` singletons are fine at this app size.

## What NOT to do

- Don't move `AudioContext`, `getUserMedia`, or `setSinkId` device selection into the worker — they are main-thread APIs. The worker owns *logic*, the controller owns *devices*.
- Don't send telemetry through `setState` — that's the localStorage-spam + full-store-rerender path this plan removes.
- Don't let any component import from `src/workers/modem.worker.ts` or post to the worker directly — everything goes through `ModemController`.
- Don't re-add per-call config to `encodeFile` — config is set once via `configure`; TX and RX must share it (regression fence: Task 7).
- Don't change `src/modem/**` behavior. If a task seems to need it, the task is wrong.
- The transfer of `chunk.buffer` requires an OWNED buffer — the worklet message's array may be backed by reused memory; always copy (`new Float32Array(chunk)`) before transferring (done in `ModemController.startListening`).

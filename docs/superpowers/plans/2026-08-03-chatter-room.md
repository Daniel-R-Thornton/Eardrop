# Chatter Room Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-device acoustic "room": devices join by announcing over the air, keep a member table, and any member broadcasts files to all others with per-transfer negotiated band/rate/gains.

**Architecture:** Half-duplex room protocol layered on the existing band-handshake path. Two new wire primitives (probe burst = down-chirp + coarse sweep + pulse-keyed ID; control message frames on the fixed OFDM_HANDSHAKE band). Pure state machine (`roomProtocol.ts`) + pure codecs, driven by an I/O shell controller; worker gains a chatter listen mode. File transfer itself is the existing band-card hop, unchanged.

**Tech Stack:** TypeScript, vitest, existing modem stack (`channelSweep`, `bch63`, `chirp`, TX/RX engines, `HandshakeReceiver`).

**Spec:** `docs/superpowers/specs/2026-08-03-chatter-room-design.md` — read it first.

## Global Constraints

- Branch: work directly on `band-handshake` (it has uncommitted in-flight work — NEVER `git add -A` / `git commit -a`; stage only the exact files your task touches).
- Wire constants are compatibility-critical once shipped: `REPORT_GRID` = 64 points, 100 Hz spacing, 1500–7800 Hz, 4 bits/point. Handshake band = `OFDM_HANDSHAKE` in `src/modem/types.ts` — do not modify it.
- Fixed handshake band carries all control traffic: 8 QPSK tones ⇒ 2 bytes/symbol, 20 ms/symbol at any rate.
- Existing behavior must not change when chatter mode is off: no edits to the flag-off TX waveform, `bandCard.ts`, or `HandshakeReceiver` semantics.
- All new pure logic gets vitest coverage; run `npx vitest run <file>` per task; `npm run lint` before each commit.
- Payload cap for control frames: 48 raw bytes.
- Device IDs: 1–255 (0 = broadcast address). Random per session.
- Tests live in `src/modem/test/` following existing naming (`bandCard.test.ts` style).

---

### Task 1: Probe burst codec (`probeBurst.ts`)

**Files:**
- Create: `src/modem/protocol/probeBurst.ts`
- Test: `src/modem/test/probeBurst.test.ts`

**Interfaces:**
- Consumes: `buildSweep`, `measureSweep`, `sampleResponseAt`, `SweepPlan`, `SweepResult` from `../diag/channelSweep`; `generateChirp`, `chirpCorrelate` from `./chirp`.
- Produces (later tasks import these exact names):

```ts
export const CHATTER_SWEEP = {
  startHz: 1500, endHz: 7800, stepHz: 100, stepMs: 45, amplitude: 0.02,
} as const; // ~2.9 s, coarse by design (band pick, not notch hunting)

export const REPORT_GRID = { startHz: 1500, stepHz: 100, points: 64 } as const;
export function reportGridFreqs(): number[]; // [1500, 1600, ..., 7800]

/** Down-chirp (4400→1200 Hz, 150 ms) — reversed direction vs the sync chirp so
 *  data-transmission chirps do not false-trigger probe detection. */
export function probeChirpTemplate(sampleRate: number): Float32Array;

export const PROBE_LAYOUT = {
  chirpMs: 150, gapMs: 50, idSlotMs: 40, idSlots: 12,
} as const;

/** silence(100ms) + downChirp + gap + sweep + gap + 12 pulse slots. */
export function buildProbeBurst(deviceId: number, sampleRate: number): Float32Array;

/** Total samples from chirp START to burst end (for RX buffering). */
export function probeBurstSamplesAfterChirp(sampleRate: number): number;

/** anchor = sample index where the chirp STARTS in `samples`.
 *  Returns null on CRC failure. */
export function decodeProbeId(samples: Float32Array, anchor: number, sampleRate: number): number | null;

/** Measure the burst's sweep, sampled onto REPORT_GRID (linear mags). */
export function measureProbeSweep(samples: Float32Array, anchor: number, sampleRate: number): number[] | null;

export function crc4(byte: number): number; // poly x^4+x+1 over the 8 id bits
```

- Layout offsets (all derived from `PROBE_LAYOUT` + `CHATTER_SWEEP`, in samples from anchor): chirp `[0, chirpMs)`, gap, sweep (`buildSweep` audio length), gap, then 12 slots. Slot k = 1 bit, MSB-first: bits 0–7 device ID, bits 8–11 `crc4(deviceId)`. Pulse = 25 ms raised-cosine-faded 2500 Hz tone centered in its 40 ms slot, amplitude 0.15; bit = 1 when slot RMS in a 2500 Hz Goertzel bin exceeds 4× the median of all 12 slots' bins (self-referencing threshold — no absolute level).

- [ ] **Step 1: Write failing tests**

```ts
// src/modem/test/probeBurst.test.ts
import { describe, expect, it } from 'vitest';
import {
  buildProbeBurst, decodeProbeId, measureProbeSweep,
  probeChirpTemplate, crc4, reportGridFreqs, REPORT_GRID,
} from '../protocol/probeBurst';
import { chirpCorrelate } from '../protocol/chirp';

const SR = 48000;

function findAnchor(burst: Float32Array): number {
  return chirpCorrelate(burst, probeChirpTemplate(SR)).peakIndex;
}

describe('probe burst', () => {
  it('round-trips the device ID', () => {
    const burst = buildProbeBurst(0xa7, SR);
    expect(decodeProbeId(burst, findAnchor(burst), SR)).toBe(0xa7);
  });

  it('decodes the ID under additive noise', () => {
    const burst = buildProbeBurst(42, SR);
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const noisy = burst.map((s) => s + (rnd() - 0.5) * 0.05);
    expect(decodeProbeId(noisy, findAnchor(noisy), SR)).toBe(42);
  });

  it('rejects a corrupted ID trailer via CRC', () => {
    const burst = buildProbeBurst(42, SR);
    const anchor = findAnchor(burst);
    // Zero out one ID slot → bit flips → CRC mismatch.
    const layoutEnd = burst.length;
    const slot0Start = layoutEnd - 12 * Math.round(0.04 * SR);
    for (let i = slot0Start; i < slot0Start + Math.round(0.04 * SR); i++) burst[i] = 0;
    expect(decodeProbeId(burst, anchor, SR)).toBeNull();
  });

  it('measures a flat channel as a flat report grid', () => {
    const burst = buildProbeBurst(1, SR);
    const grid = measureProbeSweep(burst, findAnchor(burst), SR)!;
    expect(grid).toHaveLength(REPORT_GRID.points);
    const max = Math.max(...grid), min = Math.min(...grid.filter((m) => m > 0));
    expect(max / min).toBeLessThan(3); // loopback ⇒ roughly flat
  });

  it('grid freqs span 1500-7800 at 100 Hz', () => {
    const f = reportGridFreqs();
    expect(f[0]).toBe(1500);
    expect(f[63]).toBe(7800);
  });

  it('crc4 detects single-bit id errors', () => {
    for (let bit = 0; bit < 8; bit++) expect(crc4(0x5a ^ (1 << bit))).not.toBe(crc4(0x5a));
  });
});
```

- [ ] **Step 2: Run tests, verify they fail** — `npx vitest run src/modem/test/probeBurst.test.ts`, expect module-not-found.
- [ ] **Step 3: Implement `probeBurst.ts`.** Build: concatenate silence, `generateChirp({fStart: 4400, fEnd: 1200, durationSec: 0.15, sampleRate, amplitude: 0.5})`, gap, `buildSweep({...CHATTER_SWEEP, sampleRate}).audio`, gap, pulse slots. Decode ID: Goertzel magnitude at 2500 Hz per slot window, threshold = 4× median. Measure: slice from sweep offset, `measureSweep(slice, plan)` then `sampleResponseAt(result, reportGridFreqs())`; return null when `result.failed`.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git add src/modem/protocol/probeBurst.ts src/modem/test/probeBurst.test.ts && git commit -m "feat(chatter): probe burst codec (down-chirp + sweep + pulsed ID)"`

---

### Task 2: Control message frames (`controlFrame.ts`)

**Files:**
- Create: `src/modem/protocol/controlFrame.ts`
- Test: `src/modem/test/controlFrame.test.ts`

**Interfaces:**
- Consumes: `bch63Encode`, `bch63Decode` from `../ecc/bch63`; `SENTINEL_BYTES`, `SENTINEL_SIZE`, `BCH_HEADER_SIZE` from `./atomicFrame`; `crc32` from `../../lib/crc` (use low 16 bits as CRC-16).
- Produces:

```ts
export const CONTROL_MAGIC = 0xc7;
export enum ControlType { Welcome = 1, Report = 2, FileComing = 3, Bye = 4 }

export interface ControlMessage {
  type: ControlType;
  senderId: number;   // 1-255
  targetId: number;   // 0 = broadcast
  payload: Uint8Array; // 0-48 raw bytes
}

export const CONTROL_HEADER_WIRE = SENTINEL_SIZE + BCH_HEADER_SIZE; // 27
/** Wire bytes of the BCH-coded payload for a given raw payload length. */
export function controlPayloadWireSize(payloadLen: number): number; // ceil((len+2)/3)*8
export function encodeControlMessage(msg: ControlMessage): Uint8Array;
/** header24 = the 24 post-sentinel header bytes. Null unless magic+CRC valid. */
export function decodeControlHeader(header24: Uint8Array):
  { type: ControlType; senderId: number; targetId: number; payloadLen: number } | null;
export function decodeControlPayload(wire: Uint8Array, payloadLen: number): Uint8Array | null;

// ---- payload codecs ----
export interface BestRangeClaim { lowHz: number; highHz: number; maxQamOrder: number }
export interface WelcomePayload { claim: BestRangeClaim; grid: number[] } // grid: 64 linear mags
export interface FileComingPayload {
  pilotFreqHz: number; toneStartHz: number; toneCount: number;
  settleSymbols: number; fileBytes: number; durationMs: number;
}
export function packWelcome(p: WelcomePayload): Uint8Array;   // 3 + 32 = 35 B
export function parseWelcome(b: Uint8Array): WelcomePayload | null;
export function packReport(grid: number[]): Uint8Array;        // 32 B
export function parseReport(b: Uint8Array): number[] | null;   // linear mags on REPORT_GRID
export function packFileComing(p: FileComingPayload): Uint8Array; // 12 B
export function parseFileComing(b: Uint8Array): FileComingPayload | null;
/** 4-bit grid quantization: dB below the grid's max, 2 dB steps, clamped 0-15
 *  (15 = -30 dB or silence). Exported for settingsPick + tests. */
export function quantizeGrid(linearMags: number[]): number[];   // 64 values 0-15
export function dequantizeGrid(q: number[]): number[];          // relative linear mags (max=1)
```

- Header raw 9 B (BCH-chunked exactly like `bandCard.ts` lines 93–104): `[0]=CONTROL_MAGIC, [1]=type, [2]=senderId, [3]=targetId, [4]=payloadLen, [5]=crc8(bytes 0-4), [6-8]=0`. Copy the `crc8` helper from `bandCard.ts` (private there; duplicate the 10-line function, do not export from bandCard).
- Payload wire: append CRC-16 (low 16 bits of `crc32`) to raw payload, chunk into 3-byte groups, `bch63Encode` each (same 4th-byte caveat as the header), 8 B per codeword.
- `packWelcome`/`packReport` grids: `quantizeGrid` then pack two 4-bit values per byte, high nibble first.
- Claim coding: `lowHz/50` and `highHz/50` as bytes (bin-coded like the band card), `maxQamOrder` as one byte (2/4/6 bits-per-symbol value).
- `packFileComing`: bytes = pilotBin(1), startBin(1), toneCountCode(1, index into `BAND_CARD_TONE_COUNTS`), settle(1), fileBytes u32 LE (4), durationMs u32 LE (4).

- [ ] **Step 1: Write failing tests**

```ts
// src/modem/test/controlFrame.test.ts
import { describe, expect, it } from 'vitest';
import {
  encodeControlMessage, decodeControlHeader, decodeControlPayload,
  packWelcome, parseWelcome, packReport, parseReport,
  packFileComing, parseFileComing, quantizeGrid, dequantizeGrid,
  ControlType, CONTROL_HEADER_WIRE, controlPayloadWireSize,
} from '../protocol/controlFrame';
import { SENTINEL_SIZE } from '../protocol/atomicFrame';

const grid64 = Array.from({ length: 64 }, (_, i) => 1 / (1 + i / 16)); // sloped response

describe('control frame', () => {
  it('round-trips a REPORT message', () => {
    const msg = { type: ControlType.Report, senderId: 7, targetId: 3, payload: packReport(grid64) };
    const wire = encodeControlMessage(msg);
    const hdr = decodeControlHeader(wire.slice(SENTINEL_SIZE, CONTROL_HEADER_WIRE))!;
    expect(hdr).toMatchObject({ type: ControlType.Report, senderId: 7, targetId: 3 });
    const payload = decodeControlPayload(wire.slice(CONTROL_HEADER_WIRE), hdr.payloadLen)!;
    const back = parseReport(payload)!;
    // Quantized to 2 dB steps — allow one step of error.
    back.forEach((m, i) => {
      const wantDb = 20 * Math.log10(grid64[i] / Math.max(...grid64));
      expect(Math.abs(20 * Math.log10(m) - wantDb)).toBeLessThanOrEqual(2.01);
    });
  });

  it('survives 3 corrupted wire bytes in the payload (BCH corrects)', () => {
    const msg = { type: ControlType.Report, senderId: 1, targetId: 0, payload: packReport(grid64) };
    const wire = encodeControlMessage(msg);
    // one bit flip in three DIFFERENT codewords
    wire[CONTROL_HEADER_WIRE + 1] ^= 0x01;
    wire[CONTROL_HEADER_WIRE + 9] ^= 0x80;
    wire[CONTROL_HEADER_WIRE + 17] ^= 0x10;
    const hdr = decodeControlHeader(wire.slice(SENTINEL_SIZE, CONTROL_HEADER_WIRE))!;
    expect(decodeControlPayload(wire.slice(CONTROL_HEADER_WIRE), hdr.payloadLen)).not.toBeNull();
  });

  it('rejects wrong magic', () => {
    const msg = { type: ControlType.Bye, senderId: 1, targetId: 0, payload: new Uint8Array(0) };
    const wire = encodeControlMessage(msg);
    // Re-encode header with corrupted magic is awkward; instead hand a bandCard-style header.
    const bogus = new Uint8Array(24); // BCH of zeros ≠ valid card either
    expect(decodeControlHeader(bogus)).toBeNull();
  });

  it('round-trips WELCOME (claim + grid)', () => {
    const p = { claim: { lowHz: 2000, highHz: 6000, maxQamOrder: 4 }, grid: grid64 };
    const back = parseWelcome(packWelcome(p))!;
    expect(back.claim).toEqual(p.claim);
    expect(back.grid).toHaveLength(64);
  });

  it('round-trips FILE_COMING', () => {
    const p = { pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 123456, durationMs: 42000 };
    expect(parseFileComing(packFileComing(p))).toEqual(p);
  });

  it('quantize/dequantize is monotone and bounded', () => {
    const q = quantizeGrid(grid64);
    expect(Math.min(...q)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...q)).toBeLessThanOrEqual(15);
    expect(q[0]).toBeLessThanOrEqual(q[63]); // grid64 decreasing ⇒ steps below max increase
  });

  it('payload wire size formula matches encoder output', () => {
    const msg = { type: ControlType.Welcome, senderId: 2, targetId: 5, payload: packWelcome({ claim: { lowHz: 1500, highHz: 7800, maxQamOrder: 6 }, grid: grid64 }) };
    const wire = encodeControlMessage(msg);
    expect(wire.length).toBe(CONTROL_HEADER_WIRE + controlPayloadWireSize(msg.payload.length));
  });
});
```

- [ ] **Step 2: Run tests, verify fail** — `npx vitest run src/modem/test/controlFrame.test.ts`
- [ ] **Step 3: Implement `controlFrame.ts`** per the interface block above. Mirror `bandCard.ts` structure and comment style.
- [ ] **Step 4: Run tests, verify pass.**
- [ ] **Step 5: Commit** — `git add src/modem/protocol/controlFrame.ts src/modem/test/controlFrame.test.ts && git commit -m "feat(chatter): control message frames on the handshake band"`

---

### Task 3: Settings intersection (`settingsPick.ts`)

**Files:**
- Create: `src/modem/chatter/settingsPick.ts`
- Test: `src/modem/test/settingsPick.test.ts`

**Interfaces:**
- Consumes: `REPORT_GRID`, `reportGridFreqs` from `../protocol/probeBurst`; `BAND_CARD_TONE_COUNTS` from `../protocol/bandCard`.
- Produces:

```ts
export interface PeerReport { deviceId: number; grid: number[] } // linear mags, REPORT_GRID
export interface PickedSettings {
  pilotFreqHz: number; toneStartHz: number; toneCount: number;
  /** bits/symbol per tone: 2 | 4 | 6, length = toneCount */
  qamMap: number[];
  /** linear per-tone TX gains, length = toneCount, max 1 */
  toneGains: number[];
  /** true when no band cleared the threshold and the worst-case floor was used */
  floor: boolean;
}
/** Worst-case floor: QPSK, 4 tones, right where the handshake band already
 *  proved itself. */
export const FLOOR_SETTINGS: PickedSettings;
export function pickSettings(reports: PeerReport[]): PickedSettings;
```

- Algorithm (document in the file header):
  1. Worst-peer grid: per grid point, min linear mag across all reports (normalize each report to its own max first — absolute levels differ per mic).
  2. Candidate bands: for each `toneCount` in `[32, 16, 8, 4]` (prefer wide) slide a window of `toneCount × 50 Hz` across 1500–7800 in 100 Hz steps; band score = worst grid point inside the window (grid is 100 Hz, tones 50 Hz — nearest-point lookup is fine at this resolution).
  3. Accept the first (widest) toneCount that has any window whose worst point is above `-18 dB` relative to the worst-peer grid's max; pick that window's best-scoring position. Nothing clears ⇒ return `FLOOR_SETTINGS` with `floor: true`.
  4. `toneStartHz` = window start; `pilotFreqHz` = window start − 100 Hz (clamped ≥ 1500 — pilot sits just below the tones, same convention as `OFDM_DEFAULTS`).
  5. `toneGains[i]` = `1 / relativeMag(tone i)` normalized so `max(toneGains) === 1` (attenuate strong tones, never boost above unity — TX headroom).
  6. `qamMap[i]` from margin: relative dB at tone ≥ −6 → 6 bits; ≥ −12 → 4; else 2.

- [ ] **Step 1: Write failing tests**

```ts
// src/modem/test/settingsPick.test.ts
import { describe, expect, it } from 'vitest';
import { pickSettings, FLOOR_SETTINGS } from '../chatter/settingsPick';
import { reportGridFreqs } from '../protocol/probeBurst';

const freqs = reportGridFreqs();
const gridWhere = (fn: (hz: number) => number) => freqs.map(fn);

describe('settingsPick', () => {
  it('one strong flat peer → widest band, dense QAM', () => {
    const s = pickSettings([{ deviceId: 1, grid: gridWhere(() => 1) }]);
    expect(s.floor).toBe(false);
    expect(s.toneCount).toBe(32);
    expect(s.qamMap.every((q) => q === 6)).toBe(true);
  });

  it('a deaf-above-4kHz peer forces the band low for everyone', () => {
    const strong = { deviceId: 1, grid: gridWhere(() => 1) };
    const lowOnly = { deviceId: 2, grid: gridWhere((hz) => (hz < 4000 ? 1 : 0.001)) };
    const s = pickSettings([strong, lowOnly]);
    expect(s.floor).toBe(false);
    expect(s.toneStartHz + s.toneCount * 50).toBeLessThanOrEqual(4000 + 100);
  });

  it('disjoint peers → floor settings', () => {
    const lowOnly = { deviceId: 1, grid: gridWhere((hz) => (hz < 2500 ? 1 : 1e-4)) };
    const highOnly = { deviceId: 2, grid: gridWhere((hz) => (hz > 6500 ? 1 : 1e-4)) };
    const s = pickSettings([lowOnly, highOnly]);
    expect(s.floor).toBe(true);
    expect(s).toMatchObject({ toneCount: FLOOR_SETTINGS.toneCount });
  });

  it('gains attenuate strong tones, never exceed 1', () => {
    const tilted = { deviceId: 1, grid: gridWhere((hz) => 1 / (1 + hz / 2000)) };
    const s = pickSettings([tilted]);
    expect(Math.max(...s.toneGains)).toBeCloseTo(1, 5);
    expect(Math.min(...s.toneGains)).toBeGreaterThan(0);
  });

  it('zero reports → floor', () => {
    expect(pickSettings([]).floor).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run src/modem/test/settingsPick.test.ts`
- [ ] **Step 3: Implement.** Pure math, no I/O. ~120 lines.
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git add src/modem/chatter/settingsPick.ts src/modem/test/settingsPick.test.ts && git commit -m "feat(chatter): worst-peer settings intersection with QPSK floor"`

---

### Task 4: Room state machine (`roomProtocol.ts`)

**Files:**
- Create: `src/modem/chatter/roomProtocol.ts`
- Test: `src/modem/test/roomProtocol.test.ts`

**Interfaces:**
- Consumes: types only — `ControlMessage`, `ControlType`, `WelcomePayload`, `FileComingPayload`, pack/parse fns from `../protocol/controlFrame`; `PeerReport`, `PickedSettings`, `pickSettings` from `./settingsPick`.
- Produces:

```ts
export type RoomState =
  | 'cold' | 'listening' | 'announcing' | 'joinWait'
  | 'idle' | 'rollCall' | 'collecting' | 'sending' | 'receiving';

export interface Member {
  deviceId: number;
  lastHeardMs: number;
  claim?: BestRangeClaim;
  /** what THIS device heard of the member's last probe (REPORT_GRID mags) */
  heardGrid?: number[];
}

export interface RoomDeps {
  deviceId: number;
  now(): number;                      // ms, monotonic
  rng(): number;                      // [0,1)
  schedule(fn: () => void, delayMs: number): () => void; // returns cancel
  /** Play the probe burst; resolves when playback finishes. */
  playProbe(): Promise<void>;
  /** Encode + play a control message; resolves when playback finishes. */
  sendMessage(msg: ControlMessage): Promise<void>;
  /** Band RMS check — true = someone is talking. */
  isAirBusy(): Promise<boolean>;
  /** Begin the file transmission with negotiated settings. */
  startFileTx(settings: PickedSettings): void;
  /** Arm the receive path (HandshakeReceiver) for an incoming transfer. */
  armFileRx(info: FileComingPayload): void;
  onStateChange?(state: RoomState, members: Member[]): void;
}

export const ROOM_TIMING = {
  listenMs: 1000, listenCapMs: 10000,
  replySlotMs: 1000, replySlots: 6,          // JOIN_WAIT and COLLECT both
  collectExtraMs: 500,
  fileComingLeadMs: 700,
} as const;

export class RoomProtocol {
  constructor(deps: RoomDeps);
  readonly state: RoomState;
  readonly members: Map<number, Member>;
  /** join the room (from cold) */
  start(): void;
  /** leave: cancels timers, best-effort BYE, back to cold */
  stop(): void;
  /** user dropped a file; size+duration go into FILE_COMING */
  sendFile(fileBytes: number, durationMs: number): void;
  /** worker heard a probe: id + measured grid */
  onProbeHeard(deviceId: number, grid: number[]): void;
  /** worker decoded a control message */
  onMessage(msg: ControlMessage): void;
}
```

- Behavior (from the spec — implement exactly):
  - `start()`: `listening` for `listenMs`; extend while `isAirBusy()` up to `listenCapMs`; then `announcing` (playProbe), then `joinWait` for `replySlots × replySlotMs`; collect `WELCOME`s into `members`; then `idle`.
  - Hearing a probe while `idle`: record/refresh member, then reply. Reply slot: `floor(rng()*replySlots)`; at slot start check `isAirBusy()` — busy ⇒ re-roll among remaining later slots (give up if none left). Reply is `WELCOME` (targetId = prober) carrying `packWelcome({claim, grid: heardGrid})`. If the probe arrives in `joinWait`/`collecting`, treat as roll-call reply duty too? No — a probe during those states just refreshes the member table (only one talker at a time is legal; simultaneous announce = collision, both retry naturally at roll-call time).
  - `sendFile()`: from `idle` only (else queue one deep). Carrier-sense like join, `playProbe()` (`rollCall`), then `collecting` for `replySlots × replySlotMs + collectExtraMs`; gather `REPORT` payloads addressed to us (`targetId === deviceId`); then `pickSettings`, `sendMessage(FILE_COMING broadcast)`, wait `fileComingLeadMs`, `startFileTx(settings)` → `sending`. Zero reports ⇒ back to `idle`, `onStateChange` still fires (UI surfaces "nobody home") — expose via a `lastError` field on the instance: `readonly lastError: string | null`.
  - `onMessage(FILE_COMING)` while `idle`/`joinWait`: `armFileRx(parsed)`, state `receiving`, schedule return to `idle` after `durationMs + 5000`.
  - `WELCOME` addressed to us updates `members` (claim + the grid the peer heard of us — store as `member.claim`; the heard-of-us grid is informational v1, keep it on the member as `theirViewOfUs?: number[]`).
  - Every non-idle state schedules a deadline back to `idle` (or `cold` from pre-join states). `stop()` cancels all timers.
  - Member aging is the UI's problem — protocol never evicts.

- [ ] **Step 1: Write failing tests** — deterministic deps harness:

```ts
// src/modem/test/roomProtocol.test.ts
import { describe, expect, it } from 'vitest';
import { RoomProtocol, ROOM_TIMING } from '../chatter/roomProtocol';
import { ControlType, packReport, packWelcome, packFileComing } from '../protocol/controlFrame';

/** Manual clock + timer wheel so every test is deterministic. */
function makeHarness(deviceId: number, opts: { busy?: () => boolean } = {}) {
  let t = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const sent: any[] = [];
  const calls: string[] = [];
  const deps = {
    deviceId,
    now: () => t,
    rng: () => 0, // slot 0 always — collisions forced by `busy`
    schedule: (fn: () => void, d: number) => {
      const rec = { at: t + d, fn, dead: false };
      timers.push(rec);
      return () => { rec.dead = true; };
    },
    playProbe: async () => { calls.push('probe'); },
    sendMessage: async (m: any) => { sent.push(m); },
    isAirBusy: async () => opts.busy?.() ?? false,
    startFileTx: () => calls.push('fileTx'),
    armFileRx: () => calls.push('fileRx'),
  };
  const room = new RoomProtocol(deps as any);
  /** advance the clock, firing due timers in order */
  const tick = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
      await Promise.resolve(); await Promise.resolve(); // drain microtasks
    }
    t = end;
  };
  return { room, tick, sent, calls };
}

const flatGrid = Array.from({ length: 64 }, () => 1);

describe('room protocol', () => {
  it('joins an empty room: listen → announce → joinWait → idle', async () => {
    const h = makeHarness(1);
    h.room.start();
    expect(h.room.state).toBe('listening');
    await h.tick(ROOM_TIMING.listenMs + 50);
    expect(h.calls).toContain('probe');
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 100);
    expect(h.room.state).toBe('idle');
    expect(h.room.members.size).toBe(0);
  });

  it('member replies WELCOME when it hears a probe', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    h.room.onProbeHeard(9, flatGrid);
    await h.tick(ROOM_TIMING.replySlotMs + 100); // slot 0 fires
    const welcome = h.sent.find((m) => m.type === ControlType.Welcome);
    expect(welcome).toBeDefined();
    expect(welcome.targetId).toBe(9);
    expect(h.room.members.get(9)).toBeDefined();
  });

  it('re-rolls the reply slot when the air is busy', async () => {
    let busy = true;
    const h = makeHarness(2, { busy: () => busy });
    h.room.start();
    // air busy: listening extends, then cap forces announce
    await h.tick(ROOM_TIMING.listenCapMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 500);
    expect(h.room.state).toBe('idle');
    h.room.onProbeHeard(9, flatGrid);
    await h.tick(ROOM_TIMING.replySlotMs + 50); // slot 0 blocked
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
    busy = false;
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('roll call with one report → FILE_COMING + startFileTx', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + 100); // carrier-sense + probe
    h.room.onMessage({ type: ControlType.Report, senderId: 5, targetId: 1, payload: packReport(flatGrid) });
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200);
    expect(h.sent.some((m) => m.type === ControlType.FileComing)).toBe(true);
    expect(h.calls).toContain('fileTx');
    expect(h.room.state).toBe('sending');
  });

  it('roll call with zero reports aborts to idle with lastError', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    h.room.sendFile(1000, 30000);
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 500);
    expect(h.calls).not.toContain('fileTx');
    expect(h.room.state).toBe('idle');
    expect(h.room.lastError).toMatch(/no.*report|nobody/i);
  });

  it('FILE_COMING while idle arms RX and times back out to idle', async () => {
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    h.room.onMessage({
      type: ControlType.FileComing, senderId: 8, targetId: 0,
      payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
    });
    expect(h.calls).toContain('fileRx');
    expect(h.room.state).toBe('receiving');
    await h.tick(2000 + 5000 + 100);
    expect(h.room.state).toBe('idle');
  });

  it('stop() from any state cancels timers and goes cold', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 10);
    h.room.stop();
    expect(h.room.state).toBe('cold');
    await h.tick(60000); // nothing should fire/throw
    expect(h.room.state).toBe('cold');
  });
});
```

- [ ] **Step 2: Run, verify fail.** `npx vitest run src/modem/test/roomProtocol.test.ts`
- [ ] **Step 3: Implement `roomProtocol.ts`.** Single class, private `setState`, one `pendingTimers: Set<() => void>` so `stop()` cancels everything. Async deps awaited inside timer callbacks; guard every callback with a state check (a stale timer firing after a transition must be a no-op).
- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git add src/modem/chatter/roomProtocol.ts src/modem/test/roomProtocol.test.ts && git commit -m "feat(chatter): room state machine (join/welcome/rollcall/send/receive)"`

---

### Task 5: Worker chatter mode (schema + service + listen path)

**Files:**
- Modify: `src/workers/modemSchema.ts` (new commands/events)
- Modify: `src/workers/modemService.ts` (chatter listener, probe detection, control encode, air check, RX mute)
- Modify: `src/modem/protocol/rxEngine.ts` (add `onControlMessage` beside `onBandCard` in bandHandshake mode)
- Test: `src/modem/test/chatterWorker.test.ts`

**Interfaces:**
- Consumes: Task 1 (`probeChirpTemplate`, `probeBurstSamplesAfterChirp`, `decodeProbeId`, `measureProbeSweep`, `buildProbeBurst`), Task 2 (`encodeControlMessage`, `decodeControlHeader`, `decodeControlPayload`, `CONTROL_MAGIC`, `ControlMessage`, `controlPayloadWireSize`).
- Produces — schema additions (exact):

```ts
// ModemCommand additions
  | { type: 'chatterStart'; deviceId: number }
  | { type: 'chatterStop' }
  | { type: 'encodeControl'; id: number; msg: { type: number; senderId: number; targetId: number; payload: ArrayBuffer } }
  | { type: 'encodeProbe'; id: number; deviceId: number }
  | { type: 'airCheck'; id: number }
  | { type: 'setRxMuted'; muted: boolean }
// ModemEvent additions
  | { type: 'probeHeard'; deviceId: number; grid: number[] }
  | { type: 'controlMessage'; msg: { type: number; senderId: number; targetId: number; payload: ArrayBuffer } }
  | { type: 'airStatus'; id: number; busy: boolean; rms: number }
```

- Worker behavior:
  - `chatterStart`: create the chatter listener — an `RxEngine` in `bandHandshake: true` mode with `onControlMessage` wired, PLUS a `ProbeDetector` fed the same samples. `feedChunk` routes to both while chatter is active (and to nothing while `rxMuted`).
  - `ProbeDetector` (private class inside `modemService.ts`, ~80 lines): keeps a rolling buffer of 0.5 s; every 4096 samples runs `chirpCorrelate` of the newest window against `probeChirpTemplate` (7200 samples at 48 k — the O(n·m) correlate over a 4096-sample hop is ~30 M mults, acceptable in a worker; note it in a comment). Normalized peak > 0.25 ⇒ chirp candidate: record absolute anchor, then buffer `probeBurstSamplesAfterChirp` more samples; when complete run `decodeProbeId` — null ⇒ discard (false trigger), else `measureProbeSweep` and emit `probeHeard`. Own device ID (from `chatterStart`) is dropped here.
  - `encodeControl`: build wire bytes, then modulate exactly the way the band card segment is built in `txEngine.ts` (`frameSegments`, `bandHandshake` branch, lines ~271–310): full handshake-band preamble + wire bytes as QPSK symbols. Reuse the same helper the card path uses — extract/generalize a private `buildHandshakeSegment(bytes: Uint8Array): Float32Array` in `txEngine.ts` if the card path is not already callable with arbitrary bytes; the card path must remain byte-identical (existing `bandHandshake.test.ts` asserts it).
  - `encodeProbe`: `buildProbeBurst(deviceId, sampleRate)` → `encoded` event (same shape as `encodeFile`'s reply).
  - `airCheck`: RMS of the last 250 ms of the ring buffer (already maintained for `dumpBuffer`); `busy = rms > 3 × noiseFloor` where `noiseFloor` is a slow EMA of quiet-period RMS (update the EMA only when below the current threshold; seed on first chunk).
  - `rxEngine.ts` change (small): in bandHandshake mode the sentinel scanner currently tries `decodeBandCard` on collected bytes. Add: when the BCH header decodes but `raw[0] === CONTROL_MAGIC` instead of `BAND_CARD_MAGIC`, keep collecting `controlPayloadWireSize(payloadLen)` more bytes and invoke `onControlMessage`. Follow the existing `onBandCard` plumbing style (`rxEngine.ts:468`).
- Tests (pure parts — no real worker): `ProbeDetector` fed a built probe burst in chunks emits the right ID + grid; fed the SYNC chirp (up-chirp) does not fire; air-check EMA flags a loud grid burst as busy and silence as clear. Export `ProbeDetector` and the air-check helper from `modemService.ts` for the test (named exports are fine — the file already exports `ModemService`).

- [ ] **Step 1: Write failing tests** for `ProbeDetector` + air check (`src/modem/test/chatterWorker.test.ts`): feed `buildProbeBurst(7, 48000)` in 4096-sample chunks through `ProbeDetector`, assert one `probeHeard` with `deviceId === 7` and 64 grid points; feed `generateChirp({fStart: 1200, fEnd: 4400, ...})` (up-chirp) + noise, assert no detection; RMS gate test.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** schema, `ProbeDetector`, service command handlers, `rxEngine.onControlMessage`, `txEngine` handshake-segment generalization.
- [ ] **Step 4: Run new tests AND the full suite** — `npx vitest run` (band-card byte-identity and `bandHandshake.test.ts` must still pass — 3 pre-existing BPSK Doppler failures are known, everything else green).
- [ ] **Step 5: Commit** — `git add src/workers/modemSchema.ts src/workers/modemService.ts src/modem/protocol/rxEngine.ts src/modem/protocol/txEngine.ts src/modem/test/chatterWorker.test.ts && git commit -m "feat(chatter): worker chatter mode — probe detect, control frames, air check"`

---

### Task 6: Chatter controller + store slice

**Files:**
- Create: `src/ui/controllers/chatterController.ts`
- Modify: `src/ui/Store.ts` (chatter slice)
- Modify: `src/ui/controllers/index.ts` (export)
- Test: `src/modem/test/chatterController.test.ts` (deps-injected, no AudioContext)

**Interfaces:**
- Consumes: `RoomProtocol`, `RoomDeps`, `RoomState`, `Member` (Task 4); worker commands/events (Task 5); `AudioPlayer`/`AudioRecorder` (`src/audio/`); `getState`/`setState` (`Store`); the existing send path used by `modemController.ts` for `startFileTx` and `HandshakeReceiver` arming for `armFileRx`.
- Produces:

```ts
// Store slice (add to AppState):
chatterOn: boolean;              // default false
chatterState: RoomState | 'off'; // default 'off'
chatterDeviceId: number;         // 0 until joined
chatterMembers: { deviceId: number; lastHeardMs: number; claimLowHz?: number; claimHighHz?: number }[];
chatterError: string | null;

// controller API:
export class ChatterController {
  constructor(worker: ModemWorkerHandle /* same handle modemController uses */);
  joinRoom(): Promise<void>;   // picks random deviceId 1-255, chatterStart, room.start()
  leaveRoom(): Promise<void>;  // room.stop(), chatterStop
  /** Broadcast a file to the room (chatter path for the existing drop zone). */
  broadcastFile(fileName: string, data: Uint8Array): Promise<void>;
}
```

- Controller responsibilities (each is a thin adapter — protocol logic stays in `RoomProtocol`):
  - `RoomDeps.playProbe` / `sendMessage`: worker `encodeProbe` / `encodeControl` → play returned samples via `AudioPlayer` with `setRxMuted true` for exactly the playback duration (plus 150 ms tail for room echo) around it.
  - `RoomDeps.isAirBusy`: worker `airCheck`.
  - `RoomDeps.startFileTx(settings)`: set the negotiated band/qam/gains into the modem config the same way `buildModemConfig.ts` does, `bandHandshake: true`, then reuse the existing encode+play send path with the queued file.
  - `RoomDeps.armFileRx(info)`: ensure RX is running (existing `startRx` path already routes through `HandshakeReceiver` when `bandHandshake` is on) — the band card in the transmission does the tuning; `info` is used only for the receive timeout.
  - Worker events `probeHeard`/`controlMessage` → `room.onProbeHeard`/`room.onMessage`.
  - `onStateChange` → `setState({ chatterState, chatterMembers, chatterError: room.lastError })`.
  - `schedule` = `setTimeout` wrapper; `now` = `performance.now`; `rng` = `Math.random`.
- Test with a fake worker handle + fake player (the same style `autoCalibrate.test.ts` uses for calibration): join flow sends `chatterStart` then plays a probe; `probeHeard` event routes into the protocol; `broadcastFile` before `idle` sets `chatterError`.

- [ ] **Step 1: Write failing tests** (fake worker records commands, protocol drives real `RoomProtocol` with manual clock — reuse the harness pattern from `roomProtocol.test.ts`).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement controller + store fields.**
- [ ] **Step 4: Run, verify pass; `npm run lint`.**
- [ ] **Step 5: Commit** — `git add src/ui/controllers/chatterController.ts src/ui/Store.ts src/ui/controllers/index.ts src/modem/test/chatterController.test.ts && git commit -m "feat(chatter): controller + store slice wiring room protocol to audio I/O"`

---

### Task 7: Room panel UI

**Files:**
- Create: `src/ui/views/ChatterPanel.ts` (follow the component idiom of neighboring files in `src/ui/views/` — check two existing views first and match their export/DOM style exactly)
- Modify: `src/ui/app.ts` (mount panel; route file drop to `broadcastFile` when `chatterOn`)

**Interfaces:**
- Consumes: store slice from Task 6, `ChatterController`.
- Produces: UI only — no exports other tasks consume.

- Panel contents: Join/Leave toggle button; state badge (`chatterState`); member list (ID hex, "last heard Ns ago", claim range when known, aged-out styling past 5 min); error line (`chatterError`); hint text "drop a file anywhere to broadcast" when idle.
- No new styling system — reuse tokens from `src/ui/styles/tokens.ts`.

- [ ] **Step 1: Implement panel + app wiring** (UI file — vitest DOM coverage not required by this codebase's conventions; verify by `npm run build`).
- [ ] **Step 2: `npm run build` and `npm run lint` pass.**
- [ ] **Step 3: Commit** — `git add src/ui/views/ChatterPanel.ts src/ui/app.ts && git commit -m "feat(chatter): room panel UI"`

---

### Task 8: End-to-end loopback integration test

**Files:**
- Create: `src/modem/test/chatterLoopback.test.ts`

**Interfaces:**
- Consumes: everything above; harness style from `bandHandshake.test.ts` (TxEngine → sample array → RxEngine/HandshakeReceiver feed).

- Scenario (single test, generous timeout like `bandHandshake.test.ts`'s 60 s):
  1. Two `RoomProtocol` instances A and B with deps bridged through a shared "air" array: `playProbe`/`sendMessage` append real samples (via `buildProbeBurst` / `encodeControlMessage` + the Task-5 handshake-segment modulator) onto the air; after each append, feed the samples through the OTHER side's `ProbeDetector` + chatter `RxEngine` listener, delivering resulting `probeHeard`/`onMessage` events. Manual clock (same harness as `roomProtocol.test.ts`).
  2. A joins (empty room) → idle. B joins → A hears B's probe, replies WELCOME → both idle, each has the other in `members`.
  3. A `sendFile` → roll call probe → B replies REPORT with a real measured grid → A picks settings → FILE_COMING decodes at B → B arms RX.
  4. A transmits a 256-byte payload via `TxEngine` (`bandHandshake: true`, picked settings); B's `HandshakeReceiver` decodes it; assert payload bytes match.
  5. Assert the picked settings were non-floor (clean simulated channel).

- [ ] **Step 1: Write the test** (it will fail or crash until wiring holes surface — this task is where cross-task seams get fixed; small fixes to earlier files are in scope, each still its own commit message line).
- [ ] **Step 2: Make it pass.** Run `npx vitest run src/modem/test/chatterLoopback.test.ts`.
- [ ] **Step 3: Full suite green** (minus the 3 known BPSK failures): `npx vitest run`.
- [ ] **Step 4: Commit** — `git add src/modem/test/chatterLoopback.test.ts <any seam fixes> && git commit -m "test(chatter): end-to-end loopback — join, rollcall, negotiated transfer"`

---

### Task 9: Documentation

**Files:**
- Modify: `README.md` (one paragraph in "What the app does today" + mode mention)
- Modify: `docs/MODEM.md` (new "Chatter room protocol" section: probe burst layout, control frame format, REPORT_GRID constant, state machine summary, timing table — condensed from the spec, with wire-format tables)

- [ ] **Step 1: Write docs.**
- [ ] **Step 2: Commit** — `git add README.md docs/MODEM.md && git commit -m "docs(chatter): room protocol documentation"`

---

## Execution notes

**Parallelism (waves):**
- Wave 1 — Tasks 1, 2, 3, 4 in parallel (pure modules; every cross-import they need is specified in their Interfaces blocks).
- Wave 2 — Task 5 (needs 1+2 on disk).
- Wave 3 — Tasks 6, 7 in parallel (7 only reads the store field names specified in Task 6's Interfaces block).
- Wave 4 — Task 8, then Task 9.

**Known failing baseline:** 3 pre-existing BPSK Doppler/stress test failures (README). Any OTHER failure is yours.

**Bench follow-up (not a subagent task):** manual two-device acoustic verification before merge, per README's fragile-paths rule.

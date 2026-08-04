# Chatter Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chatter room's control plane reliable — welcomes that always arrive, control messages on a band a phone can hear, and a chatter file failure that is readable on the device it failed on.

**Architecture:** Three independent threads of change. (1) The probe burst gains a purpose bit so WELCOME-vs-REPORT is signalled rather than inferred, and `RoomProtocol` replaces its state-gated reply side effect with a queue that drains whenever the local transmitter is free. (2) The fixed handshake band moves from 6900-7250 Hz down to 2600-2950 Hz, which requires the sync chirp centre to become per-engine so the chirp does not sit on top of the new tone band. (3) The chatter file-send path stops swallowing its own rejections and stops allocating three copies of every waveform.

**Tech Stack:** TypeScript, Vitest, Vite. No new dependencies.

Spec: `docs/superpowers/specs/2026-08-05-chatter-control-plane-design.md`

## Global Constraints

- Run `npm run lint` and `npm run test` before every commit. The suite has 3 known-failing BPSK Doppler/stress cases (README, "Current modem status") — those 3 may stay red; nothing else may go red.
- `src/modem/protocol/preamble.ts`, `src/modem/protocol/rxEngine.ts`, `src/modem/pilot.ts`, and `src/audio/recorder.ts` are marked fragile in README. This plan touches `rxEngine.ts` in exactly one place (Task 5) and none of the others.
- The target-band file transmission waveform must not change. `bandHandshake.test.ts` asserts byte-identity; if it goes red, the change leaked out of the handshake path.
- TX and RX read every wire constant from the same place. Never hardcode a frequency, slot count, or symbol count in one side that the other derives — a mismatch produces silent non-decoding, not an error.
- Section C2 of the spec (the actual out-of-memory root cause) is **out of scope for this plan** — it is blocked on a log. Task 7 exists to produce that log. Do not invent a fix for it.
- Conventional Commits for every commit. Code comments explain *why*, matching the density of the surrounding file.

## File Structure

Modified:

- `src/modem/protocol/probeBurst.ts` — purpose bit, 13 ID slots, generalised CRC-4 (Task 1)
- `src/workers/modemSchema.ts` — `purpose` on the `encodeProbe` command and `probeHeard` event; error metadata (Tasks 2, 7)
- `src/workers/modemService.ts` — `ProbeDetector` reports purpose; `encodeProbe` forwards it; error metadata (Tasks 1, 2, 7)
- `src/ui/controllers/modemController.ts` — `encodeProbe(deviceId, purpose)` (Task 2)
- `src/ui/controllers/chatterController.ts` — purpose through `playProbe`; rejection handling; streaming TX (Tasks 2, 7, 9)
- `src/modem/chatter/roomProtocol.ts` — reply queue, ack + retry (Tasks 3, 4)
- `src/modem/protocol/ofdmEngine.ts` — per-engine chirp centre (Task 5)
- `src/modem/protocol/rxEngine.ts` — per-mode chirp centre, one block (Task 5)
- `src/modem/protocol/txEngine.ts` — handshake engine gets the handshake chirp centre (Task 5)
- `src/modem/types.ts` — `OFDM_HANDSHAKE` band + `chirpCenterHz` (Tasks 5, 6)
- `src/modem/chatter/handshakeGains.ts` — doc comment only, band is derived (Task 6)
- `src/audio/player.ts` — write into the AudioBuffer instead of a scratch copy (Task 8)

Tests modified: `src/modem/test/probeBurst.test.ts`, `roomProtocol.test.ts`, `chatterController.test.ts`, `chatterLoopback.test.ts`, `chatterWorker.test.ts`.

---

### Task 1: Probe burst carries a purpose bit

`roomProtocol.ts:230` decides WELCOME-vs-REPORT from whether the prober is already a known member. There is no purpose bit on the air, so a device rejoining with the same id gets a REPORT while in `joinWait`, and a peer whose WELCOME was lost answers a roll call with a WELCOME. Both are worked around downstream (`roomProtocol.ts:281`, `:304`). This task puts the bit on the wire.

`probeBurst.ts:140` packs 12 slots as `(deviceId << 4) | crc4(deviceId)`. It becomes 13 slots: `(word << 4) | crc4Bits(word, 9)` where `word = (deviceId << 1) | purpose`.

This task keeps `ProbeDetector` emitting only `(deviceId, grid)` so the build stays green; Task 2 threads purpose the rest of the way.

**Files:**
- Modify: `src/modem/protocol/probeBurst.ts:84-90` (`PROBE_LAYOUT`), `:134-145` (`idBits`), `:212-253` (`decodeProbeId`), `:269-279` (`crc4`)
- Modify: `src/workers/modemService.ts:175` (destructure the new return shape)
- Test: `src/modem/test/probeBurst.test.ts`

**Interfaces:**
- Produces: `PROBE_PURPOSE: { readonly joining: 0; readonly rollCall: 1 }`; `type ProbePurpose = 0 | 1`;
  `buildProbeBurst(deviceId: number, sampleRate: number, purpose?: ProbePurpose): Float32Array` (defaults to `PROBE_PURPOSE.joining`);
  `decodeProbeId(samples: Float32Array, anchor: number, sampleRate: number): { deviceId: number; purpose: ProbePurpose } | null`;
  `crc4(byte: number): number` (unchanged signature and values)
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing tests**

Replace the three ID-related tests in `src/modem/test/probeBurst.test.ts` and add the purpose cases. The existing `crc4`, sweep, and grid-freq tests stay exactly as they are.

```typescript
import { describe, expect, it } from 'vitest';
import {
  buildProbeBurst, decodeProbeId, measureProbeSweep,
  probeChirpTemplate, crc4, reportGridFreqs, REPORT_GRID,
  PROBE_LAYOUT, PROBE_PURPOSE,
} from '../protocol/probeBurst';
import { chirpCorrelate } from '../protocol/chirp';

const SR = 48000;

function findAnchor(burst: Float32Array): number {
  return chirpCorrelate(burst, probeChirpTemplate(SR)).peakIndex;
}

describe('probe burst', () => {
  it('round-trips the device ID and a joining purpose', () => {
    const burst = buildProbeBurst(0xa7, SR, PROBE_PURPOSE.joining);
    expect(decodeProbeId(burst, findAnchor(burst), SR)).toEqual({
      deviceId: 0xa7,
      purpose: PROBE_PURPOSE.joining,
    });
  });

  it('round-trips a roll-call purpose', () => {
    const burst = buildProbeBurst(0xa7, SR, PROBE_PURPOSE.rollCall);
    expect(decodeProbeId(burst, findAnchor(burst), SR)).toEqual({
      deviceId: 0xa7,
      purpose: PROBE_PURPOSE.rollCall,
    });
  });

  it('defaults to a joining purpose', () => {
    const burst = buildProbeBurst(12, SR);
    expect(decodeProbeId(burst, findAnchor(burst), SR)?.purpose).toBe(PROBE_PURPOSE.joining);
  });

  it('round-trips the id/purpose extremes', () => {
    // The pulse threshold is a largest-gap split over the slot magnitudes, so
    // it has to hold for every on/off ratio the 13-bit word can produce.
    // These ids cover the extremes: all-zero and all-one id bits, and the
    // single-bit-set and single-bit-clear cases either side of them.
    //
    // Anchor is computed, not correlated: findAnchor runs an O(burst x
    // template) correlation — roughly 1.3 billion multiplies for a ~3.7 s
    // burst — which is fine once but not once per case. The chirp starts after
    // the fixed 100 ms lead-in (LEAD_IN_MS in probeBurst.ts), and the
    // correlation path is already covered by the round-trip tests above.
    const ANCHOR = Math.round(0.1 * SR);
    for (const purpose of [PROBE_PURPOSE.joining, PROBE_PURPOSE.rollCall] as const) {
      for (const id of [1, 2, 0x55, 0xaa, 0x7f, 0x80, 0xfe, 0xff]) {
        const burst = buildProbeBurst(id, SR, purpose);
        expect(decodeProbeId(burst, ANCHOR, SR)).toEqual({ deviceId: id, purpose });
      }
    }
  });

  it('decodes the ID under additive noise', () => {
    const burst = buildProbeBurst(42, SR, PROBE_PURPOSE.rollCall);
    let seed = 1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const noisy = burst.map((s) => s + (rnd() - 0.5) * 0.05);
    expect(decodeProbeId(noisy, findAnchor(noisy), SR)).toEqual({
      deviceId: 42,
      purpose: PROBE_PURPOSE.rollCall,
    });
  });

  it('rejects a corrupted ID trailer via CRC', () => {
    const burst = buildProbeBurst(42, SR);
    const anchor = findAnchor(burst);
    // Zero out one ID slot → bit flips → CRC mismatch.
    const slotSamples = Math.round(PROBE_LAYOUT.idSlotMs / 1000 * SR);
    const slot0Start = burst.length - PROBE_LAYOUT.idSlots * slotSamples;
    for (let i = slot0Start; i < slot0Start + slotSamples; i++) burst[i] = 0;
    expect(decodeProbeId(burst, anchor, SR)).toBeNull();
  });

  it('a flipped purpose bit fails CRC rather than sending the wrong reply type', () => {
    // The purpose bit decides WELCOME vs REPORT. A silent flip would make a
    // joining device receive a REPORT and never learn the room is occupied,
    // so the CRC must cover it.
    const burst = buildProbeBurst(42, SR, PROBE_PURPOSE.joining);
    const anchor = findAnchor(burst);
    const slotSamples = Math.round(PROBE_LAYOUT.idSlotMs / 1000 * SR);
    const slotsStart = burst.length - PROBE_LAYOUT.idSlots * slotSamples;
    // Slot 4 is the purpose bit: the word is (deviceId << 1) | purpose,
    // shifted left 4 for the CRC, so purpose lands at packed bit 4.
    const flipStart = slotsStart + 4 * slotSamples;
    const ref = buildProbeBurst(42, SR, PROBE_PURPOSE.rollCall);
    for (let i = 0; i < slotSamples; i++) {
      burst[flipStart + i] = ref[flipStart + i];
    }
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

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modem/test/probeBurst.test.ts`

Expected: FAIL. The import of `PROBE_PURPOSE` is unresolved, so the whole file errors before any test runs.

- [ ] **Step 3: Add the purpose type and generalise the CRC**

In `src/modem/protocol/probeBurst.ts`, add near `PROBE_LAYOUT`:

```typescript
/**
 * What a probe burst is announcing, so a listener knows which reply to send
 * instead of guessing.
 *
 * Before this bit existed the wire-level burst was identical for a join and a
 * roll call, and the only way to tell them apart was whether the listener
 * already knew the prober — which is one-sided and wrong in both directions.
 * A device rejoining with the same id (page refresh, reconnect) is a stranger
 * to itself but a known member to everyone else, so it received a REPORT when
 * it needed a WELCOME; and a peer whose WELCOME was lost still considers us a
 * stranger, so it answers our roll call with a WELCOME. See
 * roomProtocol.ts's onProbeHeard for the inference this replaces.
 */
export const PROBE_PURPOSE = { joining: 0, rollCall: 1 } as const;
export type ProbePurpose = (typeof PROBE_PURPOSE)[keyof typeof PROBE_PURPOSE];
```

Change `PROBE_LAYOUT.idSlots` from `12` to `13`, with the reason:

```typescript
export const PROBE_LAYOUT = {
  chirpMs: 150,
  gapMs: 50,
  idSlotMs: 40,
  // 13, not 12: 8 id bits + 1 purpose bit + 4 CRC bits. One extra 40 ms slot
  // (~3.74 s burst, up from ~3.70 s) buys an explicitly signalled reply type.
  // Wire constant — both ends read it, and a mismatch fails CRC, so an
  // old-build peer's probes are dropped rather than misread.
  idSlots: 13,
} as const;
```

Replace `crc4` at the bottom of the file with a bit-width-parameterised core, keeping the exported 8-bit entry point identical so existing callers and its test are unaffected:

```typescript
/** CRC-4 (poly x^4+x+1, MSB-first, non-reflected) over the low `bitCount`
 *  bits of `value`. Parameterised because the ID word grew from 8 bits to 9
 *  when the purpose bit was added, and the CRC has to cover the purpose bit
 *  too — a silent flip there sends the wrong reply type, which is the exact
 *  failure the bit exists to prevent. */
function crc4Bits(value: number, bitCount: number): number {
  let crc = 0;
  for (let i = bitCount - 1; i >= 0; i--) {
    const bit = (value >> i) & 1;
    const feedback = ((crc >> 3) & 1) ^ bit;
    crc = (crc << 1) & 0xf;
    if (feedback) crc ^= 0b0011;
  }
  return crc & 0xf;
}

/** CRC-4 over the 8 id bits — the pre-purpose-bit form, kept for callers that
 *  only have a device id. */
export function crc4(byte: number): number {
  return crc4Bits(byte & 0xff, 8);
}
```

- [ ] **Step 4: Pack and unpack the purpose bit**

Replace `idBits` (`probeBurst.ts:134-145`):

```typescript
/** Slot k carries bit k of the 13-bit word
 *  V = (word << 4) | crc4Bits(word, 9), where word = (deviceId << 1) | purpose
 *  — LSB-first, so slot 0 is the CRC's least-significant bit, slot 4 is the
 *  purpose bit, and slot 12 is the device ID's most-significant bit. Sent
 *  LSB-first (rather than the more obvious MSB-first) so that decoding does
 *  not depend on either field's own endpoint bit. */
function idBits(deviceId: number, purpose: ProbePurpose): number[] {
  const word = ((deviceId & 0xff) << 1) | (purpose & 1);
  const packed = (word << 4) | crc4Bits(word, 9);
  const bits: number[] = [];
  for (let k = 0; k < PROBE_LAYOUT.idSlots; k++) bits.push((packed >> k) & 1);
  return bits;
}
```

In `buildProbeBurst`, add the parameter and pass it through:

```typescript
/** silence(100ms) + downChirp + gap + sweep + gap + 13 pulse slots. */
export function buildProbeBurst(
  deviceId: number,
  sampleRate: number,
  purpose: ProbePurpose = PROBE_PURPOSE.joining,
): Float32Array {
  const chirp = generateChirp({ ...DOWN_CHIRP, sampleRate, amplitude: 0.5 });
  const gap = new Float32Array(ms(sampleRate, PROBE_LAYOUT.gapMs));
  const sweep = sweepPlan(sampleRate).audio;
  const bits = idBits(deviceId, purpose);
```

The rest of `buildProbeBurst` is unchanged.

In `decodeProbeId`, change the signature and the unpacking. The magnitude loop and the largest-gap threshold are unchanged — they already read `PROBE_LAYOUT.idSlots`, so they pick up 13 slots automatically.

```typescript
/** anchor = sample index where the chirp STARTS in `samples`.
 *  Returns null on CRC failure. */
export function decodeProbeId(
  samples: Float32Array,
  anchor: number,
  sampleRate: number,
): { deviceId: number; purpose: ProbePurpose } | null {
```

Replace the tail of the function (from `// Undo the LSB-first packing` onward):

```typescript
  // Undo the LSB-first packing from idBits: bits[k] is bit k of V.
  let packed = 0;
  for (let k = 0; k < PROBE_LAYOUT.idSlots; k++) packed |= bits[k] << k;
  const word = (packed >> 4) & 0x1ff;
  const crc = packed & 0xf;

  if (crc4Bits(word, 9) !== crc) return null;
  return { deviceId: (word >> 1) & 0xff, purpose: (word & 1) as ProbePurpose };
}
```

Update the wire-layout comment at the top of the file: `[..., ...+idSlots*idSlotMs)` currently says "12 pulse-keyed ID bits" — make it "13 pulse-keyed bits (8 id + 1 purpose + 4 CRC)". Also update the `WHY pulse-keyed (not QAM)` paragraph's "12 bits" to "13 bits".

- [ ] **Step 5: Keep the worker compiling**

`modemService.ts:175` assigns `decodeProbeId`'s result to a `number`. Adjust to the new shape, still emitting only `(deviceId, grid)` — Task 2 adds purpose:

```typescript
  private finishCapture(): void {
    const samples = new Float32Array(this.pending!.buf);
    this.pending = null;
    const decoded = decodeProbeId(samples, 0, this.sampleRate);
    if (decoded === null || decoded.deviceId === this.ownDeviceId) return; // CRC fail or our own probe
    const grid = measureProbeSweep(samples, 0, this.sampleRate);
    if (!grid) return;
    this.onProbe(decoded.deviceId, grid);
  }
```

Update the `ProbeDetector` class doc (`modemService.ts:86-87`): "a 12-bit pulse-keyed device ID" → "a 13-bit pulse-keyed device ID and purpose".

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/probeBurst.test.ts`

Expected: PASS, 10 tests. If the file takes more than ~30 s, a test is running `findAnchor` in a loop — only the single-burst cases may correlate.

- [ ] **Step 7: Run the full suite and lint**

Run: `npm run test && npm run lint`

Expected: PASS except the 3 known BPSK Doppler/stress failures. `chatterWorker.test.ts` and `chatterLoopback.test.ts` call `buildProbeBurst(id, SR)` with two arguments, which still compiles and now means "joining" — both should stay green.

- [ ] **Step 8: Commit**

```bash
git add src/modem/protocol/probeBurst.ts src/workers/modemService.ts src/modem/test/probeBurst.test.ts
git commit -m "feat(chatter): signal a probe's purpose on the air, not by inference

WELCOME vs REPORT was decided by whether the prober was already a known
member, which is one-sided and wrong both ways: a device rejoining with
the same id is a stranger to itself but known to everyone else, so it got
a REPORT when it needed a WELCOME.

13 ID slots now: 8 id + 1 purpose + 4 CRC, and the CRC covers the purpose
bit, so a flip drops the probe rather than sending the wrong reply."
```

---

### Task 2: Thread the purpose bit from the protocol to the air and back

Task 1 put the bit on the wire but nothing sets or reads it. `RoomProtocol` calls `deps.playProbe()` for both a join announcement (`roomProtocol.ts:377`) and a roll-call announcement (`:393`); those become purpose-carrying. In the other direction the worker's `probeHeard` event gains `purpose`, which Task 3 consumes.

**Files:**
- Modify: `src/workers/modemSchema.ts:75` (`encodeProbe` command), `:98` (`probeHeard` event)
- Modify: `src/workers/modemService.ts:121` (`onProbe` callback type), `:172-180` (`finishCapture`), `:408-416` (`chatterStart`), `:449-456` (`encodeProbe`)
- Modify: `src/ui/controllers/modemController.ts:246-256` (`encodeProbe`)
- Modify: `src/modem/chatter/roomProtocol.ts:79` (`RoomDeps.playProbe`), `:377`, `:393`
- Modify: `src/ui/controllers/chatterController.ts:107` (`ModemWorkerHandle.encodeProbe`), `:241-245` (`playProbe` adapter), `:279-311` (`probeHeard` handler)
- Test: `src/modem/test/chatterController.test.ts`

**Interfaces:**
- Consumes: `PROBE_PURPOSE`, `ProbePurpose`, `buildProbeBurst(deviceId, sampleRate, purpose)` from Task 1.
- Produces:
  - `RoomDeps.playProbe(purpose: ProbePurpose): Promise<void>`
  - `ModemWorkerHandle.encodeProbe(deviceId: number, purpose: ProbePurpose): Promise<{ samples: Float32Array; sampleRate: number }>`
  - `RoomProtocol.onProbeHeard(deviceId: number, grid: number[], purpose?: ProbePurpose)` — defaults to `PROBE_PURPOSE.joining`. The purpose selects the reply type as of this task; Task 3 changes *when* the reply is eligible to be sent, not which type it is.
  - `probeHeard` worker event shape: `{ type: 'probeHeard'; deviceId: number; grid: number[]; purpose: ProbePurpose }`

- [ ] **Step 1: Write the failing test**

Add to `src/modem/test/chatterController.test.ts`, inside the existing top-level `describe`:

```typescript
  it('announces a join as joining and a roll call as a roll call', async () => {
    // The purpose bit is what tells a listener which reply to send. If both
    // announcements went out as the same purpose, a roll call would be
    // answered with WELCOMEs (no channel measurement) or a join with REPORTs
    // (the joiner never learns the room is occupied).
    const { controller, worker, clock } = makeController();
    await controller.joinRoom();
    await clock.tick(ROOM_TIMING.listenMs + 100);
    expect(worker.probePurposes).toEqual([PROBE_PURPOSE.joining]);

    await clock.tick(
      ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200,
    );
    await controller.broadcastFile('a.txt', new Uint8Array(10));
    await clock.tick(ROOM_TIMING.listenMs + 100);
    expect(worker.probePurposes).toEqual([PROBE_PURPOSE.joining, PROBE_PURPOSE.rollCall]);
  });
```

Read `src/modem/test/chatterController.test.ts:40-110` first and match its existing harness names — the fake worker there is built by a local helper, and `encodeProbe` is stubbed at `:77`. Extend that stub to record purposes:

```typescript
    probePurposes: [] as ProbePurpose[],
    encodeProbe: async (deviceId: number, purpose: ProbePurpose) => {
      calls.push('encodeProbe');
      worker.probePurposes.push(purpose);
      return { samples: new Float32Array(8), sampleRate: SR };
    },
```

Add to that file's imports:

```typescript
import { PROBE_PURPOSE, type ProbePurpose } from '../protocol/probeBurst';
```

Also add these two to `src/modem/test/roomProtocol.test.ts`, inside `describe('room protocol')` — they cover the reply type coming off the wire instead of from the membership inference. Add `import { PROBE_PURPOSE } from '../protocol/probeBurst';` to that file.

```typescript
  it('answers a roll-call probe with a REPORT even from a device it has never seen', async () => {
    // The reply type now comes from the purpose bit, not from whether we
    // already know the prober. A never-seen device running a roll call needs
    // a channel measurement, not a welcome.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    expect(h.room.state).toBe('idle');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    await h.tick(ROOM_TIMING.replySlotMs + 100);

    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);
    const report = h.sent.find((m) => m.type === ControlType.Report);
    expect(report).toBeDefined();
    expect(report.targetId).toBe(9);
  });

  it('answers a joining probe with a WELCOME even from a device it already knows', async () => {
    // The mirror case: a device rejoining with the same id (page refresh)
    // is already in _members, and used to receive a REPORT while sitting in
    // joinWait — so it finished joining knowing nothing about this peer.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    expect(h.room.members.get(9)).toBeDefined();

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining); // 9 refreshed and rejoined
    await h.tick(ROOM_TIMING.replySlotMs + 100);

    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modem/test/chatterController.test.ts -t "announces a join as joining"` and `npx vitest run src/modem/test/roomProtocol.test.ts -t "even from a device"`

Expected: FAIL. The `chatterController` case receives `[undefined]` because `playProbe` still calls `encodeProbe` with one argument. The `roomProtocol` roll-call case gets a WELCOME instead of a REPORT, because the reply type still comes from the membership inference.

- [ ] **Step 3: Add purpose to the worker schema**

In `src/workers/modemSchema.ts`, add the import and change the two shapes:

```typescript
import type { ProbePurpose } from '../modem/protocol/probeBurst';
```

```typescript
  | { type: 'encodeProbe'; id: number; deviceId: number; purpose: ProbePurpose }
```

```typescript
  | { type: 'probeHeard'; deviceId: number; grid: number[]; purpose: ProbePurpose }
```

- [ ] **Step 4: Forward purpose through the worker**

In `src/workers/modemService.ts`:

`ProbeDetector`'s callback type (`:121`):

```typescript
    private readonly onProbe: (deviceId: number, grid: number[], purpose: ProbePurpose) => void,
```

`finishCapture` (from Task 1's Step 5) passes it on:

```typescript
    this.onProbe(decoded.deviceId, grid, decoded.purpose);
```

`chatterStart`'s detector construction (`:408`):

```typescript
        this.probeDetector = new ProbeDetector(cmd.deviceId, this.config.sampleRate, (deviceId, grid, purpose) => {
          // A probe burst just went through — whatever the control listener
          // thinks it is part-way through demodulating, it is not a control
          // message. Re-arm it, or a false sync on the burst's sweep (which
          // crosses the handshake band) leaves it stuck out of WAITING and
          // deaf to every reply that follows.
          this.chatterRx?.rearmForNextControlMessage();
          this.emit({ type: 'probeHeard', deviceId, grid, purpose });
        });
```

`encodeProbe` (`:451`):

```typescript
        const samples = buildProbeBurst(cmd.deviceId, this.config.sampleRate, cmd.purpose);
```

Add `type ProbePurpose` to the existing `probeBurst` import block at `modemService.ts:18-21`.

- [ ] **Step 5: Forward purpose through ModemController**

In `src/ui/controllers/modemController.ts`, change `encodeProbe` (`:246`):

```typescript
  encodeProbe(deviceId: number, purpose: ProbePurpose): Promise<{ samples: Float32Array; sampleRate: number }> {
```

and its `post` call (`:253`):

```typescript
      this.post({ type: 'encodeProbe', id, deviceId, purpose });
```

Add the import:

```typescript
import type { ProbePurpose } from '../../modem/protocol/probeBurst';
```

- [ ] **Step 6: Make RoomProtocol announce its purpose**

In `src/modem/chatter/roomProtocol.ts`, add to the imports:

```typescript
import { PROBE_PURPOSE, type ProbePurpose } from '../protocol/probeBurst';
```

Change the `RoomDeps` member (`:79`):

```typescript
  /** Play the probe burst; resolves when playback finishes. `purpose` goes on
   *  the air so listeners know whether to answer WELCOME or REPORT — see
   *  PROBE_PURPOSE. */
  playProbe(purpose: ProbePurpose): Promise<void>;
```

In `beginAnnounceJoin` (`:377`):

```typescript
    await this.deps.playProbe(PROBE_PURPOSE.joining);
```

In `beginAnnounceRollCall` (`:393`):

```typescript
    await this.deps.playProbe(PROBE_PURPOSE.rollCall);
```

Widen `onProbeHeard` to accept the purpose and use it for the reply type straight away, retiring the membership inference. This is the whole point of the bit — storing it unread would be dead code, and the inference is what produced the two bugs.

Replace the signature and the long inference comment block (`roomProtocol.ts:203`, and the comment at `:207-227`):

```typescript
  /** worker heard a probe: id + measured grid + what it announced */
  onProbeHeard(deviceId: number, grid: number[], purpose: ProbePurpose = PROBE_PURPOSE.joining): void {
    const existing = this._members.get(deviceId);
    this._members.set(deviceId, { ...existing, deviceId, lastHeardMs: this.deps.now(), heardGrid: grid });

    // Only 'idle' carries reply duty — a probe heard mid-join or mid-rollcall
    // just refreshes the member table. (Task 3 replaces this gate with a
    // queue; the reply TYPE is what changes here.) Dedupe by prober: a repeat
    // probe from the same device while its reply chain is still waiting out a
    // slot must not start a second, redundant reply chain.
    //
    // WELCOME vs REPORT now comes off the wire (see PROBE_PURPOSE), not from
    // whether we already know this prober. That inference was one-sided in
    // both directions: a device rejoining with the same id (page refresh,
    // reconnect, a second start()) is a stranger to itself but a known member
    // to us, so it received a REPORT when it needed a WELCOME; and a peer
    // whose WELCOME we lost still thinks we are a stranger, so it answered our
    // roll call with a WELCOME. handleWelcome and handleReport keep their
    // tolerance for the "wrong" reply type regardless, so a peer running an
    // older build degrades rather than breaks.
    if (this._state === 'idle' && !this.pendingReplyTo.has(deviceId)) {
      this.pendingReplyTo.add(deviceId);
      this.scheduleReply(
        this.deps.now(),
        Array.from({ length: ROOM_TIMING.replySlots }, (_unused, i) => i),
        deviceId,
        purpose === PROBE_PURPOSE.rollCall,
      );
    }
  }
```

`scheduleReply`'s fourth parameter is already `replyWithReport: boolean` (`:481`) and its body already branches on it (`:510-522`) — so no change is needed there. The local `alreadyKnown` variable disappears with the inference.

- [ ] **Step 7: Forward purpose through ChatterController**

In `src/ui/controllers/chatterController.ts`, change the handle type (`:107`):

```typescript
  encodeProbe(deviceId: number, purpose: ProbePurpose): Promise<{ samples: Float32Array; sampleRate: number }>;
```

the adapter (`:241`):

```typescript
      playProbe: (purpose) => this.playAndMute(() => this.worker.encodeProbe(this.deviceId, purpose), {
        kind: 'probe',
        peerId: 0,
        bytes: 0,
      }),
```

and the event handler (`:280`):

```typescript
      this.room.onProbeHeard(ev.deviceId, ev.grid, ev.purpose);
```

Add the import:

```typescript
import { type ProbePurpose } from '../../modem/protocol/probeBurst';
```

- [ ] **Step 8: Fix the remaining fake `playProbe` implementations**

`roomProtocol.test.ts:23` and `chatterLoopback.test.ts` both supply a `playProbe`. They take no arguments today, which still type-checks against a one-parameter signature (a function of fewer parameters is assignable in TypeScript), so no change is strictly required. In `chatterLoopback.test.ts:53`, however, the fake synthesises real audio via `buildProbeBurst(deviceId, SR)` — pass the purpose so the loopback exercises the real bit:

```typescript
  const burst = buildProbeBurst(deviceId, SR, purpose);
```

and give that helper's `playProbe` the parameter it needs. Read `chatterLoopback.test.ts:40-95` and thread `purpose` from the `playProbe` adapter into the burst builder, importing `PROBE_PURPOSE` and `ProbePurpose` if the helper needs a default.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/chatterController.test.ts src/modem/test/chatterLoopback.test.ts src/modem/test/chatterWorker.test.ts src/modem/test/roomProtocol.test.ts`

Expected: PASS, including the new "announces a join as joining and a roll call as a roll call".

- [ ] **Step 10: Run the full suite and lint**

Run: `npm run test && npm run lint`

Expected: PASS except the 3 known BPSK failures.

- [ ] **Step 11: Commit**

```bash
git add src/workers/modemSchema.ts src/workers/modemService.ts src/ui/controllers/modemController.ts src/ui/controllers/chatterController.ts src/modem/chatter/roomProtocol.ts src/modem/test/
git commit -m "feat(chatter): carry the probe purpose end to end

A join announcement and a roll-call announcement were the same burst on
the air. Now each says which it is, and the listener records it — the
reply path starts reading it in the next change."
```

---

### Task 3: Reply to a probe from any state where the transmitter is free

`roomProtocol.ts:228` gates the whole reply chain on `this._state === 'idle'`. A probe heard in `listening`, `announcing`, `joinWait`, `collecting`, `sending`, or `receiving` updates the member table and sends nothing.

The consequence is the reported inconsistency: two devices joining within roughly ten seconds are both in `joinWait` when the other's probe arrives, each records the other, neither replies, and both declare an empty room.

Replies become a queue. Eligibility is "our transmitter is free" — `idle` or `joinWait` — rather than one specific state. `joinWait` is safe because the joiner has finished playing its own probe before entering it, and the grace window at `roomProtocol.ts:385` already covers a full control message.

This task also switches the reply type from the membership inference to the purpose bit Task 2 recorded.

**Files:**
- Modify: `src/modem/chatter/roomProtocol.ts:143-151` (fields), `:202-238` (`onProbeHeard`), `:475-533` (`scheduleReply`), `:563-566` (`setState`), `:174-190` (`stop`), `:546-561` (`handleDepsError`)
- Test: `src/modem/test/roomProtocol.test.ts`

**Interfaces:**
- Consumes: `PROBE_PURPOSE`, `ProbePurpose`, `lastProbePurpose` from Task 2.
- Produces: no public API change. `RoomProtocol` internals gain `replyQueue: Map<number, PendingReply>` where
  `interface PendingReply { proberId: number; purpose: ProbePurpose; attempts: number; scheduled: boolean }`.
  Task 4 adds `awaitingAck` alongside it and reads `attempts`.

- [ ] **Step 1: Write the failing tests**

Add to `src/modem/test/roomProtocol.test.ts`, inside the existing `describe('room protocol')`. Add `PROBE_PURPOSE` to the imports:

```typescript
import { PROBE_PURPOSE } from '../protocol/probeBurst';
```

```typescript
  it('replies to a probe heard while in joinWait', async () => {
    // The bug this covers: reply duty used to exist only in 'idle'. Two
    // devices joining within a few seconds of each other are BOTH in joinWait
    // when the other's probe lands, so each recorded the other and neither
    // welcomed — both then declared an empty room.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + 50);
    expect(h.room.state).toBe('joinWait');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlotMs + 100);

    const welcome = h.sent.find((m) => m.type === ControlType.Welcome);
    expect(welcome).toBeDefined();
    expect(welcome.targetId).toBe(9);
  });

  it('holds a probe heard mid-announce and replies once the transmitter frees up', async () => {
    // 'announcing' is genuinely busy — our own probe is playing. The reply
    // must be queued rather than dropped, then sent when we reach joinWait.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs - 10);
    expect(h.room.state).toBe('listening');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);

    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('two devices in joinWait each welcome the other', async () => {
    // The reported symptom, as a test: neither device is idle, both hear the
    // other, both must welcome.
    const a = makeHarness(1);
    const b = makeHarness(2);
    a.room.start();
    b.room.start();
    await a.tick(ROOM_TIMING.listenMs + 50);
    await b.tick(ROOM_TIMING.listenMs + 50);
    expect(a.room.state).toBe('joinWait');
    expect(b.room.state).toBe('joinWait');

    a.room.onProbeHeard(2, flatGrid, PROBE_PURPOSE.joining);
    b.room.onProbeHeard(1, flatGrid, PROBE_PURPOSE.joining);
    await a.tick(ROOM_TIMING.replySlotMs + 100);
    await b.tick(ROOM_TIMING.replySlotMs + 100);

    expect(a.sent.find((m) => m.type === ControlType.Welcome)?.targetId).toBe(2);
    expect(b.sent.find((m) => m.type === ControlType.Welcome)?.targetId).toBe(1);
  });

  it('replies with the type the newest probe asked for', async () => {
    // A queued reply's purpose is overwritten by a fresh probe, because the
    // newest announcement is the true one: a device that ran a roll call and
    // then refreshed and rejoined needs a WELCOME, not the REPORT its earlier
    // probe queued.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs - 10); // 'listening' — transmitter held

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.rollCall);
    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);

    expect(h.sent.filter((m) => m.type === ControlType.Report)).toHaveLength(0);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });

  it('does not reply while sending or receiving', async () => {
    // Our transmitter is genuinely occupied by a file. Queue, do not talk
    // over it.
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.FileComing, senderId: 8, targetId: 0,
      payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
    });
    expect(h.room.state).toBe('receiving');

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(0);

    // ...but once the transfer's deadline returns us to idle, it goes out.
    await h.tick(2000 + 5000 + ROOM_TIMING.replySlotMs + 200);
    expect(h.room.state).toBe('idle');
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modem/test/roomProtocol.test.ts`

Expected: FAIL on the new tests — "replies to a probe heard while in joinWait" finds no WELCOME (`welcome` is `undefined`), and "holds a probe heard mid-announce" sends nothing at all because the probe was dropped rather than queued.

- [ ] **Step 3: Replace the dedupe set with a reply queue**

In `src/modem/chatter/roomProtocol.ts`, replace the `pendingReplyTo` field (`:148-151`) with:

```typescript
  /**
   * Replies owed to probers, keyed by prober id.
   *
   * A queue rather than a state-gated side effect. Reply duty used to exist
   * only in 'idle', so a probe heard in any other state updated the member
   * table and sent nothing — and two devices joining within a few seconds of
   * each other are BOTH in joinWait when the other's probe arrives, so
   * neither ever welcomed and both declared an empty room. Now the reply is
   * recorded when the probe is heard and sent when our own transmitter is
   * next free (see canTransmitReply).
   *
   * `scheduled` is the dedupe that `pendingReplyTo` used to be: it marks an
   * entry whose slot chain is already in flight, so a repeat probe from the
   * same device — or a setState that re-drains the queue — cannot start a
   * second chain for it.
   */
  private readonly replyQueue = new Map<number, PendingReply>();
```

Add the interface next to `PendingFile` (above the class):

```typescript
interface PendingReply {
  proberId: number;
  /** What the prober announced — decides WELCOME vs REPORT. Overwritten by a
   *  fresh probe, because the newest announcement is the true one: a device
   *  that ran a roll call and then refreshed and rejoined needs a WELCOME. */
  purpose: ProbePurpose;
  /** Sends attempted for this reply. Task-4 retry budget. */
  attempts: number;
  /** A slot chain is already in flight for this entry. */
  scheduled: boolean;
}
```

- [ ] **Step 4: Rewrite onProbeHeard**

Replace the body of `onProbeHeard` — Task 2 already replaced the membership inference with the purpose bit, so what changes here is the `this._state === 'idle'` gate and the `pendingReplyTo` dedupe, both of which the queue subsumes. Keep Task 2's comment about the reply type coming off the wire.

```typescript
  /** worker heard a probe: id + measured grid + what it announced */
  onProbeHeard(deviceId: number, grid: number[], purpose: ProbePurpose = PROBE_PURPOSE.joining): void {
    const existing = this._members.get(deviceId);
    this._members.set(deviceId, { ...existing, deviceId, lastHeardMs: this.deps.now(), heardGrid: grid });

    // Reply type comes off the wire (see PROBE_PURPOSE), not from whether we
    // already know this prober — see the note kept from the previous change.
    // A fresh probe overwrites a queued entry's purpose: the newest
    // announcement is the true one.
    const queued = this.replyQueue.get(deviceId);
    if (queued) queued.purpose = purpose;
    else this.replyQueue.set(deviceId, { proberId: deviceId, purpose, attempts: 0, scheduled: false });

    this.drainReplyQueue();
  }
```

- [ ] **Step 5: Add the eligibility check and the drain**

Add both to the "reply-to-probe" section, above `scheduleReply`:

```typescript
  /**
   * Whether a reply may be transmitted right now.
   *
   * Not a single state: what matters is that OUR transmitter is free, which is
   * true in 'idle' and in 'joinWait'. joinWait is safe because
   * beginAnnounceJoin awaits its own playProbe before entering it, so nothing
   * of ours is in the air, and the joinWait deadline already allows for a full
   * control message (see beginAnnounceJoin's timer).
   *
   * 'listening' and 'collecting' are excluded for a different reason than
   * 'announcing'/'sending'/'receiving': in those two we are measuring the air
   * or counting replies, and our own burst would corrupt the measurement.
   */
  private canTransmitReply(): boolean {
    return this._state === 'idle' || this._state === 'joinWait';
  }

  /** Start a slot chain for every queued reply that does not already have one. */
  private drainReplyQueue(): void {
    if (!this.canTransmitReply()) return;
    for (const entry of Array.from(this.replyQueue.values())) {
      if (entry.scheduled) continue;
      entry.scheduled = true;
      this.scheduleReply(
        this.deps.now(),
        Array.from({ length: ROOM_TIMING.replySlots }, (_unused, i) => i),
        entry,
      );
    }
  }
```

- [ ] **Step 6: Rewrite scheduleReply against the queue entry**

Replace `scheduleReply` (`roomProtocol.ts:477-533`):

```typescript
  private scheduleReply(baseTimeMs: number, candidateSlots: number[], entry: PendingReply): void {
    if (candidateSlots.length === 0) {
      this.replyQueue.delete(entry.proberId); // give up — no slot left to try
      return;
    }
    const idx = Math.floor(this.deps.rng() * candidateSlots.length);
    const slot = candidateSlots[idx];
    const laterSlots = candidateSlots.filter((s) => s > slot);
    const delay = Math.max(0, baseTimeMs + slot * ROOM_TIMING.replySlotMs - this.deps.now());

    this.timer(delay, async () => {
      // Not eligible any more (a transfer started, a roll call began): HOLD
      // the entry and clear `scheduled` so the next setState into an eligible
      // state re-drains it. Dropping it here is the old bug.
      if (!this.canTransmitReply()) {
        entry.scheduled = false;
        return;
      }
      try {
        const busy = await this.deps.isAirBusy();
        if (!this.canTransmitReply()) {
          entry.scheduled = false;
          return;
        }

        if (busy) {
          this.scheduleReply(baseTimeMs, laterSlots, entry); // still pending — chain continues
          return;
        }
        const heardGrid = this._members.get(entry.proberId)?.heardGrid ?? [];
        await this.deps.sendMessage(
          entry.purpose === PROBE_PURPOSE.rollCall
            ? {
                type: ControlType.Report,
                senderId: this.deps.deviceId,
                targetId: entry.proberId,
                payload: packReport(heardGrid),
              }
            : {
                type: ControlType.Welcome,
                senderId: this.deps.deviceId,
                targetId: entry.proberId,
                payload: packWelcome({ claim: DEFAULT_CLAIM, grid: heardGrid }),
              },
        );
        this.replyQueue.delete(entry.proberId);
      } catch (err) {
        // isAirBusy/sendMessage rejected — surface the error and stop blocking
        // this prober.
        this.replyQueue.delete(entry.proberId);
        this._lastError = err instanceof Error ? err.message : String(err);
      }
    });
  }
```

- [ ] **Step 7: Re-drain when the transmitter frees up**

Replace `setState` (`roomProtocol.ts:563-566`):

```typescript
  private setState(next: RoomState): void {
    this._state = next;
    this.deps.onStateChange?.(next, Array.from(this._members.values()));
    // Entering an eligible state is the moment a held reply can go out. Every
    // transition routes through here, so this is the single re-arm point —
    // there is no state whose entry can forget to check the queue.
    if (next === 'idle' || next === 'joinWait') this.drainReplyQueue();
  }
```

`drainReplyQueue` only registers timers, so it cannot re-enter `setState` synchronously.

- [ ] **Step 8: Clear the queue on stop and on a cold error**

In `stop()` (`roomProtocol.ts:185-188`), replace `this.pendingReplyTo.clear()` with:

```typescript
    this.replyQueue.clear();
```

In `handleDepsError`'s `cold` branch (`:552-556`), replace `this.pendingReplyTo.clear()` with:

```typescript
      this.replyQueue.clear();
```

- [ ] **Step 9: Update the state-chart comment**

The header comment at `roomProtocol.ts:11-41` shows `onProbeHeard (reply slot)` hanging off `idle` only. Update that line and add a note:

```
 *   idle/joinWait --onProbeHeard--> (queued reply, slotted + carrier-sensed)
```

and after the existing paragraph about timers, add:

```
 * Replies to probes are QUEUED, not state-gated: `onProbeHeard` records what
 * is owed and `drainReplyQueue` sends it whenever the local transmitter is
 * free (`canTransmitReply`). Gating the send on a single state meant two
 * devices joining at once were both in `joinWait` when the other's probe
 * arrived and neither ever replied.
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/roomProtocol.test.ts`

Expected: PASS. All pre-existing tests in this file must still pass — in particular "onProbeHeard twice for the same prober while idle only schedules one WELCOME chain" (the `scheduled` flag preserves that) and "a REPORT received while in joinWait refreshes the member but is not counted toward roll call".

- [ ] **Step 11: Run the full suite and lint**

Run: `npm run test && npm run lint`

Expected: PASS except the 3 known BPSK failures. `chatterController.test.ts:169` ("routes a worker probeHeard event into the protocol and replies WELCOME") emits `probeHeard` without a purpose; the default makes it a joining probe, so it still expects a WELCOME.

- [ ] **Step 12: Commit**

```bash
git add src/modem/chatter/roomProtocol.ts src/modem/test/roomProtocol.test.ts
git commit -m "fix(chatter): queue probe replies instead of gating them on idle

Reply duty existed only in state 'idle'. A probe heard anywhere else
updated the member table and sent nothing — so two devices joining within
a few seconds were both in joinWait when the other's probe arrived,
neither welcomed, and both declared an empty room.

Replies are now queued when heard and drained whenever our own
transmitter is free, which is idle or joinWait. The reply type comes off
the purpose bit rather than from whether we already knew the prober."
```

---

### Task 4: Retry a reply that was never acknowledged

A WELCOME is fire-and-forget. If it is lost, the joiner never learns the room is occupied and nothing retries.

**Files:**
- Modify: `src/modem/chatter/roomProtocol.ts` — reply section, `handleWelcome`, `handleReport`, `stop`, `handleDepsError`
- Test: `src/modem/test/roomProtocol.test.ts`

**Interfaces:**
- Consumes: `PendingReply`, `replyQueue`, `drainReplyQueue`, `canTransmitReply` from Task 3.
- Produces: no public API change. `MAX_REPLY_ATTEMPTS = 2` bounds the total sends per reply.

- [ ] **Step 1: Write the failing tests**

Add to `src/modem/test/roomProtocol.test.ts`:

```typescript
  it('retries a reply once when the prober never answers', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // Nothing heard back within one slot window → one more attempt.
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.replySlotMs + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(2);
  });

  it('stops after two attempts', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(2);
  });

  it('does not retry once the prober is heard from', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);

    h.room.onProbeHeard(9, flatGrid, PROBE_PURPOSE.joining);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);

    // 9 answers — a REPORT addressed to us proves it heard the welcome.
    h.room.onMessage({ type: ControlType.Report, senderId: 9, targetId: 2, payload: packReport(flatGrid) });
    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Welcome)).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modem/test/roomProtocol.test.ts -t "retries a reply once"`

Expected: FAIL — the WELCOME count stays at 1; no retry exists.

- [ ] **Step 3: Add the ack table and the retry arm**

In `src/modem/chatter/roomProtocol.ts`, add the constant next to `TRANSFER_TAIL_MARGIN_MS`:

```typescript
/** Total sends per owed reply, including the first. A lost WELCOME leaves the
 *  joiner believing the room is empty, so one retry is worth roughly two
 *  seconds of extra airtime; more than that just makes a genuinely deaf peer
 *  expensive for everyone else. */
const MAX_REPLY_ATTEMPTS = 2;
```

Add the field beside `replyQueue`:

```typescript
  /**
   * Replies transmitted but not yet known to have landed, keyed by prober id.
   *
   * "Acknowledged" is deliberately loose: anything at all heard from that
   * prober (a fresh probe, a REPORT, a WELCOME) proves the link works in the
   * direction that matters, and the room has no dedicated ack frame. Entries
   * that age out without any of that are re-queued once.
   */
  private readonly awaitingAck = new Map<number, PendingReply>();
```

Add the arming method to the reply section, below `scheduleReply`:

```typescript
  /** Watch for an answer from `entry.proberId`; re-queue the reply once if
   *  none arrives within a slot window. */
  private armReplyAck(entry: PendingReply): void {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_REPLY_ATTEMPTS) return;

    const retry: PendingReply = { ...entry, attempts, scheduled: false };
    this.awaitingAck.set(entry.proberId, retry);
    this.timer(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs, () => {
      const pending = this.awaitingAck.get(entry.proberId);
      if (!pending) return; // acknowledged — nothing to do
      this.awaitingAck.delete(entry.proberId);
      // A newer probe already queued a fresh reply; that one supersedes this
      // retry (and carries the newer purpose).
      if (this.replyQueue.has(entry.proberId)) return;
      this.replyQueue.set(entry.proberId, pending);
      this.drainReplyQueue();
    });
  }
```

- [ ] **Step 4: Arm on send, clear on any contact**

In `scheduleReply`'s success path (Task 3, Step 6), replace:

```typescript
        this.replyQueue.delete(entry.proberId);
```

with:

```typescript
        this.replyQueue.delete(entry.proberId);
        this.armReplyAck(entry);
```

In `onProbeHeard`, clear the ack right after the member upsert — hearing a probe is contact:

```typescript
    this.awaitingAck.delete(deviceId);
```

In `handleWelcome`, after the `_members.set` call (`roomProtocol.ts:273-279`):

```typescript
    this.awaitingAck.delete(msg.senderId);
```

In `handleReport`, after its `_members.set` call (`:311-317`):

```typescript
    this.awaitingAck.delete(msg.senderId);
```

- [ ] **Step 5: Clear the ack table on stop and on a cold error**

In `stop()`, beside `this.replyQueue.clear()`:

```typescript
    this.awaitingAck.clear();
```

In `handleDepsError`'s `cold` branch, beside `this.replyQueue.clear()`:

```typescript
      this.awaitingAck.clear();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/roomProtocol.test.ts`

Expected: PASS, including the three new retry tests and every pre-existing test.

Note for the implementer: "onProbeHeard twice for the same prober while idle only schedules one WELCOME chain" ticks `replySlots * replySlotMs + collectExtraMs`, which is longer than one slot window — so the retry can fire inside it. If that test now sees 2 WELCOMEs, that is the retry working correctly, not a regression: change that test's assertion to `toHaveLength(1)` measured over a window shorter than one slot window (`await h.tick(ROOM_TIMING.replySlotMs + 100)`), keeping its original intent (one chain per prober, not one send ever).

- [ ] **Step 7: Run the full suite and lint**

Run: `npm run test && npm run lint`

Expected: PASS except the 3 known BPSK failures. If `chatterLoopback.test.ts` now sees extra WELCOME traffic, that is the retry; assert on "at least one" rather than an exact count there.

- [ ] **Step 8: Commit**

```bash
git add src/modem/chatter/roomProtocol.ts src/modem/test/
git commit -m "fix(chatter): retry a welcome the prober never answered

A WELCOME was fire-and-forget: lost it, and the joiner believed the room
was empty with nothing to correct it. Anything heard back from the prober
counts as the ack, since the room has no ack frame and any traffic proves
the direction that matters. Bounded at two sends total."
```

---

### Task 5: Make the sync-chirp centre per-engine

Preparation for Task 6, with no behavioural change on its own. `OFDM_TUNING.chirpCenterHz` (1850 Hz, 200 Hz span, so 1750-1950) is read directly by `OFDMEngine.generateChirpBurst` (`ofdmEngine.ts:164-165`) and by `RxEngine`'s template construction (`rxEngine.ts:1560-1567`). Task 6 moves the handshake tones down to 2600-2950 Hz, which would put them next to that chirp — the configuration that produced a 17 dB received-level swing and zero decoded frames (`types.ts:276-282`).

The chirp centre becomes a per-engine value, defaulting to `OFDM_TUNING.chirpCenterHz` so nothing moves yet.

**Files:**
- Modify: `src/modem/types.ts:232-243` (add `chirpCenterHz` to `OFDM_HANDSHAKE`)
- Modify: `src/modem/protocol/ofdmEngine.ts:33-34` (field), `:44-54` (cfg), `:66` (assignment), `:162-169` (`chirpCfg`)
- Modify: `src/modem/protocol/rxEngine.ts:152-153` (field), `:434-445` (bandHandshake block), `:1560-1567` (`chirpCfg`)
- Modify: `src/modem/protocol/txEngine.ts:159-171` (handshake engine construction)
- Test: `src/modem/test/bandHandshake.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `OFDM_HANDSHAKE.chirpCenterHz: number` — the handshake band's own sync-chirp centre.
  - `OFDMEngine` cfg gains `chirpCenterHz?: number`, defaulting to `OFDM_TUNING.chirpCenterHz`.
  - `RxEngine` derives its chirp centre from `bandHandshake` mode: `OFDM_HANDSHAKE.chirpCenterHz` when card-listening, `OFDM_TUNING.chirpCenterHz` otherwise. Not a constructor option — deriving it from the mode is what guarantees TX and RX agree, since `TxEngine` picks it the same way.

- [ ] **Step 1: Confirm the two chirp-centre read sites are the only ones**

Run: `grep -rn "chirpCenterHz" src`

Expected: `types.ts` (the definition and its doc), `ofdmEngine.ts:163-165`, `rxEngine.ts:1562-1564`, and comments. If any other read site appears, it must be routed through the same per-engine value in this task — a missed site is a TX/RX template mismatch, which silently syncs nothing.

- [ ] **Step 2: Write the failing test**

Add to `src/modem/test/bandHandshake.test.ts`, inside `describe('band handshake: TX')`. Read `:44-70` first and reuse that file's existing config/engine helpers rather than inventing new ones.

```typescript
  it(
    'puts the handshake segment chirp on the handshake band\'s own centre, not the target band\'s',
    () => {
      // The chirp is the loudest thing in a transmission and the chain
      // compresses per band, so it must not sit next to the tones it precedes
      // (types.ts documents a 17 dB received-level swing and zero decoded
      // frames from exactly that). The handshake band therefore carries its
      // own chirp centre, and the target band keeps OFDM_TUNING's.
      expect(OFDM_HANDSHAKE.chirpCenterHz).not.toBe(OFDM_TUNING.chirpCenterHz);

      const handshake = new OFDMEngine({
        sampleRate: SR,
        toneCount: OFDM_HANDSHAKE.toneCount,
        pilotFreqHz: OFDM_HANDSHAKE.pilotFreqHz,
        toneStartHz: OFDM_HANDSHAKE.toneStartHz,
        chirpCenterHz: OFDM_HANDSHAKE.chirpCenterHz,
      });
      const target = new OFDMEngine({ sampleRate: SR, toneCount: 32 });

      const hsCfg = handshake.generateChirpBurst(OFDM_TUNING.chirpSymbols).chirpCfg;
      const tgtCfg = target.generateChirpBurst(OFDM_TUNING.chirpSymbols).chirpCfg;

      expect((hsCfg.fStart + hsCfg.fEnd) / 2).toBeCloseTo(OFDM_HANDSHAKE.chirpCenterHz, 6);
      expect((tgtCfg.fStart + tgtCfg.fEnd) / 2).toBeCloseTo(OFDM_TUNING.chirpCenterHz, 6);
    },
  );
```

Ensure `OFDM_HANDSHAKE`, `OFDM_TUNING`, and `OFDMEngine` are imported in that file; add whichever are missing.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/modem/test/bandHandshake.test.ts -t "handshake band's own centre"`

Expected: FAIL — `OFDM_HANDSHAKE.chirpCenterHz` is `undefined`, so the first assertion's `not.toBe` passes vacuously and `toBeCloseTo(undefined)` throws.

- [ ] **Step 4: Give the handshake band a chirp centre**

In `src/modem/types.ts`, add to `OFDM_HANDSHAKE` (keeping the existing fields and their comments):

```typescript
  /**
   * Sync-chirp centre for THIS band only, decoupled from
   * OFDM_TUNING.chirpCenterHz.
   *
   * The chirp is the loudest thing in a transmission and the transmit chain
   * compresses per band, so a chirp sitting next to the tones it precedes
   * compresses them and then releases across the frame — measured as the
   * received pilot going 0.367 during training to 2.67 during data, a 17 dB
   * swing, with no frame decoding (see OFDM_TUNING.chirpCenterHz). The global
   * value is parked at 1850 Hz for exactly that reason, well below any data
   * band. Once the handshake band moved DOWN to 2600-2950 Hz, 1850 stopped
   * being "well below" and became "adjacent", so this band needs its own.
   *
   * 4400 Hz: the probe burst's own down-chirp already sweeps through here and
   * is decoded reliably on this hardware, and it clears the handshake tones by
   * ~1.35 kHz — comfortably more than the 500 Hz separation that failed.
   *
   * The chirp only provides coarse timing, so its frequency is unconstrained
   * by anything else. TX and RX must agree: both derive it from
   * `bandHandshake` mode rather than passing it around, so there is no
   * configuration in which one side reads this and the other does not.
   */
  chirpCenterHz: 4400,
```

- [ ] **Step 5: Make OFDMEngine's chirp centre configurable**

In `src/modem/protocol/ofdmEngine.ts`, add the field beside `chirpSpanHz` (`:33-34`):

```typescript
  /** Chirp centre (Hz) — see OFDM_TUNING.chirpCenterHz and, for the handshake
   *  band's own value, OFDM_HANDSHAKE.chirpCenterHz. */
  private chirpCenterHz: number;
```

Add to the constructor's cfg type (`:44-54`):

```typescript
    chirpCenterHz?: number;
```

Assign beside `chirpSpanHz` (`:66`):

```typescript
    this.chirpCenterHz = cfg.chirpCenterHz ?? OFDM_TUNING.chirpCenterHz;
```

In `generateChirpBurst`'s `chirpCfg` (`:162-166`), replace both reads:

```typescript
    const chirpCfg: ChirpConfig = {
      // Centred on this engine's chirpCenterHz, NOT the pilot — see
      // OFDM_TUNING.chirpCenterHz. Per-engine because the handshake band sits
      // low enough that the global centre would be adjacent to its tones.
      fStart: this.chirpCenterHz - halfSpan,
      fEnd: this.chirpCenterHz + halfSpan,
```

Verify `OFDM_TUNING` is already imported in `ofdmEngine.ts` (it is — `generateChirpBurst` reads it today).

- [ ] **Step 6: Give the TX handshake engine the handshake centre**

In `src/modem/protocol/txEngine.ts`, add to the `handshakeEngine` construction (`:159-171`), after `toneStartHz`:

```typescript
          // The handshake band's own chirp centre — the global one is 1850 Hz,
          // which is adjacent to this band's tones and would compress them.
          chirpCenterHz: OFDM_HANDSHAKE.chirpCenterHz,
```

`OFDM_HANDSHAKE` is already imported there (`txEngine.ts:16`).

- [ ] **Step 7: Derive RxEngine's chirp centre from the mode**

In `src/modem/protocol/rxEngine.ts`, add beside `chirpSpanHz` (`:152-153`):

```typescript
  /** Chirp detection: centre Hz. Set from OFDM_HANDSHAKE in card-listening
   *  mode (see the constructor) — derived from the mode, not passed in, so it
   *  can never disagree with what TxEngine chose the same way. */
  private chirpCenterHz = OFDM_TUNING.chirpCenterHz;
```

In the `bandHandshake` block (`:434-445`), add after the `toneCount` assignment:

```typescript
      this.chirpCenterHz = OFDM_HANDSHAKE.chirpCenterHz;
```

and extend that block's `dlog` so a mismatch is visible in a dump:

```typescript
      dlog('RX-OFDM', { handshakeBand: true, pilot: this.cfg.pilotFreqHz, chirp: this.chirpCenterHz });
```

In the template construction (`:1560-1567`), replace both reads:

```typescript
    const chirpCfg: ChirpConfig = {
      // MUST match OFDMEngine.generateChirpBurst: centred on this engine's
      // chirpCenterHz, not on the pilot. Deriving it from the pilot here would
      // make the template the wrong shape the moment the pilot moves.
      fStart: this.chirpCenterHz - halfSpan,
      fEnd: this.chirpCenterHz + halfSpan,
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/bandHandshake.test.ts src/modem/test/chatterLoopback.test.ts src/modem/test/chatterWorker.test.ts`

Expected: PASS. `bandHandshake.test.ts`'s byte-identity assertions must still pass — the target-band path's chirp did not move, and the handshake segment's did, so if a byte-identity test covering the *target* band fails, the change leaked.

- [ ] **Step 9: Run the full suite and lint**

Run: `npm run test && npm run lint`

Expected: PASS except the 3 known BPSK failures. `chatterLoopback.test.ts` is the real gate here: the handshake chirp moved for both TX and RX, so if they disagree, nothing syncs and that test fails outright.

- [ ] **Step 10: Commit**

```bash
git add src/modem/types.ts src/modem/protocol/ofdmEngine.ts src/modem/protocol/rxEngine.ts src/modem/protocol/txEngine.ts src/modem/test/bandHandshake.test.ts
git commit -m "refactor(modem): give the handshake band its own sync-chirp centre

The chirp is the loudest thing in a transmission and the chain compresses
per band, so it is parked at 1850 Hz specifically to stay far from any
data band. Moving the handshake band down would make 1850 adjacent to it
— the arrangement that produced a 17 dB received-level swing and no
decoded frames.

Chirp centre is now per-engine. Both sides derive it from bandHandshake
mode rather than passing it around, so TX and RX cannot disagree. No
frequency has moved yet; behaviour is unchanged."
```

---

### Task 6: Move the handshake band to 2600-2950 Hz

Every control message rides this band. At 6900-7250 Hz it is where a phone's speaker and microphone are both worst, while the probe burst it is paired with sweeps 1500-7800 Hz and decodes reliably — the two halves of the same handshake have opposite robustness.

Pilot 6300 → 2000, tones 6900-7250 → 2600-2950. `toneStartHz` stays 600, so the pilot-to-tone ratio goes from 1.15 to 1.48 — well inside the range documented as harmless (1.15 safe, 3.9 catastrophic). `MIN_TONE_START_HZ` is deliberately **not** touched: it is global, shared by every `ofdmToneFrequencies` caller specifically so the clamp cannot diverge between TX and RX, and lowering it would silently move every chatter-negotiated band too.

**This task's over-the-air result is a hypothesis until measured.** It ends with a mandatory stop.

**Files:**
- Modify: `src/modem/types.ts:189-243` (`OFDM_HANDSHAKE` values + doc)
- Modify: `src/modem/chatter/handshakeGains.ts:1-20` (doc comment only)
- Modify: `docs/MODEM.md` (band references)
- Test: `src/modem/test/bandHandshake.test.ts`, `src/modem/test/chatterLoopback.test.ts`

**Interfaces:**
- Consumes: `OFDM_HANDSHAKE.chirpCenterHz` from Task 5.
- Produces: `OFDM_HANDSHAKE.pilotFreqHz = 2000`, `toneStartHz = 600` (unchanged), tones at 2600-2950 Hz. Everything that needs these derives them — `handshakeGains.ts:63`, `chatterController.ts:149-150`, `rxEngine.ts:441-443` — so no other call site changes.

- [ ] **Step 1: Find every hardcoded 6300 / 6900 / 7250 in tests and source**

Run: `grep -rn "6300\|6900\|7250" src docs`

For each hit, decide: is it the *handshake* band (must move) or a *target* band value used as arbitrary test config (must not move)? `roomProtocol.test.ts:142` and `:183` pass `pilotFreqHz: 6300` inside `packFileComing` — that is a target band in a protocol test, unrelated to the handshake band, and must stay. Record the list before editing so nothing is missed and nothing is over-corrected.

- [ ] **Step 2: Write the failing test**

Add to `src/modem/test/bandHandshake.test.ts`, inside `describe('band handshake: TX')`:

```typescript
  it('keeps the handshake band inside the hardware sweet spot and clear of its chirp', () => {
    // This band carries every control message. At 6900-7250 Hz it sat where
    // phone speakers and mics are both worst, which is a single point of
    // failure for the whole control plane.
    const firstTone = OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz;
    const lastTone = firstTone + (OFDM_HANDSHAKE.toneCount - 1) * OFDM_DEFAULTS.toneSpacingHz;

    expect(firstTone).toBe(2600);
    expect(lastTone).toBe(2950);

    // Pilot phase is extrapolated to each tone by toneFreq/pilotFreq, so any
    // error in the pilot measurement is multiplied by this. 3.9 shipped
    // broken; 1.15 was fine.
    expect(lastTone / OFDM_HANDSHAKE.pilotFreqHz).toBeLessThan(1.6);

    // The chirp must stay far from the tones it precedes — 500 Hz was not
    // enough (types.ts documents the 17 dB swing).
    const halfSpan = 100; // OFDMEngine's default chirpSpanHz is 200
    expect(OFDM_HANDSHAKE.chirpCenterHz - halfSpan - lastTone).toBeGreaterThan(1000);
  });
```

Add `OFDM_DEFAULTS` to that file's imports if it is not already there.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/modem/test/bandHandshake.test.ts -t "hardware sweet spot"`

Expected: FAIL — `expect(firstTone).toBe(2600)` receives 6900.

- [ ] **Step 4: Move the band**

In `src/modem/types.ts`, replace the `OFDM_HANDSHAKE` doc block and the two frequency values. The existing doc is a record of two bench failures and must be preserved, not deleted — rewrite it so it still explains both, at the new numbers.

```typescript
/**
 * The FIXED handshake config — the only band knowledge a receiver needs when
 * bandHandshake is enabled. TX transmits chirp + preamble + the band card
 * here (see bandCard.ts); the card announces the real band and both sides
 * hop, the receiver by swapping in a fresh engine (HandshakeReceiver).
 *
 * 8 QPSK tones at 2600-2950 Hz. Few tones = maximum power per tone.
 *
 * WHY THIS BAND, and not the 6900-7250 Hz it shipped with: that range decoded
 * at MER 21-22 dB on the weakest hardware then measured (a laptop DMIC +
 * micro-speaker), which is ~11 dB of margin over QPSK's ~10 dB. But it is also
 * where phone speakers and microphones are both at their worst, and this band
 * carries EVERY control message — so on a phone the entire control plane sat
 * in the least reproducible part of the spectrum while the probe burst it is
 * paired with sweeps 1500-7800 Hz and decodes reliably. 2600-2950 is inside
 * the same 2-4 kHz sweet spot OFDM_DEFAULTS targets.
 *
 * CHANGING ANY VALUE BREAKS COMPATIBILITY with every deployed receiver — this
 * is a wire constant, not a tuning knob. Both devices must update together.
 *
 * The PILOT sits directly below the tones, and must stay there. Drift
 * correction extrapolates the pilot's measured phase by toneFreq/pilotFreq
 * (see rxEngine), so the further the pilot is from the band, the more any
 * ERROR in that phase measurement is amplified — noise, a fractional-sample
 * estimate, residual drift. A pure timing offset extrapolates exactly; the
 * ratio multiplies the error. This band shipped with the pilot at 1850 while
 * its tones sat at 6900-7250, a factor of ~3.9, so roughly 12 degrees of pilot
 * uncertainty was enough to cross QPSK's 45 degree decision boundary at the
 * top tone. Loopback is noise-free and decoded perfectly; over the air nothing
 * ever did — two devices in a room detected each other's chirps (norm 0.6,
 * handoff score 0.75, training collected) and then failed to demodulate a
 * single control frame in either direction, with no sentinel ever found.
 * Pilot 2000 under tones ending at 2950 puts the factor at ~1.48.
 *
 * toneStartHz stays at 600 rather than tightening the ratio further:
 * ofdmToneFrequencies clamps the offset to MIN_TONE_START_HZ (600) so tones
 * can never land on the pilot, and that constant is GLOBAL — shared by every
 * caller, TX and RX alike, precisely so the clamp cannot diverge between the
 * two sides. Lowering it to buy a 1.33 ratio here would silently move every
 * chatter-negotiated band as well, which is a far larger blast radius than the
 * ratio is worth at these frequencies.
 *
 * chirpCenterHz: see the field's own comment. In short, the global 1850 Hz
 * centre was chosen to sit far below any data band, and once this band moved
 * down to 2600 Hz it was no longer far from it.
 *
 * gapSymbols: silence between the handshake segment and the target-band
 * transmission. The post-hop engine must meet the target chirp the way a
 * cold receiver does — quiet first. Bench 2026-08-03: without the gap, the
 * chirp correlator fired on the card symbols' pilot at norm ~0.15, the CP
 * probe then VALIDATED the false detect because cards are real OFDM with real
 * cyclic prefixes, and the engine trained during the actual chirp — target
 * tones measured ~1e-4 and the transfer was dead before it started.
 */
export const OFDM_HANDSHAKE = {
  pilotFreqHz: 2000,
  toneStartHz: 600, // offset above the pilot — tones at 2600-2950 Hz
  toneCount: 8,
  gapSymbols: 8,
  chirpCenterHz: 4400, // keep this field's Task-5 comment block
} as const;
```

- [ ] **Step 5: Update the stale band references in comments and docs**

`src/modem/chatter/handshakeGains.ts:7-8` says "the handshake tones sit at 6900-7250 Hz, where laptop speakers and mics are already rolling off". The module derives its frequencies from `OFDM_HANDSHAKE` (`:63`), so only the prose is wrong:

```
 * bad on a real one — the handshake tones sit at 2600-2950 Hz, and a control
 * frame that dies there takes the whole exchange with it.
```

In `docs/MODEM.md`, update every reference to the handshake band's frequencies to 2600-2950 Hz with pilot 2000, and note the chirp centre. Run `grep -n "6900\|7250\|6300" docs/MODEM.md` to find them.

Also check `src/modem/protocol/bandCard.ts:4` and `src/ui/controllers/chatterController.ts:137-157` for prose naming the old frequencies; `chatterController`'s `handshakeBandDb` computes from `OFDM_HANDSHAKE` so only comments can be stale.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/bandHandshake.test.ts src/modem/test/chatterLoopback.test.ts src/modem/test/handshakeGains.test.ts src/modem/test/chatterWorker.test.ts src/modem/test/controlFrame.test.ts`

Expected: PASS. `chatterLoopback.test.ts` is the gate — it drives real synthesised audio through a full join, roll call, and negotiated transfer, so it fails outright if TX and RX disagree about the new band or its chirp.

- [ ] **Step 7: Run the full suite and lint**

Run: `npm run test && npm run lint`

Expected: PASS except the 3 known BPSK failures.

- [ ] **Step 8: Commit**

```bash
git add src/modem/types.ts src/modem/chatter/handshakeGains.ts src/modem/protocol/bandCard.ts src/ui/controllers/chatterController.ts docs/MODEM.md src/modem/test/bandHandshake.test.ts
git commit -m "feat(chatter): move the handshake band to 2600-2950 Hz

Every control message rides this band. At 6900-7250 it sat where a
phone's speaker and mic are both worst, while the probe burst it pairs
with sweeps 1500-7800 and decodes reliably — opposite robustness in two
halves of the same handshake.

Pilot 2000 keeps the drift-extrapolation ratio at 1.48 (1.15 was fine,
3.9 shipped broken). MIN_TONE_START_HZ is deliberately untouched: it is
global, and lowering it to buy 1.33 would move every negotiated band too.

Breaks wire compatibility. Both devices must update together. Loopback
passes; the over-air margin is not yet measured."
```

- [ ] **Step 9: STOP — hand back for an over-the-air measurement**

Do not proceed to Task 7 automatically. Report to the operator:

> The handshake band now sits at 2600-2950 Hz with the segment chirp at 4400 Hz, and the full loopback path passes. Loopback is noise-free, and this exact band choice has been wrong before in a way only hardware showed — 6900-7250 decoded perfectly in loopback and never once over the air at the wrong pilot ratio.
>
> Needed before this is called a fix: a two-device over-air run, phone included, reporting the handshake band's measured MER. `handshakeBandDb` already logs the band's level on every probe (`chatterController.ts:286-293`), and the decode ladder shows whether control frames land.
>
> Compare against the 21-22 dB the old band recorded. QPSK needs about 10 dB. If the new band does not clear that with comparable margin, revert Task 6 rather than tuning it in place — Task 5's per-engine chirp centre stands on its own and does not need reverting.

- [ ] **Step 10: Record the measurement**

Once the operator reports numbers, append them to `docs/superpowers/specs/2026-08-05-chatter-control-plane-design.md` under Verification — the measured MER, the hardware, and whether the band was kept. Commit:

```bash
git add docs/superpowers/specs/2026-08-05-chatter-control-plane-design.md
git commit -m "docs: record the measured MER for the relocated handshake band"
```

---

### Task 7: Make a failed chatter transfer legible on the device it failed on

The reported "out of memory" on a 40-byte file came with no readable log. There is a concrete reason the UI could show nothing useful: `startFileTx` (`chatterController.ts:258`) calls `void this.transmitFile(settings)`, and `transmitFile` awaits `playAndMute` without a `catch`. A rejection there — an encode failure, a playback failure — becomes an unhandled promise rejection. `chatterError` is never set, and `RoomProtocol` sits in `sending` until its own deadline, so the UI shows a transfer in progress that is already dead.

This task is diagnosis infrastructure, not a fix for the memory error. It is what makes Task 8 verifiable and the root cause findable.

**Files:**
- Modify: `src/ui/controllers/chatterController.ts:258` (`startFileTx`), `:598-644` (`transmitFile`)
- Modify: `src/workers/modemSchema.ts` (`error` event metadata)
- Modify: `src/workers/modemService.ts:512-533` (`encodeFileAsync` catch)
- Test: `src/modem/test/chatterController.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the `error` worker event gains two optional fields —
  `{ type: 'error'; id?: number; error: string; errorName?: string; command?: string }`.
  Optional so every existing `emit({ type: 'error', ... })` call site keeps compiling unchanged.

- [ ] **Step 1: Write the failing test**

Add to `src/modem/test/chatterController.test.ts`:

```typescript
  it('surfaces a failed file encode as chatterError instead of an unhandled rejection', async () => {
    // startFileTx fires transmitFile with `void`, so a rejection inside it had
    // nowhere to go: chatterError stayed null and the room sat in 'sending'
    // until its deadline, showing a transfer that was already dead. This is
    // the only signal a phone gets.
    const { controller, worker, clock } = makeController();
    worker.encodeFile = async () => { throw new Error('Out of memory'); };

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200,
    );
    await controller.broadcastFile('a.txt', new Uint8Array(40));
    await clock.tick(ROOM_TIMING.listenMs + 100);
    worker.emit('controlMessage', {
      msg: { type: ControlType.Report, senderId: 5, targetId: getState().chatterDeviceId, payload: packReport(flatGrid).buffer },
    });
    await clock.tick(
      ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200,
    );

    expect(getState().chatterError).toMatch(/Out of memory/);
  });
```

Read `chatterController.test.ts:40-140` and match its harness — the existing fake worker's `encodeFile`, `emit`, and `getState` usage are already established there; reuse them rather than adding new plumbing.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modem/test/chatterController.test.ts -t "surfaces a failed file encode"`

Expected: FAIL — `chatterError` is `null`. Vitest may additionally report an unhandled rejection, which is the bug itself.

- [ ] **Step 3: Catch the rejection in transmitFile**

In `src/ui/controllers/chatterController.ts`, wrap the `playAndMute` call at the end of `transmitFile` (`:638-643`):

```typescript
    // A rejection here used to vanish: startFileTx calls this with `void`, so
    // an encode or playback failure became an unhandled rejection —
    // chatterError stayed null and RoomProtocol sat in 'sending' until its own
    // deadline, presenting a dead transfer as a live one. On a phone, where
    // there is no console to check, that is the difference between a
    // diagnosable failure and a silent one.
    try {
      await this.playAndMute(() => this.worker.encodeFile(pending.fileName, pending.data), {
        kind: 'file',
        peerId: 0,
        bytes: pending.data.byteLength,
        note: pending.fileName,
      });
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      dlog('ROOM', { fileTxFailed: reason, name: pending.fileName, bytes: pending.data.byteLength }, { level: 'warn' });
      setState({ chatterError: `send failed: ${reason}` });
    }
```

Include the error's `name` as well as its message: a browser out-of-memory condition surfaces as `RangeError` on some engines and a bare `Error` on others, and the name is what distinguishes an allocation failure from a thrown application error.

- [ ] **Step 4: Carry the failing command in the worker's error event**

In `src/workers/modemSchema.ts`, extend the `error` event:

```typescript
  | {
      type: 'error';
      id?: number;
      error: string;
      /** Error constructor name — a browser allocation failure is a
       *  RangeError on some engines and a bare Error on others, and the
       *  message alone does not say which. */
      errorName?: string;
      /** The command that failed, so a log line points at a cause rather than
       *  just an effect. */
      command?: string;
    }
```

In `src/workers/modemService.ts`, `encodeFileAsync`'s catch (`:530-532`):

```typescript
    } catch (err) {
      const e = err as Error;
      dlog('TX-COMP', { encodeFileFailed: e.name, msg: e.message }, { level: 'warn' });
      this.emit({ type: 'error', id: cmd.id, error: e.message, errorName: e.name, command: 'encodeFile' });
    }
```

Apply the same three fields to `encodeStreamStartAsync`'s catch and `encodeControl`'s catch (`:444-446`) — those are the other two paths a chatter send can die on.

- [ ] **Step 5: Surface errorName where the promise is rejected**

`ModemController.encodeFile` rejects with `new Error(ev.error)` (`modemController.ts:93-108`), discarding `errorName`. Read that method and include the name so Task 3's `${err.name}: ${err.message}` is meaningful:

```typescript
        const offErr = this.on('error', (ev) => {
          if (ev.id !== id) return;
          offOk();
          offErr();
          const e = new Error(ev.error);
          if (ev.errorName) e.name = ev.errorName;
          reject(e);
        });
```

Apply the same to `encodeProbe` (`:246-256`), `encodeControl` (`:258-278`), and `startFileStream` (`:132-137`, `:164-170`).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/chatterController.test.ts src/modem/test/modemService.test.ts`

Expected: PASS, with no unhandled-rejection warning.

- [ ] **Step 7: Run the full suite and lint**

Run: `npm run test && npm run lint`

Expected: PASS except the 3 known BPSK failures.

- [ ] **Step 8: Commit**

```bash
git add src/ui/controllers/chatterController.ts src/ui/controllers/modemController.ts src/workers/modemSchema.ts src/workers/modemService.ts src/modem/test/
git commit -m "fix(chatter): a failed file send must say so, not vanish

startFileTx calls transmitFile with `void` and transmitFile had no catch,
so an encode or playback rejection became an unhandled rejection:
chatterError stayed null and the room sat in 'sending' until its deadline,
presenting a dead transfer as a live one. On a phone there is no console
to fall back to.

Worker errors now carry the error's constructor name and the command that
failed — an allocation failure is a RangeError on some engines and a bare
Error on others, and the message alone does not distinguish them."
```

- [ ] **Step 9: STOP — hand back for the reproduction**

Report to the operator:

> A failed chatter send now sets `chatterError` and logs `fileTxFailed` with the error's name, so the out-of-memory failure should be readable from room mode's `▤ log` on the phone itself.
>
> Needed: reproduce the 40-byte send on the phone and share that log. The error's *name* is the part that matters — it says whether this is a genuine allocation failure or an application error whose message happens to read that way, and those need different fixes.
>
> Task 8 is worth doing regardless and does not depend on this.

---

### Task 8: Stop allocating three copies of every transmission

`AudioPlayer.play` allocates a full `Float32Array` copy of the samples (`player.ts:55`), then `ctx.createBuffer` allocates a third backing store which the copy is written into (`:90-91`). Three copies of every waveform are live at once, on top of whatever the worker still holds.

Correct for a phone regardless of the out-of-memory cause. **Not** evidence that the memory error is fixed.

**Files:**
- Modify: `src/audio/player.ts:53-104` (`play`)
- Test: `src/modem/test/` — no existing player test; this task adds none, because `play` needs a real `AudioContext`. It is covered by the existing suite continuing to pass plus a manual bench send (Step 4).

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no API change. `AudioPlayer.play`'s signature and observable behaviour (volume, auto-normalise, clip counting, resolve-on-ended) are identical.

- [ ] **Step 1: Rewrite play to fill the AudioBuffer directly**

In `src/audio/player.ts`, replace the body of the returned promise (`:53-104`). The peak scan, the `scale` formula, the clip counting, and every `dlog` call must produce the same numbers as before — the only change is where the samples land.

```typescript
    return new Promise((resolve) => {
      // Write straight into the AudioBuffer's channel data.
      //
      // This used to build a scratch Float32Array, fill it, then `set()` it
      // into the buffer — so three copies of every waveform were live at once
      // (the caller's samples, the scratch, and the buffer's own backing
      // store). The buffer has to be allocated either way; the scratch does
      // not.
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      const out = buffer.getChannelData(0);

      if (clean) {
        out.set(samples);
      } else {
        // Find peak to auto-normalize
        let peak = 0;
        for (const element of samples) {
          const abs = Math.abs(element);
          if (abs > peak) peak = abs;
        }
        // Scale so that peak * volume * scale = 0.95 (no clipping)
        const targetPeak = 0.95;
        const scale = peak > 0 ? Math.min(targetPeak / (peak * this.volume), 5.0) : 1.0;

        if (scale < 1.0) {
          dlog('PLAY', { autoNorm: scale, peak, vol: this.volume }, { level: 'debug' });
        }

        let clips = 0;
        for (let i = 0; i < samples.length; i++) {
          const sample = samples[i] * this.volume * scale;
          if (sample > 1.0) {
            out[i] = 1.0;
            clips++;
          } else if (sample < -1.0) {
            out[i] = -1.0;
            clips++;
          } else {
            out[i] = sample;
          }
        }
        if (clips > 0) {
          dlog('PLAY', { clipped: clips }, { level: 'warn' });
        }
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      this.currentSource = source;
      source.start(0);

      source.onended = () => {
        dlog('PLAY', { done: ctx.currentTime.toFixed(2) }, { level: 'debug' });
        this.currentSource = null;
        resolve();
      };
    });
```

- [ ] **Step 2: Run the full suite and lint**

Run: `npm run test && npm run lint`

Expected: PASS except the 3 known BPSK failures.

- [ ] **Step 3: Commit**

```bash
git add src/audio/player.ts
git commit -m "perf(audio): fill the AudioBuffer directly instead of a scratch copy

play() built a scratch Float32Array, filled it, then set() it into the
AudioBuffer — three copies of every waveform live at once. The buffer has
to exist either way; the scratch does not. Levels, clip counting, and
logging are unchanged."
```

- [ ] **Step 4: Verify on real audio before moving on**

Automated tests do not cover `play` — it needs a real `AudioContext`. Run `npm run dev` and send a file over the bench path between two browser tabs. Confirm the receiver assembles it and the `PLAY` log line reports the same peak and clip counts it did before the change. A level change here would be a real regression: the receiver's amplitude reference is trained on the preamble, so a scaling error breaks every channel estimate.

---

### Task 9: Send chatter files through the streaming path

`chatterController.transmitFile` uses the batch `encodeFile`, which builds the entire waveform in the worker, transfers it whole, and hands it to `play`. `ModemController.startFileStream` (`modemController.ts:112-181`) and `AudioPlayer.playStream` (`player.ts:118-270`) already exist and bound peak memory to one ~0.5 s chunk; `app.ts:439` already uses them for the bench path.

**Files:**
- Modify: `src/ui/controllers/chatterController.ts:83-85` (`AudioPlayerLike`), `:96-112` (`ModemWorkerHandle`), `:474-524` (`playAndMute`/`doPlayAndMute`), `:598-644` (`transmitFile`)
- Test: `src/modem/test/chatterController.test.ts`

**Interfaces:**
- Consumes: Task 7's `transmitFile` catch block, which wraps whatever send call is used.
- Produces:
  - `AudioPlayerLike` gains
    `playStream(pull: () => Promise<Float32Array | null>, sampleRate: number, deviceId?: string, onProgress?: (scheduledSec: number) => void): Promise<void>`
  - `ModemWorkerHandle` gains
    `startFileStream(fileName: string, data: Uint8Array): Promise<{ sampleRate: number; totalSamples: number; pull: () => Promise<Float32Array | null>; cancel: () => void }>`
  - `ChatterController` gains a private
    `playStreamAndMute(start: () => Promise<{ sampleRate: number; pull: () => Promise<Float32Array | null>; cancel: () => void }>, packet: Omit<ChatterPacket, 'seq' | 'tMs' | 'dir'>): Promise<void>`

- [ ] **Step 1: Write the failing test**

Add to `src/modem/test/chatterController.test.ts`:

```typescript
  it('transmits a chatter file through the streaming path, not the batch encoder', async () => {
    // Batch encode builds the whole waveform in the worker, transfers it
    // whole, and hands it to play() — which is the largest single allocation
    // in a send. The streaming path bounds it to one chunk and already backs
    // the bench path.
    const { controller, worker, player, clock } = makeController();

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200,
    );
    await controller.broadcastFile('a.txt', new Uint8Array(40));
    await clock.tick(ROOM_TIMING.listenMs + 100);
    worker.emit('controlMessage', {
      msg: { type: ControlType.Report, senderId: 5, targetId: getState().chatterDeviceId, payload: packReport(flatGrid).buffer },
    });
    await clock.tick(
      ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + ROOM_TIMING.fileComingLeadMs + 200,
    );

    expect(worker.calls).toContain('startFileStream');
    expect(worker.calls).not.toContain('encodeFile');
    expect(player.calls).toContain('playStream');
  });
```

Extend the file's fake worker and fake player with the two new members, following the shape of the existing stubs:

```typescript
    startFileStream: async (fileName: string, data: Uint8Array) => {
      calls.push('startFileStream');
      let served = false;
      return {
        sampleRate: SR,
        totalSamples: 8,
        pull: async () => (served ? null : ((served = true), new Float32Array(8))),
        cancel: () => {},
      };
    },
```

```typescript
    playStream: async (pull: () => Promise<Float32Array | null>) => {
      playerCalls.push('playStream');
      // Drain like the real player does, so a generator bug surfaces here.
      for (;;) {
        const chunk = await pull();
        if (chunk === null) break;
      }
    },
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modem/test/chatterController.test.ts -t "streaming path"`

Expected: FAIL — `worker.calls` contains `encodeFile` and not `startFileStream`.

- [ ] **Step 3: Widen the two injected interfaces**

In `src/ui/controllers/chatterController.ts`:

```typescript
export interface AudioPlayerLike {
  play(samples: Float32Array, sampleRate: number, deviceId?: string, clean?: boolean): Promise<void>;
  /** Chunked playback — see AudioPlayer.playStream. Used for the file path so
   *  peak memory is one chunk rather than the whole waveform. */
  playStream(
    pull: () => Promise<Float32Array | null>,
    sampleRate: number,
    deviceId?: string,
    onProgress?: (scheduledSec: number) => void,
  ): Promise<void>;
}
```

and in `ModemWorkerHandle`, beside `encodeFile`:

```typescript
  /** Streaming encode — see ModemController.startFileStream. */
  startFileStream(fileName: string, data: Uint8Array): Promise<{
    sampleRate: number;
    totalSamples: number;
    pull: () => Promise<Float32Array | null>;
    cancel: () => void;
  }>;
```

Leave `encodeFile` on the interface: the control and probe paths do not use it, but removing it is a separate change and `ModemController` still provides it.

- [ ] **Step 4: Add a streaming variant of playAndMute**

`playAndMute` records the tx packet, stamps `chatterLastTx`, tracks `lastPlayback`, mutes RX for the duration plus the echo tail, and routes to the selected speaker. All of that applies to a streamed send; only the playback call differs. Add beside it:

```typescript
  /** Streaming counterpart of `playAndMute` — same packet recording, same
   *  mute discipline and echo tail, same selected-speaker routing; the audio
   *  arrives in chunks instead of one buffer. Kept as a sibling rather than a
   *  flag on playAndMute because the two take different callbacks and share no
   *  body beyond the bookkeeping. */
  private playStreamAndMute(
    start: () => Promise<{ sampleRate: number; pull: () => Promise<Float32Array | null>; cancel: () => void }>,
    packet: Omit<ChatterPacket, 'seq' | 'tMs' | 'dir'>,
  ): Promise<void> {
    this.recordPacket({ dir: 'tx', ...packet });
    setState({ chatterLastTx: this.deps.now() });
    const attempt = this.doPlayStreamAndMute(start);
    this.lastPlayback = attempt.catch(() => {});
    return attempt;
  }

  private async doPlayStreamAndMute(
    start: () => Promise<{ sampleRate: number; pull: () => Promise<Float32Array | null>; cancel: () => void }>,
  ): Promise<void> {
    const { sampleRate, pull, cancel } = await start();
    this.worker.setRxMuted(true);
    try {
      // Read the output device at play time, so a device change mid-session
      // takes effect on the next burst (same reason as doPlayAndMute).
      await this.player.playStream(pull, sampleRate, getState().selectedOutputId);
    } catch (err) {
      // Cancel the worker-side generator, or a failed playback leaves it
      // holding the whole encode until the next stream replaces it.
      cancel();
      throw err;
    } finally {
      await this.timeout(MUTE_TAIL_MS);
      this.worker.setRxMuted(false);
    }
  }
```

- [ ] **Step 5: Route transmitFile through it**

In `transmitFile`, replace the `playAndMute` call inside Task 7's `try` block:

```typescript
    try {
      await this.playStreamAndMute(
        () => this.worker.startFileStream(pending.fileName, pending.data),
        {
          kind: 'file',
          peerId: 0,
          bytes: pending.data.byteLength,
          note: pending.fileName,
        },
      );
    } catch (err) {
```

The `bytes` field keeps its existing meaning (the raw file size, not the wire size) and its existing comment above the call still applies — leave it in place.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/chatterController.test.ts`

Expected: PASS, including Task 7's "surfaces a failed file encode as chatterError" — that test stubs `encodeFile`, which is no longer called, so retarget it to throw from `startFileStream` instead:

```typescript
    worker.startFileStream = async () => { throw new Error('Out of memory'); };
```

- [ ] **Step 7: Run the full suite and lint**

Run: `npm run test && npm run lint`

Expected: PASS except the 3 known BPSK failures. `chatterLoopback.test.ts` drives a real negotiated transfer — if its fake worker only implements `encodeFile`, add a `startFileStream` that yields the same samples in chunks, or the loopback fails at the transmit step.

- [ ] **Step 8: Commit**

```bash
git add src/ui/controllers/chatterController.ts src/modem/test/
git commit -m "perf(chatter): send files through the streaming encode path

The batch encoder builds the whole waveform in the worker, transfers it
whole, and hands it to play() — the largest single allocation in a send.
startFileStream and playStream already exist and already back the bench
path; they bound peak memory to one ~0.5 s chunk. Same mute discipline,
echo tail, packet log, and speaker routing as the batch path."
```

- [ ] **Step 9: Verify on real audio**

Run `npm run dev`, join a room on two devices, and send a small file. Confirm the receiver assembles it. This path is new for chatter, and the streaming player deliberately clamps rather than rescales per chunk (`player.ts:153-192`) — a level step between chunks would break every channel estimate, so listen for the transfer completing rather than only for the absence of an error.

---

## Plan self-review

**Spec coverage.** Spec A1 → Task 3. A2 → Tasks 1, 2. A3 → Task 4. B → Tasks 5, 6. C1 → Task 7. C2 → deliberately absent, blocked on a log; Tasks 6 and 7 each end with a stop that hands back for the measurement C2 needs. C3 → Tasks 8, 9. The spec's third C3 bullet (a shared `AudioContext`) has **no task**: `app.ts:141-153` already constructs one `AudioContext`, wraps it in one `AudioPlayer`, and injects that player into `ChatterController`, so the second context the spec worried about only exists if the `player` option is omitted — which production never does. The spec's Non-goals (text/DM, mobile UI, per-tone QAM, target-band waveform) have no tasks by design.

**Type consistency.** `ProbePurpose`/`PROBE_PURPOSE` are defined in Task 1 and consumed with the same names in Tasks 2, 3, 4. `PendingReply`'s four fields are defined in Task 3 and `attempts`/`scheduled` are read in Task 4. `OFDM_HANDSHAKE.chirpCenterHz` is added in Task 5 and its value re-stated in Task 6's replacement block with a note to keep Task 5's comment. `errorName`/`command` are added in Task 7 and not re-declared later. `playStream` is declared on `AudioPlayerLike` in Task 9 and matches `AudioPlayer.playStream`'s real signature at `player.ts:118-123`.

**Ordering hazard flagged in-plan.** Task 4's retry changes the observable WELCOME count in one pre-existing test and possibly in `chatterLoopback.test.ts`; both are called out with the intended resolution rather than left to be discovered. Task 9 breaks Task 7's test by removing the `encodeFile` call path; the retarget is spelled out in Task 9 Step 6.

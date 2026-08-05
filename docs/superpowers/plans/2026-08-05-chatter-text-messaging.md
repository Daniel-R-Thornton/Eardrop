# Chatter Text Messaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send short text messages — to the whole room or to one device — over the chatter control plane, with read receipts and one retry.

**Architecture:** Two new control types (`Text`, `Ack`) on the existing fixed handshake band, with `CONTROL_PAYLOAD_MAX` raised 48 → 255 so a message fits one self-describing frame. The receiver's sync watchdog becomes length-aware so a 10 s message is not killed mid-flight. The slotted-send machinery already inside `roomProtocol.ts` is extracted to a reusable `Outbox`, so TEXT and ACK inherit collision avoidance, carrier sense, and the drain-only-when-free rule that keeps them out of a roll-call window.

**Tech Stack:** TypeScript, Vitest, Vite. No new dependencies.

Spec: `docs/superpowers/specs/2026-08-05-chatter-text-messaging-design.md`

## Global Constraints

- Run `npm run typecheck`, `npm run test`, and `npm run lint` before every commit. `npm run test` has 3 known-failing BPSK Doppler/stress cases in `src/modem/test/pipeline.test.ts` — those may stay red; **nothing else may go red.** `npm run lint` baseline is 410 problems (16 errors, 394 warnings); introduce no new errors. `npm run typecheck` must be zero errors — it is the only gate that typechecks, since Vitest transpiles via esbuild and ESLint is not type-aware.
- `src/modem/protocol/rxEngine.ts` and `src/modem/pilot.ts` are marked FRAGILE in the README. Only Task 2 touches `rxEngine.ts`, and its change is bounded to one field, one comparison, one assignment, and comments.
- TX and RX must derive every wire value from ONE source. A value hardcoded on one side while the other derives it fails silently — nothing decodes and no error is raised.
- The text cap is **254 bytes of UTF-8**, not 254 characters. An emoji is 4 bytes.
- Conventional Commits. Comments explain *why* and match the surrounding file's density — this codebase records bench measurements and past hardware failures in prose. Do not strip existing comments; update any your change makes false. **Stale prose was a review finding on nearly every task of the predecessor plan, including one that reached a commit message.**
- Never weaken an assertion to make a test pass. If a test cannot pass without weakening it, stop and report.

## File Structure

Create:
- `src/modem/chatter/outbox.ts` — the slotted, carrier-sensed send queue extracted from `roomProtocol.ts`. Owns *when* an owed transmission goes out; owns no policy about *what* is owed.
- `src/modem/test/outbox.test.ts` — outbox unit tests with a manual clock.

Modify:
- `src/modem/protocol/controlFrame.ts` — `CONTROL_PAYLOAD_MAX` 48 → 255; `ControlType.Text`/`Ack`; `packText`/`parseText`/`packAck`/`parseAck` (Task 1)
- `src/modem/protocol/rxEngine.ts` — length-aware watchdog grace (Task 2)
- `src/modem/chatter/roomProtocol.ts` — consume `Outbox`; TEXT/ACK policy, dedup, retry (Tasks 3, 4, 5)
- `src/ui/Store.ts` — `chatterMessages` ring (Task 5)
- `src/ui/controllers/chatterController.ts` — `sendText` entry point, message store wiring (Task 6)
- Tests: `controlFrame.test.ts`, `roomProtocol.test.ts`, `chatterLoopback.test.ts`, `chatterController.test.ts`

---

### Task 1: TEXT and ACK wire format

**Files:**
- Modify: `src/modem/protocol/controlFrame.ts` — `ControlType` enum (~:42), `CONTROL_PAYLOAD_MAX` (~:63), and the payload-codec section at the end of the file
- Test: `src/modem/test/controlFrame.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `ControlType.Text = 5`, `ControlType.Ack = 6`
  - `CONTROL_PAYLOAD_MAX = 255`
  - `TEXT_MAX_BYTES = 254`
  - `packText(msgId: number, text: string): Uint8Array`
  - `parseText(b: Uint8Array): { msgId: number; text: string } | null`
  - `packAck(msgId: number): Uint8Array`
  - `parseAck(b: Uint8Array): { msgId: number } | null`
  - `textByteLength(text: string): number` — UTF-8 byte count, for the composer's live counter

- [ ] **Step 1: Write the failing tests**

Append to `src/modem/test/controlFrame.test.ts`. Read the file's existing imports first and extend them rather than adding a second import block.

```typescript
describe('TEXT / ACK control payloads', () => {
  it('round-trips a short message', () => {
    const p = packText(7, 'ready?');
    expect(parseText(p)).toEqual({ msgId: 7, text: 'ready?' });
  });

  it('round-trips an empty message', () => {
    // Not useful to send, but the codec must not mis-handle a zero-length
    // payload — payloadLen 1 is a legal frame.
    expect(parseText(packText(0, ''))).toEqual({ msgId: 0, text: '' });
  });

  it('round-trips multi-byte UTF-8 at exactly the cap', () => {
    // The cap is BYTES, not characters. An emoji is 4 bytes, so 63 of them
    // plus a 2-byte character is 254 — the largest legal text.
    const text = '🦻'.repeat(63) + 'é';
    expect(textByteLength(text)).toBe(TEXT_MAX_BYTES);
    const parsed = parseText(packText(255, text));
    expect(parsed).toEqual({ msgId: 255, text });
  });

  it('rejects text one byte over the cap rather than splitting a codepoint', () => {
    // Truncating mid-codepoint would put invalid UTF-8 on the air, and
    // encodeControlMessage would throw on the oversized payload anyway.
    const text = 'a'.repeat(TEXT_MAX_BYTES + 1);
    expect(() => packText(1, text)).toThrow(/254|cap|too long/i);
  });

  it('round-trips an ACK', () => {
    expect(parseAck(packAck(200))).toEqual({ msgId: 200 });
  });

  it('parseText and parseAck reject a payload that is too short', () => {
    expect(parseText(new Uint8Array(0))).toBeNull();
    expect(parseAck(new Uint8Array(0))).toBeNull();
  });

  it('a 255-byte payload survives the full control-frame wire round trip', () => {
    // The old CONTROL_PAYLOAD_MAX was 48. This proves nothing downstream
    // baked that in: header payloadLen is a full byte, so 255 is legal and
    // the BCH chunking and CRC-16 must both scale to it.
    const text = 'x'.repeat(TEXT_MAX_BYTES);
    const msg = { type: ControlType.Text, senderId: 3, targetId: 0, payload: packText(9, text) };
    expect(msg.payload.length).toBe(255);

    const wire = encodeControlMessage(msg);
    const header = decodeControlHeader(wire.slice(SENTINEL_SIZE, SENTINEL_SIZE + BCH_HEADER_SIZE));
    expect(header).not.toBeNull();
    expect(header!.type).toBe(ControlType.Text);
    expect(header!.payloadLen).toBe(255);

    const payloadWire = wire.slice(SENTINEL_SIZE + BCH_HEADER_SIZE);
    expect(payloadWire.length).toBe(controlPayloadWireSize(255));
    const payload = decodeControlPayload(payloadWire, header!.payloadLen);
    expect(payload).not.toBeNull();
    expect(parseText(payload!)).toEqual({ msgId: 9, text });
  });

  it('rejects a payload above the new cap', () => {
    const msg = { type: ControlType.Text, senderId: 3, targetId: 0, payload: new Uint8Array(256) };
    expect(() => encodeControlMessage(msg)).toThrow(/256 B exceeds 255 B cap/);
  });
});
```

The last two tests need `SENTINEL_SIZE` and `BCH_HEADER_SIZE`, which `controlFrame.ts` imports from `./atomicFrame`. Import them in the test from `../protocol/atomicFrame`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modem/test/controlFrame.test.ts`

Expected: FAIL — `packText` and friends are not exported, so the file errors on import before any test runs.

- [ ] **Step 3: Raise the cap and add the types**

In `src/modem/protocol/controlFrame.ts`, extend the enum:

```typescript
export enum ControlType {
  Welcome = 1,
  Report = 2,
  FileComing = 3,
  Bye = 4,
  Text = 5,
  Ack = 6,
}
```

Replace the `CONTROL_PAYLOAD_MAX` declaration and its comment:

```typescript
/**
 * Largest raw payload a control message may carry.
 *
 * 255, not the 48 this shipped with. 48 was never structural — it was picked
 * so the largest payload then in use (WELCOME's 35 bytes) "still fits a
 * handful of codewords". The header carries `payloadLen` as a full byte, so
 * the frame is already variable-length and self-describing: the receiver
 * reads exactly as many bytes as the header declares, and 255 is that field's
 * true ceiling.
 *
 * Nothing downstream assumed the smaller value — SentinelScanner's collect
 * size is retargeted per message via `continueCollecting`, and both that
 * sizing and `decodeControlPayload` read `header.payloadLen`.
 *
 * COST OF A LONG PAYLOAD: BCH decodes per three-byte chunk and
 * `bchDecodeChunks` returns null if ANY chunk is uncorrectable, so a control
 * message is all-or-nothing. A 255-byte payload is 86 chunks — one bad chunk
 * loses the whole message. A message this long is also ~10.4 s of air, four
 * times anything the control plane previously carried, which is why the
 * receiver's sync watchdog had to become length-aware (see rxEngine's
 * OFDM_WATCHDOG_WINDOWS).
 */
export const CONTROL_PAYLOAD_MAX = 255;

/** Largest text a TEXT payload can carry: the payload cap less the 1-byte
 *  msgId. Counted in UTF-8 BYTES, not characters — an emoji is 4. */
export const TEXT_MAX_BYTES = CONTROL_PAYLOAD_MAX - 1;
```

- [ ] **Step 4: Add the TEXT and ACK codecs**

Append to the payload-codec section at the end of `controlFrame.ts`:

```typescript
/** UTF-8 byte length of `text` — what the TEXT cap is measured in, and what a
 *  composer's live counter must display. `text.length` is UTF-16 code units
 *  and would under-count every emoji. */
export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * TEXT payload: [msgId:1][utf8 text: 0..TEXT_MAX_BYTES].
 *
 * `msgId` is monotonic per sender and wraps at 256; the receiver dedupes on
 * (senderId, msgId). Throws rather than truncating an over-long message:
 * cutting UTF-8 at a byte boundary can split a codepoint and put invalid
 * bytes on the air, and `encodeControlMessage` would reject the oversized
 * payload anyway. Callers must check `textByteLength` first.
 */
export function packText(msgId: number, text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > TEXT_MAX_BYTES) {
    throw new Error(`control frame: text ${bytes.length} B exceeds ${TEXT_MAX_BYTES} B cap`);
  }
  const out = new Uint8Array(1 + bytes.length);
  out[0] = msgId & 0xff;
  out.set(bytes, 1);
  return out;
}

export function parseText(b: Uint8Array): { msgId: number; text: string } | null {
  if (b.length < 1) return null;
  return { msgId: b[0], text: new TextDecoder().decode(b.subarray(1)) };
}

/**
 * ACK payload: [msgId:1].
 *
 * Nothing else is needed to identify the acked message: an ACK's `targetId`
 * is the original sender and its `senderId` is the acknowledging device, so
 * (targetId, msgId) is unique — msgId is only ever unique per sender.
 */
export function packAck(msgId: number): Uint8Array {
  return new Uint8Array([msgId & 0xff]);
}

export function parseAck(b: Uint8Array): { msgId: number } | null {
  if (b.length < 1) return null;
  return { msgId: b[0] };
}
```

Also update the file's header comment: it states the payload range as "0-48 raw bytes, capped so the largest payload, WELCOME's 35 bytes, still fits a handful of codewords". Correct it to 0-255 and note what actually bounds it (the `payloadLen` byte).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/controlFrame.test.ts`

Expected: PASS, including every pre-existing test in that file.

- [ ] **Step 6: Run the gates**

Run: `npm run typecheck && npm run test && npm run lint`

Expected: typecheck clean; tests green except the 3 known BPSK failures; lint at baseline.

- [ ] **Step 7: Commit**

```bash
git add src/modem/protocol/controlFrame.ts src/modem/test/controlFrame.test.ts
git commit -m "feat(chatter): TEXT and ACK control payloads, payload cap 48 -> 255

48 was never structural — it was picked to fit WELCOME's 35 bytes. The
header carries payloadLen as a full byte, so the frame is already
variable-length and self-describing, and 255 is that field's ceiling.

TEXT carries [msgId:1][utf8 <=254]; ACK carries [msgId:1] and needs nothing
more, since its targetId is the original sender. The cap is bytes, not
characters, and packText throws rather than splitting a codepoint."
```

---

### Task 2: Length-aware sync watchdog

Without this, every long message dies on hardware and the real cap is ~147 bytes while the code claims 254.

`rxEngine.ts`'s `OFDM_WATCHDOG_WINDOWS` getter returns 5 s worth of windows in chatter mode, documented as "comfortably longer than any real message (preamble + at most a 48-byte payload)". It fires on "no CRC-valid frame within N windows", resets the receiver to `WAITING` and clears its buffer. It exists because a false sync otherwise leaves the listener deaf — hardware once showed a listener burning 601 windows and missing the FILE_COMING that followed.

A 255-byte payload is ~8.6 s of symbols after its header, so the watchdog would reset mid-message.

**The fix is a one-shot grace, not a bigger constant.** When `processCard` decodes a valid control header it already computes `controlPayloadWireSize(header.payloadLen)` for the scanner. The same number yields the payload's duration in symbols. A false sync never decodes a valid header, so it never earns the grace and still costs only 5 s of deafness — which is why this is strictly better than raising the constant for everyone.

**Files:**
- Modify: `src/modem/protocol/rxEngine.ts` — the `ofdmWindowsSinceDetect` watchdog comparison (~:1159), the `OFDM_WATCHDOG_WINDOWS` doc (~:240-256), and `processCard`'s control-header branch (~:585)
- Test: `src/modem/test/controlFrameLongRx.test.ts` (create)

**Interfaces:**
- Consumes: `CONTROL_PAYLOAD_MAX = 255`, `packText`, `TEXT_MAX_BYTES` from Task 1.
- Produces: no exported API change. `RxEngine` gains a private `ofdmWatchdogGraceWindows: number`, set on a valid control header and cleared when the watchdog fires or the payload run completes.

- [ ] **Step 1: Write the failing test**

Create `src/modem/test/controlFrameLongRx.test.ts`. Model the TX side on how `chatterWorker.test.ts` builds control audio — read that file for the `TxEngine` config it uses and mirror it, so this test drives the same path the worker does.

```typescript
import { describe, expect, it } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import {
  encodeControlMessage, ControlType, packText, parseText, TEXT_MAX_BYTES,
  type ControlMessage,
} from '../protocol/controlFrame';
import { OFDM_DEFAULTS } from '../types';

const SR = 48000;

function buildControlAudio(msg: ControlMessage): Float32Array {
  const tx = new TxEngine({
    useOFDM: true,
    bandHandshake: true,
    sampleRate: SR,
    pilotFreqHz: OFDM_DEFAULTS.pilotFreqHz,
    toneStartHz: OFDM_DEFAULTS.toneStartHz,
    toneCount: OFDM_DEFAULTS.toneCount,
  } as ConstructorParameters<typeof TxEngine>[0]);
  return tx.buildHandshakeSegment(encodeControlMessage(msg));
}

function decodeControl(audio: Float32Array): ControlMessage | null {
  let got: ControlMessage | null = null;
  const rx = new RxEngine({
    useOFDM: true,
    bandHandshake: true,
    sampleRate: SR,
  } as ConstructorParameters<typeof RxEngine>[0]);
  rx.onControlMessage = (m) => { got = m; };
  rx.feedChunk(audio);
  // Trailing silence so the last symbols are consumed.
  rx.feedChunk(new Float32Array(SR));
  return got;
}

describe('long control messages survive the sync watchdog', () => {
  it('decodes a maximum-length TEXT message', () => {
    // ~10.4 s of audio — four times longer than any control message the
    // plane previously carried, and well past the 5 s watchdog. Without the
    // length-aware grace the receiver resets to WAITING mid-message and this
    // returns null.
    const text = 'x'.repeat(TEXT_MAX_BYTES);
    const audio = buildControlAudio({
      type: ControlType.Text, senderId: 4, targetId: 0, payload: packText(11, text),
    });
    expect(audio.length / SR).toBeGreaterThan(6); // sanity: this really is long

    const got = decodeControl(audio);
    expect(got).not.toBeNull();
    expect(got!.type).toBe(ControlType.Text);
    expect(parseText(got!.payload)).toEqual({ msgId: 11, text });
  });

  it('still decodes a short control message', () => {
    // The grace must not break the ordinary case.
    const audio = buildControlAudio({
      type: ControlType.Text, senderId: 4, targetId: 9, payload: packText(1, 'hi'),
    });
    const got = decodeControl(audio);
    expect(parseText(got!.payload)).toEqual({ msgId: 1, text: 'hi' });
  });

  it('a sync with no valid control header earns no grace', () => {
    // A false sync must still reset on the plain 5 s watchdog, which is the
    // whole reason the watchdog exists. Feed noise long enough that any
    // extended deadline would be visible, then a real short message: if the
    // engine were stuck holding a grace it never earned, this would fail.
    const rx = new RxEngine({
      useOFDM: true, bandHandshake: true, sampleRate: SR,
    } as ConstructorParameters<typeof RxEngine>[0]);
    let got: ControlMessage | null = null;
    rx.onControlMessage = (m) => { got = m; };

    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const noise = new Float32Array(SR * 12);
    for (let i = 0; i < noise.length; i++) noise[i] = (rnd() - 0.5) * 0.2;
    rx.feedChunk(noise);

    rx.feedChunk(buildControlAudio({
      type: ControlType.Text, senderId: 4, targetId: 0, payload: packText(2, 'after noise'),
    }));
    rx.feedChunk(new Float32Array(SR));
    expect(parseText(got!.payload)).toEqual({ msgId: 2, text: 'after noise' });
  });
});
```

- [ ] **Step 2: Run the test to verify the first case fails**

Run: `npx vitest run src/modem/test/controlFrameLongRx.test.ts`

Expected: "decodes a maximum-length TEXT message" FAILS with `got` null — the watchdog resets the receiver partway through. The short-message case should already pass. If the long case unexpectedly passes, stop and report: it would mean the watchdog is not being reached, and the rest of this task would be unnecessary.

- [ ] **Step 3: Add the grace field**

In `src/modem/protocol/rxEngine.ts`, beside `ofdmWindowsSinceDetect`:

```typescript
  /**
   * One-shot extension to the sync watchdog, in windows, earned by decoding a
   * valid control header.
   *
   * A control message can now be ~10.4 s of audio (see
   * CONTROL_PAYLOAD_MAX) while the chatter watchdog is 5 s, so without this a
   * long message resets the receiver mid-payload and is lost. The header
   * declares `payloadLen`, so the exact number of symbols still to come is
   * known — this holds that count, and nothing more.
   *
   * Deliberately earned rather than granted: raising OFDM_WATCHDOG_WINDOWS
   * would weaken the false-sync case the watchdog exists for, for every
   * message. A false sync never decodes a valid header, so it never gets here.
   */
  private ofdmWatchdogGraceWindows = 0;
```

- [ ] **Step 4: Set the grace when a control header decodes**

In `processCard`'s control-header branch, alongside the existing `continueCollecting` call:

```typescript
    const header = decodeControlHeader(body);
    if (header) {
      this.pendingControlHeader = header;
      const payloadWire = controlPayloadWireSize(header.payloadLen);
      // Extend the sync watchdog by exactly this payload's duration — see
      // ofdmWatchdogGraceWindows. bytesPerSymbol mirrors the card-sizing
      // idiom used elsewhere in this file.
      const bytesPerSymbol = Math.max(1, Math.floor(OFDM_HANDSHAKE.toneCount / 4));
      this.ofdmWatchdogGraceWindows = Math.ceil(payloadWire / bytesPerSymbol);
      this.scanner.continueCollecting(payloadWire);
      return;
    }
```

`OFDM_HANDSHAKE` and `controlPayloadWireSize` are already imported in this file.

- [ ] **Step 5: Honour and clear the grace in the watchdog**

At the watchdog comparison, replace the bare threshold:

```typescript
      this.ofdmWindowsSinceDetect++;
      if (this.ofdmWindowsSinceDetect > this.OFDM_WATCHDOG_WINDOWS + this.ofdmWatchdogGraceWindows) {
        dlog('OFDM-SYNC', {
          watchdogReset: true,
          windows: this.ofdmWindowsSinceDetect,
          grace: this.ofdmWatchdogGraceWindows,
        }, { level: 'warn' });
        this.ofdmWatchdogGraceWindows = 0;
```

Keep every other line of that reset block unchanged.

Then clear the grace where a control message completes. Find the `onExtraFrame` handler that consumes `pendingControlHeader` and calls `decodeControlPayload` (~:493) and clear it there, in the same place `pendingControlHeader` is released, so a completed message does not leave an extension armed for the next one.

- [ ] **Step 6: Update the stale watchdog doc**

`OFDM_WATCHDOG_WINDOWS`'s comment says a whole control message "is about 3.5 s (preamble + at most a 48-byte payload)". That is now false. Rewrite that clause: a control message ranges from ~2 s to ~10.4 s depending on payload, the 5 s figure still bounds a *false* sync, and long messages are covered by `ofdmWatchdogGraceWindows` rather than by this constant. Keep the hardware history (the 601-window listener) intact.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/controlFrameLongRx.test.ts`

Expected: PASS, all three.

- [ ] **Step 8: Run the gates**

Run: `npm run typecheck && npm run test && npm run lint`

Expected: typecheck clean; the 3 known BPSK failures only. `bandHandshake.test.ts`, `chatterWorker.test.ts` and `chatterLoopback.test.ts` must all stay green — they exercise the same receive path.

- [ ] **Step 9: Commit**

```bash
git add src/modem/protocol/rxEngine.ts src/modem/test/controlFrameLongRx.test.ts
git commit -m "fix(modem): extend the sync watchdog by what the control header declares

The chatter sync watchdog is 5 s, documented as longer than any real
message when the longest was 3.15 s. A 255-byte payload is ~8.6 s of
symbols, so the watchdog reset the receiver mid-message and every long
message vanished.

The header declares payloadLen, so the exact remaining duration is known:
the receiver now extends its own deadline by that and nothing more.
Deliberately earned rather than granted — raising the constant would
weaken the false-sync case the watchdog exists for, and a false sync never
decodes a valid header."
```

---

### Task 3: Extract the Outbox (behaviour-preserving)

`roomProtocol.ts` is 792 lines and already contains the machinery ACKs need: a queue of owed transmissions, a randomly chosen reply slot, carrier sense before each attempt, re-roll among later slots when busy, hold-don't-drop when the transmitter becomes unavailable, identity-guarded deletes, and a bounded ack-arming retry.

This task moves that out **with no behaviour change**. Every existing `roomProtocol.test.ts` assertion must pass unchanged; a test that needs rewriting is a signal the extraction changed behaviour.

One structural change is unavoidable: the current queue is `Map<number, PendingReply>` keyed by `proberId`, which gives "one reply chain per peer" dedup for free. TEXT is a broadcast and is not keyed by a peer, so the outbox keys on a monotonic entry id and takes an explicit `dedupKey`. Reply enqueues pass `` `reply:${proberId}` `` as that key, preserving today's dedup exactly.

**Files:**
- Create: `src/modem/chatter/outbox.ts`
- Create: `src/modem/test/outbox.test.ts`
- Modify: `src/modem/chatter/roomProtocol.ts` — replace `replyQueue`, `awaitingAck`, `canTransmitReply`, `drainReplyQueue`, `scheduleReply`, `armReplyAck` with an `Outbox` instance plus the reply-specific policy

**Interfaces:**
- Consumes: `ControlMessage`, `ControlType` from `controlFrame.ts`.
- Produces:

```typescript
export type OutboxKind = 'welcome' | 'report' | 'text' | 'ack';

export interface OutboxEntry {
  /** Monotonic, unique per Outbox — the queue key. */
  readonly id: number;
  readonly kind: OutboxKind;
  /** 0 = broadcast. */
  readonly targetId: number;
  /** At most one UNSENT entry per dedupKey. */
  readonly dedupKey: string;
  /** Built at send time so late-changing state (a measured grid) is fresh. */
  readonly build: () => ControlMessage;
  /** Sends attempted, including the first. */
  attempts: number;
  /** A slot chain is already in flight for this entry. */
  scheduled: boolean;
}

export interface OutboxDeps {
  now(): number;
  rng(): number;
  schedule(fn: () => void, delayMs: number): () => void;
  isAirBusy(): Promise<boolean>;
  sendMessage(msg: ControlMessage): Promise<void>;
  /** True when this device's transmitter is free. */
  canTransmit(): boolean;
  /** Slot count and slot length — passed in so ROOM_TIMING stays the single source. */
  replySlots: number;
  replySlotMs: number;
  /** After a successful send. The owner arms any retry/ack tracking here. */
  onSent?(entry: OutboxEntry): void;
  /** Slots exhausted, or the send threw. */
  onFailed?(entry: OutboxEntry, err?: unknown): void;
}

export class Outbox {
  constructor(deps: OutboxDeps);
  /** Returns the new entry's id, or the existing id if dedupKey is queued. */
  enqueue(spec: {
    kind: OutboxKind; targetId: number; dedupKey: string;
    build: () => ControlMessage; attempts?: number;
  }): number;
  has(dedupKey: string): boolean;
  /** Start a slot chain for every entry without one. Call on entry to an
   *  eligible state. */
  drain(): void;
  clear(): void;
  get size(): number;
}
```

- [ ] **Step 1: Write the failing outbox tests**

Create `src/modem/test/outbox.test.ts`. Copy the manual-clock harness idiom from `roomProtocol.test.ts` (a timer list, a `tick` that fires due timers in order and drains 8 microtasks between each).

```typescript
import { describe, expect, it } from 'vitest';
import { Outbox, type OutboxEntry } from '../chatter/outbox';
import { ControlType, type ControlMessage } from '../protocol/controlFrame';

function makeHarness(opts: { busy?: () => boolean; canTransmit?: () => boolean } = {}) {
  let t = 0;
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  const sent: ControlMessage[] = [];
  const events: string[] = [];
  const outbox = new Outbox({
    now: () => t,
    rng: () => 0,
    schedule: (fn, d) => {
      const rec = { at: t + d, fn, dead: false };
      timers.push(rec);
      return () => { rec.dead = true; };
    },
    isAirBusy: async () => opts.busy?.() ?? false,
    sendMessage: async (m) => { sent.push(m); },
    canTransmit: () => opts.canTransmit?.() ?? true,
    replySlots: 6,
    replySlotMs: 300,
    onSent: (e: OutboxEntry) => events.push(`sent:${e.kind}:${e.id}`),
    onFailed: (e: OutboxEntry) => events.push(`failed:${e.kind}:${e.id}`),
  });
  const tick = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.dead && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    t = end;
  };
  return { outbox, tick, sent, events };
}

const textMsg = (targetId: number): ControlMessage => ({
  type: ControlType.Text, senderId: 1, targetId, payload: new Uint8Array([0]),
});

describe('outbox', () => {
  it('sends a queued entry on drain', async () => {
    const h = makeHarness();
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(1);
    expect(h.events).toContain('sent:text:1');
    expect(h.outbox.size).toBe(0);
  });

  it('dedupes by dedupKey while an entry is unsent', async () => {
    const h = makeHarness();
    const a = h.outbox.enqueue({ kind: 'ack', targetId: 5, dedupKey: 'ack:5:9', build: () => textMsg(5) });
    const b = h.outbox.enqueue({ kind: 'ack', targetId: 5, dedupKey: 'ack:5:9', build: () => textMsg(5) });
    expect(b).toBe(a);
    expect(h.outbox.size).toBe(1);
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(1);
  });

  it('does not send while the transmitter is unavailable, and sends once it frees', async () => {
    let free = false;
    const h = makeHarness({ canTransmit: () => free });
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    await h.tick(2000);
    expect(h.sent).toHaveLength(0);
    expect(h.outbox.size).toBe(1); // held, not dropped

    free = true;
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(1);
  });

  it('holds an entry whose slot fires after the transmitter became unavailable', async () => {
    // The hold-don't-drop path INSIDE the timer callback — dropping here was
    // the original reply bug in a new costume.
    let free = true;
    const h = makeHarness({ canTransmit: () => free });
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    free = false;
    await h.tick(2000);
    expect(h.sent).toHaveLength(0);
    expect(h.outbox.size).toBe(1);

    free = true;
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(1);
  });

  it('re-rolls among later slots while the air is busy', async () => {
    let busy = true;
    const h = makeHarness({ busy: () => busy });
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    await h.tick(400);
    expect(h.sent).toHaveLength(0);
    busy = false;
    await h.tick(6 * 300);
    expect(h.sent).toHaveLength(1);
  });

  it('gives up and reports failure when every slot was busy', async () => {
    const h = makeHarness({ busy: () => true });
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    await h.tick(6 * 300 + 500);
    expect(h.sent).toHaveLength(0);
    expect(h.events).toContain('failed:text:1');
    expect(h.outbox.size).toBe(0);
  });

  it('reports failure when sendMessage throws', async () => {
    let t = 0;
    const timers: { at: number; fn: () => void; dead: boolean }[] = [];
    const events: string[] = [];
    const outbox = new Outbox({
      now: () => t,
      rng: () => 0,
      schedule: (fn, d) => {
        const rec = { at: t + d, fn, dead: false };
        timers.push(rec);
        return () => { rec.dead = true; };
      },
      isAirBusy: async () => false,
      sendMessage: async () => { throw new Error('audio glitch'); },
      canTransmit: () => true,
      replySlots: 6,
      replySlotMs: 300,
      onFailed: (e, err) => events.push(`failed:${e.kind}:${(err as Error).message}`),
    });
    outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    outbox.drain();
    for (;;) {
      const due = timers.filter((x) => !x.dead).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      t = due.at; due.dead = true; due.fn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    expect(events).toContain('failed:text:audio glitch');
    expect(outbox.size).toBe(0);
  });

  it('clear() empties the queue and nothing fires afterwards', async () => {
    const h = makeHarness();
    h.outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    h.outbox.drain();
    h.outbox.clear();
    expect(h.outbox.size).toBe(0);
    await h.tick(5000);
    expect(h.sent).toHaveLength(0);
  });

  it('a stale send does not delete a newer entry with the same dedupKey', async () => {
    // The identity-guard the predecessor branch had to add: a send is seconds
    // of audio, and clear()+re-enqueue during it must not be discarded by the
    // old closure completing.
    let release: (() => void) | undefined;
    let t = 0;
    const timers: { at: number; fn: () => void; dead: boolean }[] = [];
    const outbox = new Outbox({
      now: () => t,
      rng: () => 0,
      schedule: (fn, d) => {
        const rec = { at: t + d, fn, dead: false };
        timers.push(rec);
        return () => { rec.dead = true; };
      },
      isAirBusy: async () => false,
      sendMessage: () => new Promise<void>((res) => { release = res; }),
      canTransmit: () => true,
      replySlots: 6,
      replySlotMs: 300,
    });
    outbox.enqueue({ kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0) });
    outbox.drain();
    const fire = async () => {
      const due = timers.filter((x) => !x.dead).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      t = due.at; due.dead = true; due.fn();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    };
    await fire(); // now suspended inside sendMessage

    outbox.clear();
    const freshId = outbox.enqueue({
      kind: 'text', targetId: 0, dedupKey: 'text:1', build: () => textMsg(0),
    });
    release!();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(outbox.size).toBe(1);
    expect(outbox.has('text:1')).toBe(true);
    expect(freshId).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modem/test/outbox.test.ts`

Expected: FAIL — `src/modem/chatter/outbox.ts` does not exist.

- [ ] **Step 3: Write the Outbox**

Create `src/modem/chatter/outbox.ts`. Port the logic from `roomProtocol.ts`'s `drainReplyQueue`/`scheduleReply` verbatim in behaviour, changing only the key and the policy hooks. Carry across the four properties those functions earned the hard way, each with its comment:

1. **Hold, don't drop.** When the slot timer fires and `canTransmit()` is false — checked both before and after the `isAirBusy` await, because state can change across it — clear `scheduled` and return, leaving the entry queued. Dropping it there is the original bug.
2. **Identity-guarded delete.** A send is seconds of audio; `clear()` plus a re-enqueue during it must not be discarded by the old closure. Delete only when the entry still at that id is this entry.
3. **Re-roll among later slots** when the air is busy, exhausting to `onFailed`.
4. **`onSent` inside the identity guard** — so a send completing after `clear()` cannot arm a retry into a torn-down room.

The module header should explain that this is the collision-avoidance layer, that slot count and length come from the caller so `ROOM_TIMING` stays the single source, and that draining only in transmitter-free states is what keeps an ACK or a TEXT retry out of a roll-call collect window — the hazard that silently killed file transfers.

- [ ] **Step 4: Run the outbox tests**

Run: `npx vitest run src/modem/test/outbox.test.ts`

Expected: PASS, all nine.

- [ ] **Step 5: Rewire roomProtocol onto the Outbox**

In `src/modem/chatter/roomProtocol.ts`:

- Construct one `Outbox` in the constructor, passing `deps.now/rng/schedule/isAirBusy/sendMessage`, `canTransmit: () => this.canTransmitReply()`, `replySlots: ROOM_TIMING.replySlots`, `replySlotMs: ROOM_TIMING.replySlotMs`, and `onSent: (e) => this.onOutboxSent(e)`.
- `onProbeHeard` enqueues with `kind` from the purpose (`'welcome'` or `'report'`), `dedupKey: \`reply:${deviceId}\``, and a `build` closure that reads `heardGrid` at send time — preserving today's behaviour, where the grid is read inside the timer rather than captured at enqueue.
- Keep `canTransmitReply()`, `awaitingAck`, and the reply-retry policy (`MAX_REPLY_ATTEMPTS`, the roll-call exclusion, the ack-clearing sites) in `roomProtocol`. `onOutboxSent` calls the existing `armReplyAck` logic for `kind === 'welcome'` only, exactly as today.
- Delete `replyQueue`, `drainReplyQueue`, `scheduleReply`. Replace `stop()`/`handleDepsError`'s `replyQueue.clear()` with `outbox.clear()`, and `setState`'s re-drain with `outbox.drain()`.
- Update the file header's queue paragraph to say the machinery now lives in `outbox.ts`, keeping the explanation of *why* it exists.

- [ ] **Step 6: Run the existing protocol tests unchanged**

Run: `npx vitest run src/modem/test/roomProtocol.test.ts`

Expected: PASS, all 31, **with no edits to the test file.** If any assertion fails, the extraction changed behaviour — fix the extraction, not the test. If a test reaches into a now-removed private (e.g. `(h.room as any).replyQueue`), that is the one legitimate reason to edit it; translate the assertion to the outbox equivalent and say so in your report.

- [ ] **Step 7: Run the gates**

Run: `npm run typecheck && npm run test && npm run lint`

Expected: typecheck clean; the 3 known BPSK failures only. `chatterLoopback.test.ts` and `chatterController.test.ts` must stay green.

- [ ] **Step 8: Commit**

```bash
git add src/modem/chatter/outbox.ts src/modem/chatter/roomProtocol.ts src/modem/test/outbox.test.ts
git commit -m "refactor(chatter): extract the slotted send queue into an Outbox

roomProtocol was 792 lines and already owned the machinery ACKs need:
a queue of owed transmissions, slot selection, carrier sense, re-roll on
busy, hold-don't-drop, identity-guarded deletes.

Behaviour-preserving — every roomProtocol test passes unchanged. The queue
key moves from proberId to a monotonic entry id with an explicit dedupKey,
because a TEXT broadcast is not keyed by a peer; replies pass
reply:<proberId> and keep today's dedup exactly.

Draining only in transmitter-free states is what will keep an ACK or a
TEXT retry out of a roll-call collect window — the hazard that silently
killed file transfers."
```

---

### Task 4: Send and receive TEXT, and answer with an ACK

**Files:**
- Modify: `src/modem/chatter/roomProtocol.ts` — `RoomDeps`, `onMessage`, new `sendText`, `handleText`, `handleAck`, dedup set
- Test: `src/modem/test/roomProtocol.test.ts`

**Interfaces:**
- Consumes: `packText`/`parseText`/`packAck`/`parseAck`/`TEXT_MAX_BYTES`/`textByteLength` (Task 1); `Outbox` (Task 3).
- Produces:
  - `RoomProtocol.sendText(text: string, targetId = 0): number` — returns the assigned `msgId`; throws if `textByteLength(text) > TEXT_MAX_BYTES`.
  - `RoomDeps.onTextReceived?(msg: { msgId: number; senderId: number; targetId: number; text: string }): void`
  - `RoomDeps.onTextAcked?(msgId: number, byDeviceId: number): void`

- [ ] **Step 1: Write the failing tests**

Add to `src/modem/test/roomProtocol.test.ts`. The harness's `deps` object needs the two new optional callbacks; add them alongside the existing ones and record calls in an array, following how `calls` is already used.

```typescript
  it('sends a broadcast TEXT from idle', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('hello room');
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    const sent = h.sent.find((m) => m.type === ControlType.Text);
    expect(sent).toBeDefined();
    expect(sent.targetId).toBe(0);
    expect(parseText(sent.payload)).toEqual({ msgId, text: 'hello room' });
  });

  it('addresses a DM to one device', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendText('just you', 7);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    expect(h.sent.find((m) => m.type === ControlType.Text).targetId).toBe(7);
  });

  it('rejects text over the byte cap', () => {
    const h = makeHarness(1);
    expect(() => h.room.sendText('x'.repeat(TEXT_MAX_BYTES + 1))).toThrow(/cap|exceeds/i);
  });

  it('a received broadcast TEXT is delivered and ACKed exactly once', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.Text, senderId: 9, targetId: 0, payload: packText(3, 'hi all'),
    });
    await h.tick(ROOM_TIMING.replySlotMs + 100);

    expect(h.textReceived).toEqual([{ msgId: 3, senderId: 9, targetId: 0, text: 'hi all' }]);
    const acks = h.sent.filter((m) => m.type === ControlType.Ack);
    expect(acks).toHaveLength(1);
    expect(acks[0].targetId).toBe(9);
    expect(parseAck(acks[0].payload)).toEqual({ msgId: 3 });
  });

  it('a duplicate (senderId, msgId) is neither re-delivered nor re-ACKed', async () => {
    // A retried TEXT arrives twice. The receiver must show it once and must
    // still ACK it once — the sender is retrying because it heard no ACK, so
    // a second ACK is not wrong, but a second delivery to the UI is.
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    const dup = { type: ControlType.Text, senderId: 9, targetId: 0, payload: packText(3, 'hi all') };
    h.room.onMessage(dup);
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    h.room.onMessage(dup);
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);

    expect(h.textReceived).toHaveLength(1);
  });

  it('ignores a DM addressed to someone else', async () => {
    const h = makeHarness(2);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.Text, senderId: 9, targetId: 5, payload: packText(4, 'not for you'),
    });
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    expect(h.textReceived).toHaveLength(0);
    expect(h.sent.filter((m) => m.type === ControlType.Ack)).toHaveLength(0);
  });

  it('a received ACK reports the acking device', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('hello');
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    h.room.onMessage({ type: ControlType.Ack, senderId: 8, targetId: 1, payload: packAck(msgId) });
    expect(h.textAcked).toEqual([{ msgId, by: 8 }]);
  });

  it('a TEXT queued while receiving is held, then sent on return to idle', async () => {
    const h = makeHarness(3);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.onMessage({
      type: ControlType.FileComing, senderId: 8, targetId: 0,
      payload: packFileComing({ pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 100, durationMs: 2000 }),
    });
    expect(h.room.state).toBe('receiving');

    h.room.sendText('during a transfer');
    await h.tick(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(0);

    await h.tick(2000 + 5000 + ROOM_TIMING.replySlotMs + 300);
    expect(h.room.state).toBe('idle');
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/modem/test/roomProtocol.test.ts`

Expected: FAIL — `sendText` does not exist.

- [ ] **Step 3: Add sendText**

In `roomProtocol.ts`, add a private `nextMsgId = 0` and:

```typescript
  /**
   * Queue a text message. `targetId` 0 broadcasts to the room; anything else
   * addresses one device — the air carries it either way, so this only
   * decides who ACTS on it, exactly as an addressed file transfer does.
   *
   * Returns the assigned msgId so the caller can track delivery. Throws on
   * over-long text rather than truncating: cutting UTF-8 at a byte boundary
   * can split a codepoint, and encodeControlMessage would reject the
   * oversized payload anyway. Callers check `textByteLength` first.
   */
  sendText(text: string, targetId = 0): number {
    if (textByteLength(text) > TEXT_MAX_BYTES) {
      throw new Error(`room: text ${textByteLength(text)} B exceeds ${TEXT_MAX_BYTES} B cap`);
    }
    const msgId = this.nextMsgId;
    this.nextMsgId = (this.nextMsgId + 1) & 0xff;
    const payload = packText(msgId, text);
    this.outbox.enqueue({
      kind: 'text',
      targetId,
      dedupKey: `text:${msgId}`,
      build: () => ({ type: ControlType.Text, senderId: this.deps.deviceId, targetId, payload }),
    });
    this.outbox.drain();
    return msgId;
  }
```

- [ ] **Step 4: Handle received TEXT and ACK**

Add two cases to `onMessage`'s switch, then the handlers:

```typescript
      case ControlType.Text:
        this.handleText(msg);
        break;
      case ControlType.Ack:
        this.handleAck(msg);
        break;
```

```typescript
  /** Received text: deliver once, then owe the sender an ACK. */
  private handleText(msg: ControlMessage): void {
    // Everyone in earshot demodulates a DM; only the addressee acts on it.
    // 0 is the broadcast address, same convention as FILE_COMING.
    if (msg.targetId !== 0 && msg.targetId !== this.deps.deviceId) return;
    const parsed = parseText(msg.payload);
    if (!parsed) return;

    // Contact from this peer, so any reply we were waiting to see acked is
    // acked (see awaitingAck).
    this.awaitingAck.delete(msg.senderId);

    const key = `${msg.senderId}:${parsed.msgId}`;
    const fresh = !this.seenText.has(key);
    if (fresh) {
      this.rememberText(key);
      this.deps.onTextReceived?.({
        msgId: parsed.msgId, senderId: msg.senderId, targetId: msg.targetId, text: parsed.text,
      });
    }

    // ACK even a duplicate: a repeat means the sender heard no ACK, so
    // staying silent guarantees it retries again. Only the UI delivery is
    // deduped. dedupKey collapses two ACKs for the same message into one.
    this.outbox.enqueue({
      kind: 'ack',
      targetId: msg.senderId,
      dedupKey: `ack:${msg.senderId}:${parsed.msgId}`,
      build: () => ({
        type: ControlType.Ack,
        senderId: this.deps.deviceId,
        targetId: msg.senderId,
        payload: packAck(parsed.msgId),
      }),
    });
    this.outbox.drain();
  }

  private handleAck(msg: ControlMessage): void {
    if (msg.targetId !== this.deps.deviceId) return;
    const parsed = parseAck(msg.payload);
    if (!parsed) return;
    this.awaitingAck.delete(msg.senderId);
    this.deps.onTextAcked?.(parsed.msgId, msg.senderId);
  }
```

Add the dedup set with an age bound — an unbounded set would grow for the session's life:

```typescript
  /** Recently delivered (senderId:msgId) keys, newest last, bounded so a long
   *  session cannot grow it without limit. msgId wraps at 256, so the bound
   *  also caps how far back a wrap could collide. */
  private readonly seenText: Set<string> = new Set();

  private rememberText(key: string): void {
    this.seenText.add(key);
    if (this.seenText.size > SEEN_TEXT_MAX) {
      const oldest = this.seenText.values().next().value as string | undefined;
      if (oldest !== undefined) this.seenText.delete(oldest);
    }
  }
```

with `const SEEN_TEXT_MAX = 128;` beside the other module constants, commented as bounding both memory and msgId-wrap collisions. Clear it in `stop()` alongside the other per-session state.

Add the two optional callbacks to `RoomDeps`, documented as display-only — never read by a protocol decision.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/modem/test/roomProtocol.test.ts`

Expected: PASS — the eight new tests plus all pre-existing ones.

- [ ] **Step 6: Run the gates and commit**

Run: `npm run typecheck && npm run test && npm run lint`

```bash
git add src/modem/chatter/roomProtocol.ts src/modem/test/roomProtocol.test.ts
git commit -m "feat(chatter): send and receive text, answer with an ACK

targetId already gives DMs: 0 is the room, anything else one device, and
the air carries it either way so it only decides who acts.

A duplicate is delivered to the UI once but still ACKed — a repeat means
the sender heard no ACK, so silence guarantees another retry. The seen-set
is bounded, since msgId wraps at 256 and an unbounded set would grow for
the whole session."
```

---

### Task 5: Retry, delivery state, and the message store

**Files:**
- Modify: `src/modem/chatter/roomProtocol.ts` — text retry policy
- Modify: `src/ui/Store.ts` — `chatterMessages` ring
- Test: `src/modem/test/roomProtocol.test.ts`

**Interfaces:**
- Consumes: `sendText`, `onTextAcked`, `Outbox` from Tasks 3-4.
- Produces:
  - `RoomDeps.onTextStateChange?(msgId: number, state: 'sending' | 'delivered' | 'failed', ackedBy: number[]): void`
  - `Store`: `chatterMessages: ChatMessage[]`, `CHATTER_MESSAGE_LOG_MAX = 100`, and
    `interface ChatMessage { seq: number; msgId: number; senderId: number; targetId: number; text: string; tMs: number; dir: 'tx' | 'rx'; ackedBy: number[]; state: 'sending' | 'delivered' | 'failed' }`
  - `ROOM_TIMING.ackWindowMs` — derived, not hardcoded

- [ ] **Step 1: Write the failing tests**

```typescript
  it('a DM with no ACK retries once, then fails', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendText('you there?', 7);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(1);

    await h.tick(ROOM_TIMING.ackWindowMs + ROOM_TIMING.replySlotMs + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(2);

    await h.tick(ROOM_TIMING.ackWindowMs + ROOM_TIMING.replySlotMs + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(2); // capped
    expect(h.textStates.at(-1)).toMatchObject({ state: 'failed' });
  });

  it('a DM that is ACKed does not retry', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('you there?', 7);
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    h.room.onMessage({ type: ControlType.Ack, senderId: 7, targetId: 1, payload: packAck(msgId) });

    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(1);
    expect(h.textStates.at(-1)).toMatchObject({ state: 'delivered', ackedBy: [7] });
  });

  it('a broadcast with one ACK does not retry', async () => {
    // Retrying because one of several peers missed it would spend seconds of
    // air punishing the ones that heard it.
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('hello room');
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    h.room.onMessage({ type: ControlType.Ack, senderId: 5, targetId: 1, payload: packAck(msgId) });

    await h.tick(60000);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(1);
    expect(h.textStates.at(-1)).toMatchObject({ state: 'delivered', ackedBy: [5] });
  });

  it('a broadcast with zero ACKs retries once', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    h.room.sendText('anyone?');
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    await h.tick(ROOM_TIMING.ackWindowMs + ROOM_TIMING.replySlotMs + 200);
    expect(h.sent.filter((m) => m.type === ControlType.Text)).toHaveLength(2);
  });

  it('records every acking device on a broadcast', async () => {
    const h = makeHarness(1);
    h.room.start();
    await h.tick(ROOM_TIMING.listenMs + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200);
    const msgId = h.room.sendText('roll up');
    await h.tick(ROOM_TIMING.replySlotMs + 100);
    h.room.onMessage({ type: ControlType.Ack, senderId: 5, targetId: 1, payload: packAck(msgId) });
    h.room.onMessage({ type: ControlType.Ack, senderId: 6, targetId: 1, payload: packAck(msgId) });
    h.room.onMessage({ type: ControlType.Ack, senderId: 5, targetId: 1, payload: packAck(msgId) }); // dup
    expect(h.textStates.at(-1)).toMatchObject({ state: 'delivered', ackedBy: [5, 6] });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/modem/test/roomProtocol.test.ts -t "ACK"`

Expected: FAIL — `ROOM_TIMING.ackWindowMs` is undefined and no retry exists.

- [ ] **Step 3: Add the derived window**

In `ROOM_TIMING`:

```typescript
  /**
   * How long a sent TEXT waits for an ACK before its one retry.
   *
   * DERIVED, never hardcoded: the slot span every ACK is drawn from, plus one
   * whole ACK's airtime. `collectExtraMs` was a hardcoded window sized
   * against an assumption a later change invalidated, and the result was a
   * retried reply landing outside it and silently killing a file transfer —
   * see this module's history. ACK_AIR_MS is the measured air time of a
   * 1-byte control payload: 35 wire bytes over 8 QPSK tones plus the fixed
   * ~1.5 s preamble.
   */
  ackWindowMs: 6 * 300 + 2000,
```

Express it in terms of `replySlots`/`replySlotMs` rather than the literals `6 * 300` if the object's shape allows a self-reference; if it does not, compute it immediately after the object with an exported helper and note why.

- [ ] **Step 4: Track sent text and retry**

Add a per-message record and the retry timer:

```typescript
/** Total sends per text message, including the first — same discipline as
 *  MAX_REPLY_ATTEMPTS. A failed 254-byte message already costs ~21 s of air
 *  across two attempts. */
const MAX_TEXT_ATTEMPTS = 2;
```

```typescript
interface SentText {
  msgId: number;
  targetId: number;
  payload: Uint8Array;
  attempts: number;
  ackedBy: number[];
}
```

Keep them in `private readonly sentText = new Map<number, SentText>()`, cleared in `stop()`.

After each successful TEXT send (via the outbox's `onSent` hook for `kind === 'text'`), arm a timer for `ROOM_TIMING.ackWindowMs`. When it fires:

- **DM** (`targetId !== 0`): retry if `ackedBy` does not include `targetId`.
- **Broadcast** (`targetId === 0`): retry only if `ackedBy` is empty.
- Either way, only while `attempts < MAX_TEXT_ATTEMPTS`; otherwise report `'failed'`.

`handleAck` pushes into `ackedBy` (ignoring duplicates), and reports `'delivered'` the first time the message becomes acked. Comment the broadcast rule with the reasoning: retrying because one of several peers missed it punishes the ones that heard it, in a half-duplex room.

- [ ] **Step 5: Add the store ring**

In `src/ui/Store.ts`, beside `chatterPackets`:

```typescript
/** One chat message, newest LAST. Capped at CHATTER_MESSAGE_LOG_MAX.
 *  Display-only — never read by a protocol decision. */
export interface ChatMessage {
  /** Monotonic counter, unique per session — React key. */
  seq: number;
  /** Sender-assigned id, wraps at 256. Unique only per senderId. */
  msgId: number;
  senderId: number;
  /** 0 = the whole room. */
  targetId: number;
  text: string;
  tMs: number;
  dir: 'tx' | 'rx';
  /** Device ids that acknowledged this message. Meaningful for dir 'tx'. */
  ackedBy: number[];
  state: 'sending' | 'delivered' | 'failed';
}

export const CHATTER_MESSAGE_LOG_MAX = 100;
```

Add `chatterMessages: ChatMessage[]` to the state interface and `chatterMessages: []` to the defaults.

- [ ] **Step 6: Run the tests, the gates, and commit**

Run: `npx vitest run src/modem/test/roomProtocol.test.ts` then `npm run typecheck && npm run test && npm run lint`

```bash
git add src/modem/chatter/roomProtocol.ts src/ui/Store.ts src/modem/test/roomProtocol.test.ts
git commit -m "feat(chatter): retry an unacked message once, track delivery

A DM retries if its addressee did not ACK. A broadcast retries only on
ZERO ACKs — retrying because one of several peers missed it spends seconds
of air punishing the ones that heard it, in a half-duplex room.

The ACK window is derived from ROOM_TIMING, not hardcoded: collectExtraMs
was a hardcoded window sized against an assumption a later change
invalidated, and a retry landing outside it silently killed transfers."
```

---

### Task 6: Wire it to the controller and prove it over synthesised audio

**Files:**
- Modify: `src/ui/controllers/chatterController.ts` — `sendText`, the three `RoomDeps` text callbacks, packet-log `kind`s
- Modify: `src/ui/Store.ts` — nothing further; Task 5 added the ring
- Test: `src/modem/test/chatterController.test.ts`, `src/modem/test/chatterLoopback.test.ts`

**Interfaces:**
- Consumes: `RoomProtocol.sendText`, `onTextReceived`, `onTextAcked`, `onTextStateChange` (Tasks 4-5); `ChatMessage`, `CHATTER_MESSAGE_LOG_MAX` (Task 5).
- Produces: `ChatterController.sendText(text: string, targetId?: number): void` — the entry point spec 2's UI calls.

- [ ] **Step 1: Write the failing tests**

In `chatterController.test.ts`. That file has no `makeController` helper — each test assembles `makeFakeWorker()`, `makeFakePlayer()` and `makeClock()` itself, as below. Also add `chatterMessages: []` to the `beforeEach` `setState` block, or state leaks between tests.

```typescript
  it('sends text through the control path and records it in the store', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const rng = () => 0; // deviceId = 1, slot 0
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng });

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + MUTE_TAIL_MS
      + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200,
    );

    controller.sendText('hello room');
    await clock.tick(ROOM_TIMING.replySlotMs + MUTE_TAIL_MS + 200);

    // ControlType.Text is 5 — the fake records `encodeControl:<type>`.
    expect(worker.calls).toContain(`encodeControl:${ControlType.Text}`);
    const msgs = getState().chatterMessages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ text: 'hello room', dir: 'tx', targetId: 0, state: 'sending' });
  });

  it('records a received message and its own ack in the store', async () => {
    const worker = makeFakeWorker();
    const player = makeFakePlayer();
    const clock = makeClock();
    const rng = () => 0;
    const controller = new ChatterController(worker, { player, schedule: clock.schedule, now: clock.now, rng });

    await controller.joinRoom();
    await clock.tick(
      ROOM_TIMING.listenMs + MUTE_TAIL_MS
      + ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs + 200,
    );

    const payload = packText(2, 'incoming');
    worker.emit('controlMessage', {
      msg: {
        type: ControlType.Text,
        senderId: 9,
        targetId: 0,
        // The worker transfers payloads as ArrayBuffer; ChatterController
        // wraps them back into a Uint8Array.
        payload: payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      },
    });
    await clock.tick(ROOM_TIMING.replySlotMs + MUTE_TAIL_MS + 200);

    const msgs = getState().chatterMessages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ text: 'incoming', dir: 'rx', senderId: 9 });
    expect(worker.calls).toContain(`encodeControl:${ControlType.Ack}`);
    expect(getState().chatterPackets.some((p) => p.kind === 'ack')).toBe(true);
  });
```

Add `packText` and `ControlType` to that file's imports if not already present.

In `chatterLoopback.test.ts`, add a case driving real synthesised audio between the two protocol instances it already builds: A sends text, B decodes it, B's ACK reaches A, and A's message reaches `delivered`. Read that file's existing `feedProbe`/`playProbe`/control-message plumbing and extend it — it already synthesises control audio through `TxEngine.buildHandshakeSegment` and decodes with a real `RxEngine`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/modem/test/chatterController.test.ts src/modem/test/chatterLoopback.test.ts`

Expected: FAIL — `controller.sendText` does not exist.

- [ ] **Step 3: Extend the packet log kinds**

`ChatterPacket['kind']` in `Store.ts` is `'probe' | 'welcome' | 'report' | 'fileComing' | 'bye' | 'file'`. Add `'text' | 'ack'`, and extend `controlKindFromType` in `chatterController.ts` to map `ControlType.Text` and `ControlType.Ack`. Its `default` currently falls through to `'report'`, which would mislabel both.

- [ ] **Step 4: Add sendText and the store wiring**

```typescript
  /** Send a chat message. `targetId` 0 (the default) goes to the whole room;
   *  anything else addresses one member. Rejects over-long text via the
   *  protocol's own cap rather than silently truncating. */
  sendText(text: string, targetId = 0): void {
    if (!getState().chatterOn) {
      setState({ chatterError: 'join the room before sending a message' });
      return;
    }
    try {
      const msgId = this.room.sendText(text, targetId);
      this.recordMessage({
        msgId, senderId: this.deviceId, targetId, text,
        dir: 'tx', ackedBy: [], state: 'sending',
      });
    } catch (err) {
      setState({ chatterError: err instanceof Error ? err.message : String(err) });
    }
  }
```

Add a `recordMessage` helper mirroring `recordPacket` — a monotonic `seq`, `tMs` from `this.deps.now()`, and the `slice(-CHATTER_MESSAGE_LOG_MAX)` bound.

Wire the three `RoomDeps` callbacks in the constructor's `deps` object: `onTextReceived` records an `rx` message with `state: 'delivered'` (a received message is, definitionally, delivered here); `onTextAcked` and `onTextStateChange` patch the matching `tx` message's `ackedBy`/`state` in place, matched on `msgId` and `dir === 'tx'`.

- [ ] **Step 5: Run the tests, the gates, and commit**

Run: `npx vitest run src/modem/test/chatterController.test.ts src/modem/test/chatterLoopback.test.ts` then `npm run typecheck && npm run test && npm run lint`

```bash
git add src/ui/controllers/chatterController.ts src/ui/Store.ts src/modem/test/
git commit -m "feat(chatter): expose sendText and mirror messages into the store

ChatterController.sendText is the entry point the chat UI will call. The
packet log gains text/ack kinds — its default previously fell through to
'report', which would have mislabelled both."
```

- [ ] **Step 6: STOP — hand back for an over-the-air test**

Report to the operator:

> Text messaging is implemented and passes loopback, including a full TEXT → ACK exchange over synthesised audio.
>
> Two things need real hardware, and one of them is new:
>
> 1. **A maximum-length message specifically.** A 254-byte message is ~10.4 s of audio, four times longer than anything the control plane has carried. The 5 s sync watchdog was one timing assumption sized against ~3.5 s; there may be another that only a long message reveals. Send a short message and a maximum-length one, and compare.
> 2. **The relocated handshake band is still unmeasured.** Text rides it, so if that measurement goes badly this feature is affected identically — it adds no new band risk of its own.
>
> There is no UI yet. Drive it from the console via the controller's `sendText`, or wait for spec 2.

---

## Plan self-review

**Spec coverage.** Section A (wire format, cap 48→255, byte-not-character cap, dedup key) → Task 1 and Task 4's `seenText`. Section B (length-aware watchdog) → Task 2. Section C (outbox extraction, drain-only-when-free) → Task 3. Section D (retry rules, derived window, delivery state) → Task 5. Section E (store ring) → Task 5, consumed in Task 6. Verification list → distributed across every task's test step, with the loopback TEXT→ACK exchange in Task 6. Non-goals have no tasks by design; the UI is spec 2.

**Type consistency.** `OutboxEntry`/`OutboxDeps`/`Outbox` are defined in Task 3 and consumed with those names in Tasks 4-5. `packText`/`parseText`/`packAck`/`parseAck`/`TEXT_MAX_BYTES`/`textByteLength` are defined in Task 1 and used unchanged in Tasks 2, 4, 6. `ChatMessage`'s field names in Task 5 match what Task 6's `recordMessage` and assertions use. `ROOM_TIMING.ackWindowMs` is added in Task 5 and referenced only in Task 5's tests.

**Known risks flagged in-plan.** Task 3 is the highest-risk task — a behaviour-preserving refactor of a 792-line file with 31 existing tests — and its Step 6 makes "no test edits" the pass condition, with the one legitimate exception spelled out. Task 2 touches a FRAGILE file and is bounded to four edits. Task 5's window is required to be derived rather than hardcoded, naming the specific past failure that rule comes from.

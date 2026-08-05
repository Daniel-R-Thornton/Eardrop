# Chatter text messaging — group chat and DMs over the control plane

Date: 2026-08-05
Status: approved, not yet implemented
Scope: protocol and state only. The chat panel and the RoomMode mobile
overhaul are a second spec that depends on this one landing first.

Predecessor: `2026-08-05-chatter-control-plane-design.md`, which fixed the
control plane this feature rides on.

## Why this exists

The chatter room can find peers and send files. It cannot send a message.
Sending "ready?" currently means wrapping text in a file and paying the whole
roll-call, band-negotiation and receiver-arming cost for four characters.

Short text does not need any of that. The control plane is already the most
robust path in the system — 8 QPSK tones on a fixed band, BCH(63,30) per three
bytes, CRC-16 over the payload, no negotiation and no band hop — so a message
should ride it directly.

## Airtime reality, stated up front

This is a half-duplex acoustic room. One device talking blocks every other.

Text bytes are what the user types; payload adds the 1-byte `msgId`; wire adds
the CRC-16, the BCH expansion (3 raw bytes → 8 wire bytes) and the 27-byte
header. Air time is wire bytes ÷ 2 bytes-per-symbol × 25 ms, plus a 1.5 s
preamble.

| Text bytes | Payload | Wire bytes | Air time |
|---|---|---|---|
| 2 ("ok") | 3 | 43 | ~2.0 s |
| 140 | 141 | 411 | ~6.6 s |
| 254 (max) | 255 | 715 | ~10.4 s |
| — (ACK) | 1 | 35 | ~2.0 s |

The 1.5 s preamble dominates short messages, which is why a two-character
message costs ~2 s rather than ~0.1 s.

With read receipts, a group message in a three-device room is one TEXT plus two
slotted ACKs — roughly 8-14 s from send to both receipts, with the room blocked
throughout. A retry doubles the TEXT's share. This is the medium, not a defect,
but the interaction will feel like a walkie-talkie rather than a chat app, and
the UI (spec 2) must set that expectation rather than hide it.

## Design

### A. Wire format

Two new control types on the existing plane. No new band, no negotiation, no
change to the header layout.

```
ControlType.Text = 5   payload: [msgId:1][utf8 text: 0..254]   (255 B max)
ControlType.Ack  = 6   payload: [msgId:1]                      (1 B)
```

`CONTROL_PAYLOAD_MAX` rises from 48 to **255**.

48 was never a structural limit — it was chosen so WELCOME's 35 bytes "still
fits a handful of codewords" (`controlFrame.ts`). The header carries
`payloadLen` as a full byte, so the frame is already variable-length and
self-describing: the receiver reads exactly the number of bytes the header
declares. 255 is the true ceiling of that field, and reaching it costs one
constant. Verified that nothing downstream assumes a small payload — the
scanner's `collectBytes` is retargeted per message via `continueCollecting`,
and both the collect sizing and `decodeControlPayload` are driven off
`header.payloadLen`.

Addressing needs nothing new: `targetId` 0 is the whole room, any other value
is a DM. An ACK's `targetId` is the original sender and its `senderId` is the
acknowledging device, so `(targetId, msgId)` identifies the acked message
uniquely and the ACK payload carries only the id.

`msgId` is monotonic per sender, wrapping at 256. The dedup key is
`(senderId, msgId)`; the receiver's dedup set is bounded by age, not allowed to
grow for the session's life.

**The cap is 254 *bytes*, not characters.** UTF-8: an emoji is 4 bytes, an
accented letter 2. The composer counts bytes and refuses to exceed them.
Truncating instead would either throw in `encodeControlMessage` (which rejects
above `CONTROL_PAYLOAD_MAX`) or split a codepoint and put invalid UTF-8 on the
air.

**Accepted cost of long messages.** BCH decodes per three-byte chunk and
`bchDecodeChunks` returns null if any single chunk is uncorrectable, so a
control message is all-or-nothing. A 254-byte message is 86 chunks; one bad
chunk loses the whole thing. Probability of total loss therefore grows roughly
with length, as does airtime, so a failed long message costs ~21 s across its
two attempts to learn that nothing arrived. Chunking long text across smaller
frames was considered and rejected as premature: it needs reassembly state,
per-chunk retry, and a rule for a chunk that never arrives — a new protocol on
top of one just stabilised.

### B. The receiver's watchdog must become length-aware

**This is the part that would otherwise fail only on hardware.**

The control listener has a sync-loss watchdog (`rxEngine.ts`, the
`OFDM_WATCHDOG_WINDOWS` getter) set to 5 s in chatter mode, documented as
"comfortably longer than any real message (preamble + at most a 48-byte
payload)". It fires on "no CRC-valid frame within N windows", resets the
receiver to `WAITING` and clears its buffer. It exists because a false sync
otherwise leaves the listener deaf, and hardware once showed a listener burning
601 windows and missing the FILE_COMING that followed.

That assumption dies with this change. A 255-byte payload is ~8.6 s of symbols
after its header, so the watchdog would reset the receiver mid-message and every
long message would vanish. Left unaddressed, the real cap is ~147 bytes of
text, not 254.

**Fix: extend the deadline by exactly what the header declares.** When
`processCard` decodes a valid control header it already computes
`controlPayloadWireSize(header.payloadLen)` to tell the scanner how much to
collect. The same number gives the payload's duration in symbols
(`ceil(wireBytes / bytesPerSymbol)`, with `bytesPerSymbol` derived as
`max(1, floor(OFDM_HANDSHAKE.toneCount / 4))` — the idiom already used for card
sizing). Add that as a one-shot grace to the watchdog comparison, cleared when
the message completes or the watchdog fires.

Raising the constant instead was rejected: it would weaken the false-sync case
the watchdog exists for, across the board, to serve one message type. The
grace approach cannot be abused by a false sync, because a false sync never
decodes a valid header and so never earns the extension.

`OFDM_WATCHDOG_WINDOWS`'s doc comment must be updated — its "at most a 48-byte
payload" reasoning is exactly the stale prose that has been a review finding on
every task of the predecessor spec.

### C. Extract the outbox

`roomProtocol.ts` is 792 lines. Adding TEXT, ACK and a second retry path pushes
it past 900, and the machinery ACKs need already lives there: a queue of owed
transmissions keyed by peer, a randomly chosen reply slot, carrier sense before
each attempt, re-roll among later slots when the air is busy, hold-don't-drop
when the transmitter becomes unavailable, and a bounded ack-arming retry.

Extract it to `src/modem/chatter/outbox.ts`, generalised from "replies owed to
probers" to "transmissions owed", with `roomProtocol` as its first consumer.
TEXT and ACK then inherit collision avoidance and carrier sense rather than
reimplementing them.

This is also what keeps a known hazard closed. The predecessor's Critical was a
retried reply landing inside a roll-call collect window, colliding with a
FILE_COMING that had no carrier sense in front of it, losing an entire file
transfer silently. The outbox drains only in `idle` and `joinWait` — never
`collecting`, `rollCall`, `sending` or `receiving` — so a TEXT retry or an ACK
cannot land inside that window either. The extraction must preserve that
property exactly, and its tests must pin it.

### D. Retry and delivery state

| Case | Retry when | Surfaced as |
|---|---|---|
| DM (`targetId ≠ 0`) | that device has not ACKed within the window | `sending` → `delivered` / `failed` |
| Broadcast (`targetId = 0`) | **zero** ACKs within the window | `sending` → `delivered (n)` / `failed` |

Broadcast retries only on total silence, deliberately: retrying because one of
three peers missed it spends several seconds of air punishing the two who heard
it. Two sends total, matching the existing `MAX_REPLY_ATTEMPTS` discipline.

The window is derived from `ROOM_TIMING` — the slot span plus one full ACK
duration — never hardcoded. `collectExtraMs` was a hardcoded window sized
against an assumption a later change invalidated, and that is precisely how the
predecessor's Critical happened.

A dedicated ACK frame also repairs something the predecessor could not do.
Its reply retry was specified to trigger on "any traffic from that prober", but
nothing in the protocol transmits in response to a WELCOME or REPORT, so the
condition was unsatisfiable and the retry fired every time. A real ACK makes
the condition genuinely satisfiable for text.

### E. Store

A bounded `chatterMessages` ring beside `chatterPackets`:

```ts
{ msgId, senderId, targetId, text, tMs, dir, ackedBy: number[], state }
state: 'sending' | 'delivered' | 'failed'
```

Display-only, like `chatterPackets` — never read by a protocol decision.

## Non-goals

- **The chat UI and the RoomMode mobile overhaul.** Spec 2. This spec's
  deliverable is testable headlessly.
- **Chunking text beyond 254 bytes.** See A.
- **Encryption or authentication.** Anything in earshot can read the room, and
  a `senderId` is 8 bits with no proof of identity. This is a plaintext
  broadcast medium and the UI must not imply otherwise.
- **Message history across sessions.** The ring is in-memory.
- **Typing indicators, presence beyond the existing roster, edits, deletes.**

## Verification

- `controlFrame.test.ts`: TEXT and ACK round-trip; a 254-byte payload at the new
  cap; multi-byte UTF-8 intact at exactly the cap; a payload over the cap
  throws; `payloadLen` above 48 decodes correctly (the old cap is not baked in
  anywhere).
- `rxEngine` or a focused test: a control message whose payload exceeds 5 s of
  symbols decodes end to end; a false sync with no valid header still resets on
  the 5 s watchdog rather than inheriting any grace.
- `roomProtocol.test.ts` (manual clock): a received TEXT enqueues exactly one
  ACK; a duplicate `(senderId, msgId)` is not re-delivered and not re-ACKed; a
  DM with no ACK retries once then fails; a broadcast with one ACK does not
  retry; a broadcast with zero ACKs retries once; a TEXT queued during
  `sending`/`collecting` is held and transmitted on return to `idle`, not
  dropped.
- `chatterLoopback.test.ts`: a real synthesised TEXT → ACK exchange between two
  protocol instances over the new band.
- The outbox extraction must leave every existing `roomProtocol.test.ts`
  assertion passing unchanged. Any test that needs rewriting to accommodate it
  is a signal the extraction changed behaviour.
- `npm run typecheck`, `npm run test`, `npm run lint` and `npm run build`. The 3
  pre-existing `pipeline.test.ts` BPSK Doppler/stress failures stay red;
  nothing else may.

## Risks

- **The relocated handshake band is still unmeasured over the air.** Text rides
  it, so if the predecessor's pending measurement goes badly this feature is
  affected identically. It does not add a new band risk of its own.
- **A 10 s transmission is four times longer than anything the control plane has
  carried.** The watchdog is the failure mode found by reading; there may be
  another timing assumption sized against ~3.5 s that only a long message
  reveals. The over-the-air test for this spec should include a maximum-length
  message specifically, not just short ones.
- **`rxEngine.ts` is marked FRAGILE** in the README. Section B touches it. That
  change should be one field, one comparison, one assignment in `processCard`,
  and one comment — anything larger deserves a second look.

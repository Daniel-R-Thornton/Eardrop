# Chatter — acoustic room protocol

**Date:** 2026-08-03
**Status:** Approved design, pre-implementation
**Depends on:** the `band-handshake` branch (band card + `HandshakeReceiver`)

## Summary

Chatter is a new mode that turns Eardrop's one-way file send into a small
acoustic "room": any device can join by announcing itself over the air, every
device keeps a table of who else is present, and any member can broadcast a
file to all other members. The protocol is half duplex (strict turn-taking),
designed for N devices but bench-tested at 2–3, and calibrates lazily — the
accurate per-pair channel measurement happens at file-send time, in the exact
direction the file will travel, not at join time.

The file transfer itself is unchanged: the existing band-card handshake path
(chirp + card on the fixed handshake band, receiver hops to the announced
band) carries the payload, fed with settings negotiated by the room protocol.

## Goals

- Zero-configuration multi-device transfer: open the app, join the room, drop
  a file, everyone present receives it.
- Best-possible link settings per transfer: band, tone count, QAM map, and
  per-tone pre-emphasis chosen from fresh receiver-side measurements.
- Worst-case floor, not worst-case start: when negotiation cannot find a
  common band, fall back to handshake-grade QPSK at minimum tones — the
  transfer still happens, just slowly.
- No clock sync, no persistent identity, no infrastructure device: every
  member runs the same state machine; there is no mast/client asymmetry.

## Non-goals (v1)

- Full duplex (simultaneous talk on split bands). The message layer does not
  care, so this can come later.
- Unicast/addressed file transfer. v1 broadcasts to whoever answers the roll
  call.
- ARQ / per-block retransmission. The existing FEC + repeat machinery is the
  reliability story, as today.
- Background liveness (heartbeats). Membership is advisory; the pre-send roll
  call is the source of truth.

## Wire primitives

Two new wire objects. Everything else reuses existing paths.

### 1. Probe burst (sweep + ID)

One primitive serves both the join announcement and the pre-send roll call:

```
[ silence ~100 ms ][ stepped-sine sweep ~3 s ][ 12 pulse slots ~480 ms ]
```

- **Sweep:** built and measured with the existing `buildSweep` /
  `measureSweep` from `channelSweep.ts`, using coarse chatter options
  (~1500–8000 Hz, 100 Hz steps, 45 ms per step ≈ 3 s) instead of the
  15-second calibration defaults. Coarse is sufficient: the goal is band
  selection and coarse pre-emphasis, not 25 Hz notch hunting.
- **ID trailer:** 12 pulse slots anchored on the sweep's end (the sweep is
  the timing reference — no separate sync). Each slot ≈ 40 ms; a raised-
  cosine tone burst at a fixed frequency (~2.5 kHz) present = 1, absent = 0.
  Content: 8-bit device ID + 4-bit CRC. Detection is per-slot energy, so the
  ID decodes at SNR levels where OFDM would not.
- **Device ID:** random 8-bit value chosen per session. Collision odds are
  acceptable at room scale; a clash is survivable (worst case: two devices
  answer as one, roll call still measures a real channel).

### 2. Control message frame

Small data messages on the fixed `OFDM_HANDSHAKE` band (8 QPSK tones,
~11 dB margin on the weakest bench hardware):

```
sentinel (3 B)
BCH(63,30)×3 header (24 B): magic, type, sender ID, target ID, payload length, CRC-8
payload (0–48 B): hamming-coded, CRC-16 trailer
```

- Same sentinel + BCH skeleton as the band card, with a distinct magic byte
  so the scanner can tell cards, frames, and messages apart.
- ≈ 0.4–1.0 s per message depending on payload size.
- Rides the existing TX/RX engines in `bandHandshake` mode — the same
  modulation path the band card already uses.

**Message types (v1):**

Sweep responses travel on a fixed **report grid**: 64 points at 100 Hz
spacing, 1500–7800 Hz, 4 bits per point (relative dB, quantized) = 32 B.
The grid is a wire constant shared by all report-carrying messages.

A **best-range claim** is the compact triple
`(lowHz, highHz, maxQamOrder)` — the band the device believes it hears well
and the densest constellation it has decoded there (3 B, bin-coded like the
band card).

| Type | Payload | Purpose |
|---|---|---|
| `WELCOME` | own best-range claim (3 B) + report-grid response to the joiner's sweep (32 B) | reply to a join probe |
| `REPORT` | report-grid response to the roll-call sweep (32 B) | roll-call ack |
| `FILE_COMING` | negotiated band-card fields + file metadata (size, expected duration) | transfer announcement |
| `BYE` | — | optional, best-effort leave |

## Room protocol

Every device runs the same state machine:

```
COLD → LISTEN(1 s) → ANNOUNCE(probe burst) → JOIN_WAIT(reply window) → IDLE
IDLE → (user drops file) → ROLL_CALL(probe burst) → COLLECT(reports) → TX_FILE → IDLE
IDLE → (hear probe)      → measure sweep, decode ID → reply in random slot → IDLE
IDLE → (hear FILE_COMING) → RX_FILE (existing HandshakeReceiver path) → IDLE
```

### Join

1. `LISTEN` for 1 s. Air busy (band RMS above the carrier-sense threshold)
   → keep waiting, capped at ~10 s, then announce anyway.
2. `ANNOUNCE`: transmit the probe burst. Every member that hears it measures
   the joiner→self channel from the sweep — N measurements from one burst.
3. `JOIN_WAIT`: ~6 s reply window. Members reply `WELCOME` in one of K ≈ 6
   random 1 s slots, with listen-before-slot: if the air is busy at the
   slot's start, re-roll to a later slot (LoRa-flavoured slotted ALOHA).
   Colliding replies garble and are simply lost; the roll call re-discovers
   everyone at send time, so this is not fatal.
4. No replies → the device is the room's first member; sit `IDLE`.

### Send

1. Carrier-sense, then transmit the `ROLL_CALL` probe burst.
2. `COLLECT` window: K random 1 s slots (K ≈ 6, same slotting as
   `JOIN_WAIT`): each member measures the sweep and replies `REPORT` with
   the report-grid response it heard — exact pair, exact direction, fresh.
3. Sender intersects the reports: band, tone count, QAM map, and per-tone
   pre-emphasis gains chosen worst-peer-per-tone so every responder can
   decode. Zero reports → abort and tell the user the room is empty.
   Empty intersection (no common band) → worst-case floor profile:
   handshake-grade QPSK, minimum tones.
4. Send `FILE_COMING` (settings summary + file meta), a short gap, then the
   existing bandHandshake transmission. Receivers arm the existing
   `HandshakeReceiver`; the band card is still transmitted, so they tune
   from the air exactly as today. Lurkers that missed the roll call but
   catch `FILE_COMING` can still receive.
5. Everyone returns to `IDLE`.

### Membership table

`id → { lastHeard, bestRangeClaim, perToneData? }` — UI display and starting
guess only, never load-bearing. No heartbeats; entries age out visually
(~5 min). Leaving = just stop transmitting (optional best-effort `BYE`).

### Timing

All windows are wall-clock intervals anchored on observable events (end of
own burst, end of a heard sweep). No clock sync between devices; slots are
sized generously (1 s) to absorb audio-latency spread, tolerances ±100 ms.

## Components

Pure logic is split from I/O shells, the same pattern `calibration.ts` uses:

| File | Responsibility |
|---|---|
| `src/modem/protocol/probeBurst.ts` | Build + detect the sweep+ID burst. Wraps `buildSweep`/`measureSweep` with chatter options; pulse-key ID codec anchored on sweep end. |
| `src/modem/protocol/controlFrame.ts` | Control-message encode/decode. Sibling of `bandCard.ts` (same sentinel+BCH skeleton, new magic). Payload codecs for `WELCOME`/`REPORT`/`FILE_COMING`. |
| `src/modem/chatter/roomProtocol.ts` | The state machine. Pure: no AudioContext, no worker. Injected deps (`playBurst`, `sendMessage`, `now`, `rng`, event callbacks). Owns the membership table. |
| `src/modem/chatter/settingsPick.ts` | Report intersection → band / tone count / QAM map / gains (worst-peer-per-tone), plus the worst-case floor fallback. |
| `src/workers/modemService.ts` | New chatter listen mode: handshake-band RxEngine listener + probe detector on the sample stream. Emits `probeHeard {id, mags}`, `controlMessage {msg}`; answers a carrier-sense query (band RMS over the last N ms). |
| `src/ui/controllers/chatterController.ts` | I/O shell: owns `AudioPlayer`/`AudioRecorder`, routes worker events → `roomProtocol`, protocol actions → encode+play. Arms the `HandshakeReceiver` path on `FILE_COMING`. Mutes worker RX during own playback. |
| `src/ui/…` | Room panel: join/leave, member list (ID, last heard, best range), drop-file-to-broadcast. Chatter slice in the store. |

**Reuse inventory (nothing forked):** `buildSweep`, `measureSweep`,
`refinePreEmphasis`, `sampleResponseAt` (channelSweep); sentinel + BCH63
machinery (atomicFrame/bch63); the band-card hop and `HandshakeReceiver`
untouched for the file itself; TX/RX engines in `bandHandshake` mode carry
the control frames; `lib/channel` simulator wires protocol instances
together in tests.

## Error handling

Rule: **every non-IDLE state has a deadline that returns it to IDLE.** No
stuck states.

- **Self-hear:** half duplex means the device's own mic hears its own
  speaker. The controller mutes worker RX processing during its own playback
  window (it knows exactly when it is playing); the probe decoder also drops
  its own ID as belt-and-braces.
- **Collisions:** garbled transmissions fail CRC/BCH and read as silence, by
  design. Reply slots re-roll on busy air; the roll call is the source of
  truth at send time, so a lost `WELCOME` costs nothing permanent.
- **False sweep detections** (music, environmental noise): the protocol
  reacts only when the sweep correlator threshold passes AND the pulse-ID
  CRC validates.
- **Roll call with zero reports:** abort the send, surface "nobody home".
- **Empty band intersection:** worst-case floor profile (QPSK, minimum
  tones) rather than failure.
- **Mid-file failure:** existing RX failure handling applies; receivers time
  out back to IDLE using the expected duration from `FILE_COMING`.

## Testing

- **Unit:** probe-burst roundtrip under additive noise; pulse-ID CRC
  rejection; control-frame encode/decode + corruption sweeps;
  `settingsPick` intersection cases (disjoint bands, one deaf peer, single
  peer, empty).
- **Protocol:** 2–3 `roomProtocol` instances over a fake channel with a fake
  clock and seeded RNG — join happy path, forced slot collision, roll call,
  zero-response abort, and every timeout path. Fully deterministic, no
  audio.
- **Integration:** channel-simulator loopback in the style of
  `bandHandshake.test.ts` — full join → roll call → file transfer between
  two in-process stacks, with impairments.
- **Bench:** manual two-device acoustic run before merge, per the README
  rule that fragile acoustic paths are verified over the air.

## Design history (decisions and why)

- **Half duplex, turn-taking** over full duplex: no self-echo problem, no
  new DSP risk, existing engines reused as-is. Message layer is
  direction-agnostic so full duplex remains possible later.
- **Room model** over mast/client: user direction. Any member can send;
  protocol is symmetric.
- **Design for N, test at 2–3:** membership, IDs, and backoff exist from
  day one; bench coverage at room scale.
- **Lazy calibration at send time** over calibrate-on-join: sweeps measure
  the listener's side of one specific pair, so join-time calibration is
  either expensive (N reply sweeps) or a guess (one sweep as proxy for all
  speakers). Measuring at roll call is always fresh, always the exact
  direction used, and makes the membership table advisory rather than
  load-bearing. Join-time iterative calibration (an earlier choice in this
  design's evolution) was superseded by this.
- **One-shot sweep** over iterative grid refinement: ~1 dB worse gains,
  seconds instead of minutes, scales to N. The RX engine's own per-tone
  training equalization covers fine-grained receive-side correction during
  the transfer itself.
- **Full report-grid response (64 points × 4 bits = 32 B)** over coarse
  band+rate claims: one message buys real transmit pre-emphasis, worth
  3–4 dB of MER.
- **Pre-send roll call** over heartbeats or blind broadcast: quiet air
  between transfers, dead peers drop out naturally, settings never stale.

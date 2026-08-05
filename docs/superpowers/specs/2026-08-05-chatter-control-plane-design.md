# Chatter control plane — reliability fixes

Date: 2026-08-05
Status: approved, not yet implemented
Scope: the chatter room's control plane only. Text messaging, DMs, and the
mobile UI are a separate spec that depends on this one landing first.

## Why this exists

Three observed failures, all in the control plane the chatter room depends on:

1. A joining device is welcomed only sometimes. Two devices joining within a
   few seconds of each other frequently welcome nobody.
2. Every control message rides 6900-7250 Hz, which is the worst part of a
   phone's speaker and microphone response — while the probe burst that
   announces a join is broadband and reliable. The two halves of the same
   handshake have opposite robustness.
3. Sending a 40-byte file from a phone reported "out of memory" and produced
   no readable log on the device.

Items 1 and 2 are diagnosed from the code. Item 3 is **not** — see
[Open questions](#open-questions).

## Design

### A. WELCOME consistency

Two independent causes.

#### A1. Reply duty is gated on a single state

`roomProtocol.ts:228` gates the entire reply chain on
`this._state === 'idle'`. A probe heard in `listening`, `announcing`,
`joinWait`, `collecting`, `sending`, or `receiving` refreshes the member table
and sends nothing at all.

Consequence: two devices joining within roughly ten seconds of each other are
both in `joinWait` when the other's probe arrives. Each records the other as a
member. Neither replies. The joiner's `joinWait` deadline expires, it declares
an empty room, and the roll call at first send is the earliest either device
can discover the other — which is exactly the inconsistency reported.

**Change.** Replies become an explicit queue rather than a state-gated side
effect.

- `onProbeHeard` always enqueues `{ proberId, purpose, enqueuedAtMs }`,
  deduped by `proberId` (replacing `pendingReplyTo`, which becomes the queue's
  own key set).
- A single drain routine sends from the queue whenever the local transmitter
  is free. Transmitter-free states are `idle` and `joinWait`. `announcing`,
  `listening`, `rollCall`, `collecting`, `sending`, and `receiving` hold the
  queue without discarding it.
- Slot selection, carrier sense, and re-rolling among later slots are
  unchanged (`scheduleReply`'s existing logic) — the queue only changes *when*
  a reply is eligible to start, not how it picks its moment.
- `stop()` clears the queue alongside the timer set.

Replying from `joinWait` is safe: the joiner has finished playing its own probe
before entering that state, so its transmitter is genuinely idle, and the
grace window at `roomProtocol.ts:385` already covers a full control message.

#### A2. WELCOME vs REPORT is inferred, not signalled

`roomProtocol.ts:230` decides which reply to send from
`existing !== undefined` — whether the prober is already a known member. There
is no purpose bit on the air. The comment at `roomProtocol.ts:221` already
documents this as the root cause of two follow-on bugs, both currently patched
around:

- A device rejoining with the same id (page refresh, reconnect, a second
  `start()`) receives a REPORT while sitting in `joinWait`, because peers still
  hold it in `_members`. Worked around at `handleReport`, `roomProtocol.ts:304`.
- A peer whose WELCOME was lost when we joined still considers us a stranger,
  so it answers our roll call with a WELCOME rather than a REPORT. Worked
  around at `handleWelcome`, `roomProtocol.ts:281`.

**Change.** Signal purpose explicitly on the probe burst.

`probeBurst.ts:140` packs 12 pulse-keyed slots as
`(deviceId << 4) | crc4(deviceId)`. Go to 13 slots:

```
V = (deviceId << 5) | (purpose << 4) | crc4over9bits(deviceId, purpose)
purpose: 0 = joining  (reply WELCOME)
         1 = roll call (reply REPORT)
```

Still LSB-first, so slot 0 remains the CRC's least-significant bit. Cost is
one extra 40 ms slot — the burst grows from about 3.7 s to 3.74 s.

`crc4` currently covers 8 bits (`probeBurst.ts:270`). It gains a 9-bit
variant covering deviceId plus the purpose bit, so a flipped purpose bit is
caught rather than silently sending the wrong reply type.

The two workarounds above stay in place. They are correct behaviour on their
own terms (a WELCOME does carry the same measured grid a REPORT does, and a
REPORT is a legitimate member refresh), and keeping them means a peer running
an older build degrades rather than breaks.

`buildProbeBurst`, `decodeProbeId`, and `probeBurstSamplesAfterChirp` all read
`PROBE_LAYOUT.idSlots`, so the slot count change is one constant plus the
packing functions. Both ends must agree; a mismatch fails CRC and the probe is
simply dropped, which is a safe failure mode.

#### A3. Replies are acked

A WELCOME is fire-and-forget today. If it is lost, the joiner never learns the
room is occupied and there is no retry.

**Change.** After transmitting a reply, the replying device keeps the queue
entry in a `sentAwaitingAck` set for one slot window
(`replySlots * replySlotMs`). Hearing anything from that prober — a probe, a
REPORT, or a WELCOME — clears it. Otherwise the entry is re-enqueued once.

Bounded at two attempts total, so a genuinely deaf peer costs about seven
seconds of extra reply traffic rather than an unbounded retry loop.

### B. Handshake band moves low

The handshake band is the single point of failure for every control message.
It currently sits at 6900-7250 Hz, where phone speaker and microphone response
are at their worst, while the probe burst it is paired with sweeps 1500-7800 Hz
and is decoded reliably.

Two documented bench failures constrain the move, and both bite directly:

1. **Pilot-to-tone ratio.** Drift correction extrapolates the pilot's measured
   phase by `toneFreq / pilotFreq` (`types.ts:202`). Any error in that
   measurement is multiplied by the ratio. At 3.9 the band shipped broken:
   roughly 12° of pilot uncertainty crossed QPSK's 45° decision boundary at the
   top tone, two devices detected each other's chirps and never demodulated a
   single control frame in either direction (`types.ts:208-217`). The current
   ratio is 1.15.
2. **The chirp compresses the band next to it.** `OFDM_TUNING.chirpCenterHz`
   is 1850 Hz with a 200 Hz span, so 1750-1950 Hz. It is parked there
   deliberately. The transmit chain compresses per band, and the chirp is the
   loudest thing in a transmission: when the chirp sat at 6200-6400 with tones
   at 6900-7250, the received pilot went from 0.367 during training to 2.67
   during data — a 17 dB swing — and no data frame decoded
   (`types.ts:276-282`).

Naively moving the handshake tones down to 2000 Hz lands them 50 Hz from the
chirp band and reproduces failure 2 exactly. So three values move together.

| | now | proposed |
|---|---|---|
| handshake pilot | 6300 Hz | 2000 Hz |
| handshake tones | 6900-7250 Hz | 2600-2950 Hz |
| handshake chirp centre | 1850 Hz (global) | 4400 Hz (handshake engine only) |
| pilot:tone ratio | 1.15 | 1.48 |
| tone count, modulation | 8, QPSK | 8, QPSK (unchanged) |

`toneStartHz` stays at 600. Lowering `MIN_TONE_START_HZ` (`types.ts:413`) would
buy a tighter ratio of 1.33 by letting the pilot sit closer, but that constant
is global — shared by every `ofdmToneFrequencies` caller, TX and RX alike,
specifically so the clamp can never diverge between the two sides. Changing it
would silently move every chatter-negotiated band as well as the handshake one,
which is a much larger blast radius than this spec wants. 1.48 is well inside
the range where the ratio was documented as harmless (1.15 safe, 3.9
catastrophic), so the tighter number is not worth the coupling.

Supporting changes:

- `chirpCenterHz` becomes a per-engine `OFDMEngine` option, defaulting to
  `OFDM_TUNING.chirpCenterHz`. The engine already takes `chirpSpanHz` this way
  (`ofdmEngine.ts:66`), so this follows the existing shape. `RxEngine` needs
  the matching option — its correlation template must be the same shape or
  nothing syncs (`rxEngine.ts:153`, `:1554`).
- Only the handshake engine passes a non-default centre. The target-band path
  keeps 1850 Hz and its waveform stays byte-identical, so
  `bandHandshake.test.ts`'s byte-identity assertions still hold.

4400 Hz for the handshake chirp: the probe burst's down-chirp already sweeps
through 4400 Hz and is reliable on this hardware, and a 4300-4500 Hz chirp
clears the new tone band by about 1.35 kHz — well over the 500 Hz separation
that failed.

This breaks wire compatibility with any previously deployed build. Both ends
are dev builds, so the only consequence is that both devices must be updated
together.

**This is a hypothesis, not a measured improvement.** It is not to be
described as a fix until measured — see [Verification](#verification).

### C. File transfer memory

The cause of the reported "out of memory" on a 40-byte file is **not
identified**. `TxEngine.transmitFile` on 40 bytes produces a few seconds of
audio; nothing on that path scales badly at this size, so the error originates
somewhere not yet found. Implementation is sequenced so diagnosis comes first.

**C1. Make the failure legible on a phone (do this first).**

The `error` event from `encodeFileAsync` reaches `chatterError` and renders in
room mode, but no log was obtainable on the device. Until a failure on a phone
can be read, nothing else here is verifiable. Concretely: the `error` path
carries the failing command type and the thrown error's name as well as its
message, and room mode's existing `LogShare` is reachable without depending on
the desktop console.

**C2. Reproduce and fix the actual cause.** Blocked on C1 or on the log the
operator captured. No fix is written before the cause is known.

**C3. Memory hardening.** Correct for a phone independent of C2, and not to be
presented as the fix for it:

- `player.ts:55` allocates a full second copy of every waveform, and
  `:90-91` allocates a third inside `createBuffer`. Three copies of every
  transmission are live simultaneously. The volume/normalise pass can write
  into the `AudioBuffer`'s own channel data instead.
- `chatterController.transmitFile` uses the batch `encodeFile` path.
  `TxEngine.streamChunks` and `AudioPlayer.playStream` already exist and bound
  peak memory to one chunk; the chatter file path should use them, as the bench
  path does.
- `chatterController.ts:226` constructs `new AudioPlayer()` with its own
  `AudioContext`, on top of the recorder's. One shared context instead.

## Non-goals

- Text messages and DMs. Separate spec — they ride this same control plane,
  and building them on a plane that drops messages means debugging both at
  once.
- Mobile-responsive UI. Separate spec.
- Per-tone bit loading above QPSK. `settingsPick.ts:186-206` documents why the
  peak-relative probe grid cannot justify it; unchanged here.
- Any change to the target-band file transmission waveform.

## Verification

Section A:

- `roomProtocol.test.ts`: a probe arriving in each non-`idle` state enqueues a
  reply, and that reply is sent once the machine reaches a transmitter-free
  state. Two devices both in `joinWait` end with each having welcomed the
  other.
- `probeBurst.test.ts`: 13-slot round trip for both purpose values across the
  full 1-255 id range; a flipped purpose bit fails CRC.
- `roomProtocol.test.ts`: a lost reply is retried exactly once, then gives up.

Section B:

- `chatterLoopback.test.ts` passes on the new band.
- `bandHandshake.test.ts` byte-identity assertions still pass, proving the
  target-band path is untouched.
- `tuning.test.ts`'s `syncBurstSymbols` invariant still holds.
- **Two-device over-air MER on the new band, compared against the 21-22 dB the
  current band recorded on the weakest hardware measured** (`types.ts:195`).
  If the new band does not clear QPSK's ~10 dB requirement with comparable
  margin, section B is reverted, not tuned in place.

Section C:

- C1 is verified by producing a readable failure on the phone.
- C3 is verified by the existing test suite plus a successful two-device
  transfer; it is not evidence that C2 is resolved.

## Open questions

- **The failing transfer's log has not been provided.** Section C2 cannot be
  written without it, or without C1 producing an equivalent. Everything else in
  this spec is independent of it and can proceed.

## Outcome

Implemented across 22 commits on `chatter-control-plane-fixes`. Every task was
reviewed; a final whole-branch review found one Critical and five Important
issues, all fixed. Gates at merge: `npm run typecheck` clean, `npm run build`
succeeds, `npm run test` 589 passed with the 3 pre-existing `pipeline.test.ts`
BPSK Doppler/stress failures still red, `npm run lint` at its 410-problem
baseline.

Two changes were made to the design as specified:

- **A3's acknowledgement is not implementable as written.** The spec assumed a
  reply could be acked by "any traffic from that prober". Nothing in
  `RoomProtocol` transmits in response to a WELCOME or a REPORT, so the ack
  never clears in the ordinary flow and `MAX_REPLY_ATTEMPTS = 2` means "every
  reply is sent twice, always" rather than "retry on loss". A retry also cannot
  arrive before the joiner's 5800 ms `joinWait` closes, since the first send
  alone ends at ≥3150 ms — though it does still register the peer afterwards.
  Retries for `rollCall`-purpose replies were removed outright (see below);
  whether to keep the WELCOME retry at all is an open decision.

- **`sendFileComingAndTransmit` now carrier-senses.** It was the only transmit
  path in the machine without it. Combined with A3's retry this was a silent
  file-loss bug: `collectExtraMs` was sized so one reply in the last slot
  finishes inside the collect window (4650 ms of 5800 ms), but a retry fires
  1800 ms after the first send completes — outside it. In roughly 6 of 36 slot
  pairs a peer was mid-retry when FILE_COMING went out, with its own RX muted
  by its playback, so it never armed its receiver and the sender transmitted
  the whole file to nobody with `lastError === null`. Busy air now aborts the
  roll call to `idle` with `lastError` set, which is a visible failure rather
  than a silent one.

## Required for the over-the-air measurement

The relocated band is committed and unmeasured. Beyond the MER comparison in
Verification above, the run must check:

1. **Whether the handshake chirp landing inside a negotiated target band causes
   the documented compression swing.** `settingsPick` slides a 1550 Hz window
   across 1500-7800 Hz, so any 32-tone window starting in 2850-4400 Hz contains
   the 4400 Hz chirp — and 2-4 kHz is where phone hardware scores best, which
   is this work's own premise. Checked against the handshake tones during
   implementation, never against the target band. Note the chirp is amplitude
   **0.12**, not the 0.6 of the era when the 17 dB swing was measured, so the
   hazard is real but materially smaller; size the measurement against 0.12.
2. **Whether the handshake sync template false-triggers on a probe burst.**
   4400 Hz is exactly the probe's down-chirp start frequency. The defence is
   direction reversal (the probe sweeps down, the sync chirp up), which still
   holds, but the two now share a centre frequency.
3. **The 2000 Hz pilot's 150 Hz clearance from the global chirp template**
   (1750-1950), which the post-hop target engine correlates against. Partway
   back toward a documented false-trigger mechanism; `gapSymbols` still
   mitigates it and `tuning.test.ts` now guards the clearance.
4. **Whether an 800 ms up-sweep at chirp level is reproduced at 4400 Hz at
   all.** That "works on this hardware" claim is inherited from the probe's
   down-chirp, not measured for this waveform.

## Follow-ups, in rough priority order

1. **Decide the fate of the WELCOME retry** (see Outcome above). It costs
   ~3.15 s of airtime on essentially every join, in a half-duplex room.
2. **`FLOOR_SETTINGS` is still 6900-7050 Hz** (`settingsPick.ts`) — the room's
   last-resort band when no window clears −18 dB. This work established that
   region is the worst part of a phone's response, and removed the comment
   justifying the choice ("the handshake band already proved itself there").
   Nothing regressed, because the fallback is only reached when the transfer
   would fail on any band — but the better fix is probably to drop the
   hardcoded band and use the best-scoring window even below threshold, which
   needs its own measurement.
3. **The streamed chatter file transmits ~2.2-2.8 dB below the old batch
   path.** `play()` normalised every buffer to a 0.95 peak; the streaming path
   cannot, because it never sees the whole waveform. Closing this properly
   wants `TxEngine` to expose its deterministic transmission peak — the
   modulator already computes `budget`, `safeScale` and a measured
   `syncBurstPeak`. An SNR shortfall, not a wire mismatch: the receiver trains
   its amplitude reference on the same transmission.
   **Do not simply raise `FILE_STREAM_GAIN`** — the per-chunk clamp in
   `playStream` runs on the raw chunk *before* the gain node, so a gain above
   1.0 clips at the destination silently, with no clamp and no log.
4. **`settingsPick` emits `toneStartHz = 200`, which `ofdmToneFrequencies`
   clamps to `MIN_TONE_START_HZ` = 600.** Both ends clamp identically so
   nothing breaks, but every negotiated band is used 400 Hz above the band that
   was measured and chosen, with the per-tone gains applied to the wrong
   frequencies. Predates this work.
5. **Overlapping retry arms for one prober share a single ack-table key** with
   no per-arm identity check, so two overlapping chains can yield 3 sends
   rather than 2. Bounded and non-spiralling, and largely unreachable now that
   `rollCall` replies arm no retry.
6. **`ControlType.Bye` clears the pending ack, but the room still has no
   dedicated ack frame** — "acknowledged" remains "any traffic from that
   prober", which is what makes follow-up 1 a real question.

## Noticed while writing this, not fixed here

`settingsPick` splits its chosen band as `pilotFreqHz = firstToneHz - 200` and
`toneStartHz = firstToneHz - pilotFreqHz`, so it emits `toneStartHz = 200`
(`settingsPick.ts:177-178`). `ofdmToneFrequencies` clamps that to
`MIN_TONE_START_HZ` = 600 (`types.ts:423`). TX and RX clamp identically, so both
ends still agree and transfers are not broken — but every negotiated band is
actually used 400 Hz above the band `settingsPick` measured and chose, and the
per-tone gains measured for the chosen window are applied to a different set of
frequencies.

Out of scope here: it touches the negotiated band rather than the control
plane, and it wants its own bench measurement. Worth a follow-up.

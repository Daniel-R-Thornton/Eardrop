/**
 * RoomProtocol — the chatter room's state machine.
 *
 * This is the protocol BRAIN, deliberately kept free of audio, workers, and
 * AudioContext: every side effect (playing a probe, sending a control
 * message, checking the air, starting/arming a transfer, scheduling a
 * timer) goes through the injected RoomDeps. That split is what makes the
 * transitions below unit-testable with a manual clock (see
 * roomProtocol.test.ts) instead of only observable over real audio.
 *
 * State chart:
 *
 *   cold --start()--> listening --(quiet)--> announcing --> joinWait --> idle
 *     ^                   |                                              |  ^
 *     |            (busy, re-check                                      |  |
 *     |             up to listenCapMs,                        queued onProbeHeard
 *     |             then force through)                     reply (see below)
 *     |                                                                  |
 *     +-------------------------- stop() -------------------------------+
 *
 *   idle --sendFile()--> listening --(quiet)--> rollCall --> collecting
 *          (no band remembered for this peer — see BAND_CACHE_TTL_MS;
 *           with one, the probe and the collect window are both skipped:
 *           idle --sendFile()--> listening --(quiet)--> collecting)
 *     ^                                                          |
 *     |                                 reports==0 / air busy  |  reports>0,
 *     +---------------------- lastError set <--------------------+  air quiet
 *     |                                                          |
 *     |                                        FILE_COMING sent, wait
 *     |                                        fileComingLeadMs, startFileTx
 *     |                                                          v
 *     +------------------ durationMs+5000 later <-------------sending
 *
 *   idle/joinWait --onMessage(FILE_COMING)--> receiving --durationMs+5000--> idle
 *
 *   idle/joinWait --onProbeHeard--> (queued reply, slotted + carrier-sensed)
 *
 * Every state reached via a timer carries its OWN deadline back to idle (or
 * cold, for the pre-join chain) so nothing can get stuck; `stop()` cancels
 * every outstanding timer via a single `pendingTimers` set (the outbox's own
 * slot timers are cancelled by `outbox.clear()` alongside it). Most timer
 * callbacks re-check `this.state` before acting (and again after every
 * await) so a stale timer firing after a later transition is a no-op, never
 * a regression to an earlier state. `armReplyAck`'s retry timer is the
 * exception: it isn't state-shaped (a reply can be owed in either 'idle' or
 * 'joinWait'), so it gates on membership in `awaitingAck` instead — cleared
 * by any contact from the prober, and by `stop()`/the cold error path
 * alongside `outbox.clear()` — which is the same "stale timer is a
 * no-op" property, just keyed on the map rather than on `this.state`. Only
 * 'joining'-purpose replies ever arm that timer at all — see armReplyAck for
 * why a roll-call reply must never be retried.
 *
 * `listening` is shared by both carrier-sense phases (join and roll-call) —
 * carrier sense is carrier sense regardless of what comes after it.
 *
 * Replies to probes are QUEUED, not state-gated: `onProbeHeard` records what
 * is owed and the Outbox sends it whenever the local transmitter is free
 * (`canTransmitReply`). Gating the send on a single state meant two devices
 * joining at once were both in `joinWait` when the other's probe arrived and
 * neither ever replied. The queue itself — slot selection, carrier sense,
 * re-roll on busy, hold-don't-drop — now lives in `outbox.ts`, because an ACK
 * and a TEXT want exactly the same collision avoidance a reply does. What
 * stays here is the POLICY: which states may transmit, and which replies earn
 * a retry.
 */
import {
  ControlType,
  packWelcome,
  packReport,
  packFileComing,
  packText,
  packAck,
  parseWelcome,
  parseReport,
  parseFileComing,
  parseText,
  parseAck,
  textByteLength,
  TEXT_MAX_BYTES,
  type ControlMessage,
  type BestRangeClaim,
  type FileComingPayload,
} from '../protocol/controlFrame';
import { pickSettings, type PeerReport, type PickedSettings } from './settingsPick';
import { Outbox, type OutboxEntry } from './outbox';
import { PROBE_PURPOSE, type ProbePurpose } from '../protocol/probeBurst';
import { OFDM_TUNING } from '../types';
import { dlog } from '../../lib/debug/dlog';

export type RoomState =
  | 'cold' | 'listening' | 'announcing' | 'joinWait'
  | 'idle' | 'rollCall' | 'collecting' | 'sending' | 'receiving';

export interface Member {
  deviceId: number;
  lastHeardMs: number;
  claim?: BestRangeClaim;
  /** what THIS device heard of the member's last probe (REPORT_GRID mags) */
  heardGrid?: number[];
  /** what the MEMBER heard of us, carried in their WELCOME — informational v1 */
  theirViewOfUs?: number[];
}

export interface RoomDeps {
  deviceId: number;
  now(): number; // ms, monotonic
  rng(): number; // [0,1)
  schedule(fn: () => void, delayMs: number): () => void; // returns cancel
  /** Play the probe burst; resolves when playback finishes. `purpose` goes on
   *  the air so listeners know whether to answer WELCOME or REPORT — see
   *  PROBE_PURPOSE. */
  playProbe(purpose: ProbePurpose): Promise<void>;
  /** Encode + play a control message; resolves when playback finishes. */
  sendMessage(msg: ControlMessage): Promise<void>;
  /** Band RMS check — true = someone is talking. */
  isAirBusy(): Promise<boolean>;
  /** Begin the file transmission with negotiated settings. */
  startFileTx(settings: PickedSettings): void;
  /** Arm the receive path (HandshakeReceiver) for an incoming transfer. */
  armFileRx(info: FileComingPayload): void;
  onStateChange?(state: RoomState, members: Member[]): void;
  /** Display-only: a TEXT was delivered to the UI. Never read by a protocol
   *  decision — the ACK is sent regardless of whether this is wired up. */
  onTextReceived?(msg: { msgId: number; senderId: number; targetId: number; text: string }): void;
  /** Display-only: an ACK for a message this device sent came back. Never
   *  read by a protocol decision — the retry/delivery-state tracking that
   *  reacts to an ACK lives in `handleAck` itself, not in the UI. */
  onTextAcked?(msgId: number, byDeviceId: number): void;
  /** Display-only: a sent TEXT's delivery state changed. `ackedBy` is every
   *  device that has acked so far (deduped), meaningful mainly for a
   *  broadcast that may collect more than one. */
  onTextStateChange?(msgId: number, state: 'sending' | 'delivered' | 'failed', ackedBy: number[]): void;
}

// Hoisted above ROOM_TIMING because that object is an `as const` literal and
// cannot reference its own fields during construction — ackWindowMs below
// needs replySlots/replySlotMs, so all three live here and ROOM_TIMING's
// fields are themselves derived from them (never the other way around).

/** JOIN_WAIT and COLLECT both.
 *
 *  300 ms, not the 1 s this shipped with. Slots exist so two peers do not
 *  start talking at the same instant, but listen-before-talk is what
 *  actually prevents the collision — the slot only has to be long enough
 *  that a peer who started in the previous one is visible to the next
 *  device's carrier sense. That check averages the last 250 ms of audio, so
 *  300 ms clears it with margin. A full second bought nothing and cost up to
 *  five seconds of the join, which is most of the time a two-device room
 *  spends waiting. */
const REPLY_SLOTS = 6;
const REPLY_SLOT_MS = 300;

/**
 * Dead time before the first reply slot — see OutboxDeps.turnaroundMs for the
 * failure this exists to stop.
 *
 * 500 ms covers three things that all land in the same window: the peer's own
 * mute tail (MUTE_TAIL_MS, 150 ms after its playback ends), the re-arm that
 * follows it, and the room's reverb decaying enough that an 800 ms sync chirp
 * correlates against the transmission rather than against the tail of the one
 * before it.
 *
 * The cost is 500 ms added to every reply and, because the last slot now opens
 * later, the same 500 ms added to the collect window that has to contain it.
 * That is the trade: half a second per exchange against replies that are
 * transmitted, audibly, and never decoded.
 */
const REPLY_TURNAROUND_MS = 500;

/** Measured air time of a 1-byte control payload: 35 wire bytes over 8 QPSK
 *  tones plus the fixed ~1.5 s preamble. Used below to size the ACK window. */
const ACK_AIR_MS = 2000;

export const ROOM_TIMING = {
  listenMs: 1000, listenCapMs: 10000,
  replySlots: REPLY_SLOTS, replySlotMs: REPLY_SLOT_MS,
  replyTurnaroundMs: REPLY_TURNAROUND_MS,
  // Grace after the last reply slot opens.
  //
  // Must exceed one whole control message, because a peer that draws the
  // final slot only STARTS transmitting then and a WELCOME is roughly 3.15 s
  // of audio. Anything less and the window shuts mid-reply: the roll call
  // reports an empty room while a peer is still audibly answering, and the
  // answer lands just after everyone stopped listening for it.
  //
  // 4500, not 4000: the turnaround pushes every slot back by
  // REPLY_TURNAROUND_MS, so the last one now opens at 500 + 1500 = 2000 ms and
  // a 3.15 s WELCOME finishes at 5150. Growing this by exactly the turnaround
  // keeps the margin that was there before (window 6300, worst reply 5150,
  // ~1.15 s spare for encode and output latency, which is NOT otherwise
  // budgeted anywhere). See replyWindowFits in roomProtocol.test.ts — that
  // arithmetic is asserted rather than left as a comment, because the last
  // time it drifted the symptom was a silently-killed file transfer.
  collectExtraMs: 4500,
  fileComingLeadMs: 700,
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
  ackWindowMs: REPLY_SLOTS * REPLY_SLOT_MS + ACK_AIR_MS,
} as const;

/**
 * How long a state entered immediately before an `await` may sit there before
 * the machine gives up on the dep and routes to its fallback.
 *
 * The class doc promises that every state carries a deadline back to idle (or
 * cold) so nothing can get stuck. That was only true of states reached via a
 * TIMER. A state entered and THEN awaited on — 'rollCall' awaiting playProbe,
 * 'announcing' awaiting playProbe, 'listening' awaiting isAirBusy, 'collecting'
 * awaiting the FILE_COMING send — had no deadline at all, so a dep promise that
 * never settles wedged the room for the rest of the session. Nothing rejects in
 * that case, so `handleDepsError` never runs either.
 *
 * The ways that happens are ordinary, not exotic: `AudioPlayer.play` resolves
 * on the buffer source's `ended` event, which a suspended AudioContext (a
 * backgrounded tab, a locked phone) may never fire, and every worker request
 * (encodeProbe/encodeControl/airCheck) is a bare promise with no timeout, so a
 * dropped reply hangs its caller forever.
 *
 * Wedging in 'rollCall' is worse than a stuck badge: roll-call accumulation
 * requires 'collecting' (see handleReport), so every REPORT the room sends back
 * is discarded on arrival while the prober looks like it is still working.
 *
 * 20 s is far longer than any real dep: the longest is a probe burst at ~3.9 s
 * of audio plus its encode. Anything past that is a fault, not slowness.
 */
export const ROOM_STALL_MS = 20000;

/**
 * How long a negotiated band may be reused for a peer before it is re-derived.
 *
 * A roll call exists to learn which band a peer can hear, and that answer does
 * not change between two sends a minute apart. Re-deriving it costs a probe
 * burst, a reply window, and a 12-chunk REPORT over the fixed control band —
 * the single most failure-prone message the room sends, and the one observed
 * failing on hardware. So the answer is remembered per peer and the whole
 * negotiation is skipped on a repeat send.
 *
 * A TTL rather than trust-forever, because the thing being remembered is a
 * property of the ROOM, not of the peer: a phone that moves from a desk to a
 * hand has a different response, and a stale band fails SILENTLY (we transmit
 * a whole file into a band the receiver can no longer hear) where a fresh
 * negotiation fails loudly. Five minutes is long enough to cover a burst of
 * sends and short enough that a room rearranged between them re-measures.
 *
 * NOT a substitute for a real staleness check. The honest signal is the
 * ordinary probe's own grid: compare what we hear of a peer now against what
 * we heard when the band was picked, and drop the entry when it moves
 * materially. That needs the fine-sweep work to be worth wiring up, so for now
 * the TTL and the rejoin invalidation below carry it.
 */
export const BAND_CACHE_TTL_MS = 5 * 60 * 1000;

/** A band negotiated with one peer, and when. */
interface CachedBand {
  settings: PickedSettings;
  atMs: number;
}

/** A device's real self-knowledge (measured passband/QAM ceiling) arrives in
 *  a later iteration; v1 claims this fixed, sensible default for every WELCOME. */
const DEFAULT_CLAIM: BestRangeClaim = { lowHz: 1500, highHz: 7800, maxQamOrder: 6 };

/** How long a completed send/receive stays "occupied" before falling back to
 *  idle — durationMs is the transfer's own estimate, plus slack for the
 *  last frame's tail and any scheduling jitter. */
const TRANSFER_TAIL_MARGIN_MS = 5000;

/** Total sends per owed WELCOME, including the first (a REPORT is never
 *  retried — see armReplyAck). A lost WELCOME leaves the joiner believing the
 *  room is empty, so one retry is worth roughly two seconds of extra airtime;
 *  more than that just makes a genuinely deaf peer expensive for everyone
 *  else.
 *
 *  Note what this is NOT: a retry-on-loss. Nothing in this class transmits in
 *  response to a WELCOME, so a joiner that heard us perfectly stays silent
 *  and the ack only clears if it happens to send something of its own (a
 *  fresh probe, a roll call, a FILE_COMING, a BYE) inside the window. In the
 *  ordinary two-device flow the second send therefore happens every time. */
const MAX_REPLY_ATTEMPTS = 2;

/** Total sends per text message, including the first — same discipline as
 *  MAX_REPLY_ATTEMPTS. A failed 254-byte message already costs ~21 s of air
 *  across two attempts. */
const MAX_TEXT_ATTEMPTS = 2;

/** Bound on the received-TEXT dedup set (see `seenText`), not an LRU cache.
 *  msgId wraps at 256, so 128 also caps how far back a wrap could collide;
 *  an unbounded set would otherwise grow for the whole session. */
const SEEN_TEXT_MAX = 128;

interface PendingFile {
  fileBytes: number;
  durationMs: number;
  /**
   * Who the transfer is for: 0 broadcasts to the room, any other id addresses
   * one member. The air carries it either way — acoustic transmission has no
   * notion of a private channel — so this only decides who ACTS on it. An
   * addressed send also negotiates against that member alone rather than the
   * worst peer in the room, which is the real benefit: one slow device no
   * longer drags down a transfer that was never meant for it.
   */
  targetId: number;
}

interface PendingAck {
  proberId: number;
  /** Sends already spent on this reply, including the first — read when the
   *  retry deadline fires to decide whether another is still owed. Capped at
   *  MAX_REPLY_ATTEMPTS: once attempts reaches it, the prober is given up on
   *  rather than retried again. */
  attempts: number;
}

/**
 * A TEXT this device has sent, tracked from its first send until it is
 * acked or gives up. Unlike `PendingAck` (which watches for ANY traffic
 * proving a reply landed), a TEXT has an actual ACK frame to wait for, so
 * this only needs the send count and who has acked so far.
 */
interface SentText {
  msgId: number;
  /** 0 = broadcast. */
  targetId: number;
  payload: Uint8Array;
  /** Sends spent, including the first — capped at MAX_TEXT_ATTEMPTS. */
  attempts: number;
  /** Devices that have acked this message so far, deduped, in arrival order. */
  ackedBy: number[];
}

/** The outbox dedup key for a reply owed to `proberId`.
 *
 *  The outbox keys entries on a monotonic id, because a TEXT broadcast is not
 *  keyed by a peer at all. This string restores exactly what the old
 *  prober-keyed map gave for free: at most one reply chain in flight per peer,
 *  so a repeat probe — or a setState that re-drains — cannot start a second. */
const replyKey = (proberId: number): string => `reply:${proberId}`;

/** Recover the msgId from a `text:<msgId>` dedupKey — the inverse of the
 *  literal built in sendText/checkTextAck. `onOutboxSent` only gets the
 *  entry, not the SentText record, and the entry itself carries no msgId
 *  field (a text broadcast has no peer to key on the way a reply does), so
 *  this is the one place that needs to parse it back out. */
const textMsgIdFromDedupKey = (dedupKey: string): number | undefined => {
  if (!dedupKey.startsWith('text:')) return undefined;
  const n = Number(dedupKey.slice('text:'.length));
  return Number.isFinite(n) ? n : undefined;
};

export class RoomProtocol {
  private _state: RoomState = 'cold';
  private readonly _members = new Map<number, Member>();
  private _lastError: string | null = null;

  private readonly pendingTimers = new Set<() => void>();
  /** Bumped on every transition — see guardStall for why a stall guard needs
   *  more than the state name to know it is still the one that armed it. */
  private transitionSeq = 0;
  private listenElapsedMs = 0;
  private pendingSendFile: PendingFile | null = null;
  private activeFileParams: PendingFile | null = null;
  private readonly collectedReports = new Map<number, PeerReport>();
  /** Bands already negotiated, per peer — see BAND_CACHE_TTL_MS. Session
   *  scoped and never persisted: device ids are re-rolled at random on every
   *  join, so an id means nothing across sessions. */
  private readonly bandCache = new Map<number, CachedBand>();
  /**
   * Everything this device owes the air, replies included (see outbox.ts).
   *
   * A queue rather than a state-gated side effect. Reply duty used to exist
   * only in 'idle', so a probe heard in any other state updated the member
   * table and sent nothing — and two devices joining within a few seconds of
   * each other are BOTH in joinWait when the other's probe arrives, so
   * neither ever welcomed and both declared an empty room. Now the reply is
   * recorded when the probe is heard and sent when our own transmitter is
   * next free (see canTransmitReply, which the outbox calls as `canTransmit`).
   */
  private readonly outbox: Outbox;
  /**
   * What each prober last announced — decides WELCOME vs REPORT.
   *
   * Kept here rather than baked into the queued entry because a fresh probe
   * overwrites it: the newest announcement is the true one, so a device that
   * ran a roll call and then refreshed and rejoined gets a WELCOME even if the
   * REPORT it originally earned is still sitting unsent. The reply's `build`
   * closure reads this at send time for the same reason it reads `heardGrid`
   * there — what goes out should reflect the last thing we heard, not the
   * first.
   */
  private readonly replyPurpose = new Map<number, ProbePurpose>();
  /**
   * Replies transmitted but not yet known to have landed, keyed by prober id.
   *
   * "Acknowledged" is deliberately loose: anything at all heard from that
   * prober (a fresh probe, a REPORT, a WELCOME, a FILE_COMING, a BYE) proves
   * the link works in the direction that matters, and the room has no
   * dedicated ack frame. Entries that age out without any of that are
   * re-queued once.
   *
   * None of those is a RESPONSE to the reply, though — this class transmits
   * nothing on receiving a WELCOME or a REPORT — so an entry aging out means
   * "the prober happened to stay quiet", not "the reply was lost". See
   * MAX_REPLY_ATTEMPTS.
   */
  private readonly awaitingAck = new Map<number, PendingAck>();
  /** Next msgId this device will assign to an outgoing TEXT. Wraps at 256 —
   *  see packText's doc comment for why the receiver dedupes on
   *  (senderId, msgId) rather than treating it as globally unique. */
  private nextMsgId = 0;
  /** Recently delivered (senderId:msgId) keys, newest last, bounded so a long
   *  session cannot grow it without limit. msgId wraps at 256, so the bound
   *  also caps how far back a wrap could collide. */
  private readonly seenText: Set<string> = new Set();
  /** TEXTs sent by this device, awaiting ACK or already resolved, keyed by
   *  msgId. Cleared in `stop()` alongside the other retry state. */
  private readonly sentText = new Map<number, SentText>();

  constructor(private readonly deps: RoomDeps) {
    this.outbox = new Outbox({
      now: () => deps.now(),
      rng: () => deps.rng(),
      schedule: (fn, delayMs) => deps.schedule(fn, delayMs),
      isAirBusy: () => deps.isAirBusy(),
      sendMessage: (msg) => deps.sendMessage(msg),
      canTransmit: () => this.canTransmitReply(),
      replySlots: ROOM_TIMING.replySlots,
      replySlotMs: ROOM_TIMING.replySlotMs,
      turnaroundMs: ROOM_TIMING.replyTurnaroundMs,
      onSent: (entry) => this.onOutboxSent(entry),
      onFailed: (entry, err) => {
        // Exhausting every slot is not an error the operator can act on — the
        // air was busy for a whole slot window and the reply is simply given
        // up on. A rejected isAirBusy/sendMessage is: that is an audio fault,
        // and it surfaces in the UI exactly as it did before the extraction.
        if (err !== undefined) this._lastError = err instanceof Error ? err.message : String(err);
        if (entry.kind === 'reply') this.forgetReplyPurpose(entry.targetId);
        // A TEXT that never made it onto the air at all — every slot in the
        // window found the air busy, or sendMessage itself threw — is a
        // DIFFERENT failure than an ACK timeout, and must not be handled by
        // armTextAck: nothing was sent, so no ackWindowMs timer is ever armed
        // for it, and without this branch the SentText record just sits in
        // `sentText` at attempts:0 forever — stuck on 'sending' in the UI for
        // the rest of the session, the exact silent-failure shape this whole
        // task exists to eliminate, just relocated here from the ACK path.
        // No automatic retry: slot exhaustion means the air was demonstrably
        // busy across the WHOLE ~1.8 s carrier-sense window, so an automatic
        // second attempt would add traffic to a room that just proved itself
        // congested — same reasoning as broadcast-retries-only-on-zero-acks,
        // just applied before the first send rather than after it. Report
        // 'failed' and let the operator resend deliberately.
        if (entry.kind === 'text') this.failSentText(entry.dedupKey);
      },
    });
  }

  get state(): RoomState {
    return this._state;
  }

  get members(): Map<number, Member> {
    return this._members;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  /** join the room (from cold) */
  start(): void {
    if (this._state !== 'cold') return;
    this.listenElapsedMs = 0;
    this.beginListening('join');
  }

  /** leave: cancels timers, best-effort BYE, back to cold */
  stop(): void {
    for (const cancel of this.pendingTimers) cancel();
    this.pendingTimers.clear();

    if (this._state !== 'cold') {
      this.deps
        .sendMessage({ type: ControlType.Bye, senderId: this.deps.deviceId, targetId: 0, payload: new Uint8Array(0) })
        .catch(() => {});
    }

    this.pendingSendFile = null;
    this.activeFileParams = null;
    this.collectedReports.clear();
    this.outbox.clear();
    this.replyPurpose.clear();
    this.awaitingAck.clear();
    this.seenText.clear();
    this.sentText.clear();
    this.bandCache.clear();
    this.setState('cold');
  }

  /** user dropped a file; size+duration go into FILE_COMING */
  /** `targetId` 0 broadcasts to the room; anything else addresses one member. */
  sendFile(fileBytes: number, durationMs: number, targetId = 0): void {
    if (this._state !== 'idle') {
      this.pendingSendFile = { fileBytes, durationMs, targetId };
      return;
    }
    this.beginSend({ fileBytes, durationMs, targetId });
  }

  /**
   * Start a send: reuse the band we already negotiated with this peer if we
   * have a fresh one, otherwise roll call for it.
   *
   * Broadcasts never reuse. The right settings for a broadcast are the room's
   * collective worst case, and a member who joined since the last send has
   * never been measured at all — so there is no single peer whose answer could
   * stand in for the room's.
   */
  private beginSend(fileParams: PendingFile): void {
    const cached = fileParams.targetId !== 0 ? this.freshBandFor(fileParams.targetId) : undefined;
    if (!cached) {
      this.beginRollCall(fileParams);
      return;
    }
    dlog('ROOM', {
      bandReused: true, peer: fileParams.targetId, us: this.deps.deviceId,
      ageMs: Math.round(this.deps.now() - (this.bandCache.get(fileParams.targetId)?.atMs ?? 0)),
    }, { level: 'warn' });
    this._lastError = null;
    this.collectedReports.clear();
    this.activeFileParams = fileParams;
    this.listenElapsedMs = 0;
    // Carrier sense still runs. Skipping the NEGOTIATION must not skip
    // listen-before-talk: FILE_COMING is what arms every receiver, so a peer
    // transmitting over it leaves us broadcasting a whole file to a room that
    // never armed (see sendFileComingAndTransmit).
    this.beginListening('cachedSend');
  }

  /** The band remembered for `peerId`, if it has not aged out. */
  private freshBandFor(peerId: number): PickedSettings | undefined {
    const entry = this.bandCache.get(peerId);
    if (!entry) return undefined;
    if (this.deps.now() - entry.atMs > BAND_CACHE_TTL_MS) {
      this.bandCache.delete(peerId);
      return undefined;
    }
    return entry.settings;
  }

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
    // Recorded before the first send so armTextAck (fired from the outbox's
    // onSent) has somewhere to write attempts, and so a retry rebuilds from
    // the same payload rather than needing the original string kept alive.
    this.sentText.set(msgId, {
      msgId, targetId, payload, attempts: 0, ackedBy: [],
    });
    this.outbox.enqueue({
      kind: 'text',
      targetId,
      dedupKey: `text:${msgId}`,
      build: () => ({
        type: ControlType.Text, senderId: this.deps.deviceId, targetId, payload,
      }),
    });
    this.outbox.drain();
    this.deps.onTextStateChange?.(msgId, 'sending', []);
    return msgId;
  }

  /** worker heard a probe: id + measured grid + what it announced */
  onProbeHeard(deviceId: number, grid: number[], purpose: ProbePurpose = PROBE_PURPOSE.joining): void {
    const existing = this._members.get(deviceId);
    this._members.set(deviceId, { ...existing, deviceId, lastHeardMs: this.deps.now(), heardGrid: grid });
    // Any traffic from this prober proves the direction that matters — see
    // awaitingAck's doc comment — so a fresh probe clears a pending retry
    // just as a REPORT or WELCOME does.
    this.awaitingAck.delete(deviceId);

    // Reply type comes off the wire (see PROBE_PURPOSE), not from whether we
    // already know this prober. That inference was one-sided in both
    // directions: a device rejoining with the same id (page refresh,
    // reconnect, a second start()) is a stranger to itself but a known member
    // to us, so it received a REPORT when it needed a WELCOME; and a peer
    // whose WELCOME we lost still thinks we are a stranger, so it answered our
    // roll call with a WELCOME. handleWelcome and handleReport keep their
    // tolerance for the "wrong" reply type regardless, so a peer running an
    // older build degrades rather than breaks.
    //
    // A fresh probe overwrites a queued entry's purpose: the newest
    // announcement is the true one. Recorded outside the queue entry so it can
    // still change after the reply is enqueued (see replyPurpose) — the entry
    // itself is deduped on `reply:<id>`, so a repeat probe adds nothing and
    // must not restart a chain that is already in flight.
    // A 'joining' probe from an id we already hold a band for is a NEW session
    // behind a recycled number: ids are re-rolled at random (1-255) on every
    // join, so this may not even be the same device, and its old band means
    // nothing. Reusing it would transmit a file into a band nobody picked.
    if (purpose === PROBE_PURPOSE.joining && this.bandCache.delete(deviceId)) {
      dlog('ROOM', { bandForgotten: 'rejoin', peer: deviceId, us: this.deps.deviceId }, { level: 'warn' });
    }

    this.replyPurpose.set(deviceId, purpose);
    this.outbox.enqueue({
      kind: 'reply',
      targetId: deviceId,
      dedupKey: replyKey(deviceId),
      build: () => this.buildReply(deviceId),
    });

    this.outbox.drain();
  }

  /** worker decoded a control message */
  onMessage(msg: ControlMessage): void {
    switch (msg.type) {
      case ControlType.Welcome:
        this.handleWelcome(msg);
        break;
      case ControlType.Report:
        this.handleReport(msg);
        break;
      case ControlType.FileComing:
        this.handleFileComing(msg);
        break;
      case ControlType.Text:
        this.handleText(msg);
        break;
      case ControlType.Ack:
        this.handleAck(msg);
        break;
      case ControlType.Bye:
        // Member aging is the UI's problem — protocol never evicts.
        //
        // It IS traffic from that sender, though, so it clears any reply we
        // were still waiting to see acknowledged (see awaitingAck): a peer
        // that heard our WELCOME and then left must not still earn a ~3 s
        // retransmission aimed at a device that has announced it is gone.
        this.awaitingAck.delete(msg.senderId);
        break;
    }
  }

  // ---- WELCOME / REPORT / FILE_COMING handlers ----

  private handleWelcome(msg: ControlMessage): void {
    if (msg.targetId !== this.deps.deviceId) {
      // Not silent: a reply addressed to the wrong id looks identical to no
      // reply at all, and the two have completely different causes (a
      // mis-decoded probe ID vs nothing being heard).
      dlog('ROOM', {
        droppedWelcome: true, from: msg.senderId, to: msg.targetId, us: this.deps.deviceId,
      }, { level: 'warn' });
      return;
    }
    const parsed = parseWelcome(msg.payload);
    if (!parsed) return;
    const existing = this._members.get(msg.senderId);
    this._members.set(msg.senderId, {
      ...existing,
      deviceId: msg.senderId,
      lastHeardMs: this.deps.now(),
      claim: parsed.claim,
      theirViewOfUs: parsed.grid,
    });
    // A WELCOME is traffic from the sender — it proves any reply we owed them
    // landed, whatever that reply was.
    this.awaitingAck.delete(msg.senderId);

    // A WELCOME arriving during a roll call counts as a report. Reply type is
    // decided by the purpose bit on the wire (see onProbeHeard / PROBE_PURPOSE),
    // not by whether the replier already knows us — but a peer on an older
    // build may still be running the inference this replaced, or may simply
    // have lost our probe's purpose bit, and answer our roll call with a
    // WELCOME rather than a REPORT. Ignoring it fails the roll call with
    // "nobody home" while a peer is audibly replying — observed on hardware.
    // The payload carries the same measured grid a REPORT does, so there is
    // no reason to discard it.
    if (this._state === 'collecting') {
      this.collectedReports.set(msg.senderId, { deviceId: msg.senderId, grid: parsed.grid });
    }
  }

  private handleReport(msg: ControlMessage): void {
    if (msg.targetId !== this.deps.deviceId) {
      dlog('ROOM', {
        droppedReport: true, from: msg.senderId, to: msg.targetId, us: this.deps.deviceId,
      }, { level: 'warn' });
      return;
    }
    const grid = parseReport(msg.payload);
    if (!grid) return;

    // A REPORT is also a member refresh, independent of roll-call state. A
    // rejoining device (page refresh, reconnect, a second start()) announces
    // 'joining' and gets a WELCOME even though we still hold it in _members
    // from before — but a peer on an older build, or one running the
    // membership-based inference this replaced, may still answer with a
    // REPORT while the rejoiner sits in joinWait. Drop that silently and the
    // rejoiner finishes joining knowing nothing about this peer — so always
    // upsert the sender here, mirroring what handleWelcome refreshes.
    const existing = this._members.get(msg.senderId);
    this._members.set(msg.senderId, {
      ...existing,
      deviceId: msg.senderId,
      lastHeardMs: this.deps.now(),
      theirViewOfUs: grid,
    });
    // Same reasoning as handleWelcome: a REPORT is traffic from the sender,
    // so any reply we owed them is acknowledged.
    this.awaitingAck.delete(msg.senderId);

    // Roll-call accumulation (feeds pickSettings) only happens while actively
    // collecting — a REPORT arriving outside that window is member-refresh
    // only, never counted toward the roll call.
    //
    // Logged rather than dropped in silence: "the peer never answered" and
    // "the peer answered while we were in the wrong state" produce the same
    // `no reports received — nobody home`, and they have completely different
    // causes. A REPORT landing in 'rollCall' means our own probe playback had
    // not resolved yet (see ROOM_STALL_MS); one landing in 'idle' means it
    // arrived after the collect window shut.
    if (this._state !== 'collecting') {
      dlog('ROOM', {
        reportOutsideCollect: true, from: msg.senderId, state: this._state, us: this.deps.deviceId,
      }, { level: 'warn' });
      return;
    }
    this.collectedReports.set(msg.senderId, { deviceId: msg.senderId, grid });
    dlog('ROOM', {
      reportCollected: true, from: msg.senderId, total: this.collectedReports.size, us: this.deps.deviceId,
    }, { level: 'warn' });
  }

  private handleFileComing(msg: ControlMessage): void {
    // Ack-clearing FIRST, ahead of both guards below: a FILE_COMING is traffic
    // from that sender whether or not we are in a state that can act on it and
    // whether or not it is addressed to us (see awaitingAck). Deferring it
    // past the guards is what let a receiver hold a pending ack across an
    // entire transfer — the retry timer would then fire the moment the
    // transfer's own deadline dropped us back to idle, long after the reply
    // could still matter.
    this.awaitingAck.delete(msg.senderId);
    if (this._state !== 'idle' && this._state !== 'joinWait') return;
    // Addressed transfers: everyone in earshot demodulates this announcement,
    // but only the addressee acts on it. Without the check every device would
    // arm its receiver and sit in 'receiving' for the whole transfer, deaf to
    // the room and unable to answer anything, for a file it will never
    // assemble. 0 is the broadcast address.
    if (msg.targetId !== 0 && msg.targetId !== this.deps.deviceId) {
      dlog('ROOM', {
        fileComingForOther: true, from: msg.senderId, to: msg.targetId, us: this.deps.deviceId,
      }, { level: 'info' });
      return;
    }
    const parsed = parseFileComing(msg.payload);
    if (!parsed) return;
    this.deps.armFileRx(parsed);
    this.setState('receiving');
    this.timer(parsed.durationMs + TRANSFER_TAIL_MARGIN_MS, () => {
      if (this._state !== 'receiving') return;
      this.finishToIdle();
    });
  }

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

    const rec = this.sentText.get(parsed.msgId);
    if (!rec) return; // not one of ours, or already cleared by stop()
    // A repeat ACK from a device already recorded is not news — the sender
    // side already reported this ack; re-reporting would just replay the
    // same delivered state with the same ackedBy list.
    if (rec.ackedBy.includes(msg.senderId)) return;
    rec.ackedBy.push(msg.senderId);
    // Any ack at all makes this message delivered, DM or broadcast — the
    // retry timer (see checkTextAck) is what still decides whether a
    // broadcast needed MORE than one before it stops chasing.
    this.deps.onTextStateChange?.(rec.msgId, 'delivered', [...rec.ackedBy]);
  }

  /** Record a delivered (senderId:msgId) key, evicting the oldest insertion
   *  once the bound is exceeded. Not an LRU: re-adding an existing key does
   *  not refresh its position — the goal is bounding memory and the msgId-wrap
   *  collision window, not tracking recency. */
  private rememberText(key: string): void {
    this.seenText.add(key);
    if (this.seenText.size > SEEN_TEXT_MAX) {
      const oldest = this.seenText.values().next().value as string | undefined;
      if (oldest !== undefined) this.seenText.delete(oldest);
    }
  }

  // ---- join / roll-call carrier-sense (shared 'listening' state) ----

  private beginListening(purpose: 'join' | 'rollCall' | 'cachedSend'): void {
    this.setState('listening');
    this.guardStall('listening', purpose === 'join' ? 'cold' : 'idle', 'air check');
    this.timer(ROOM_TIMING.listenMs, async () => {
      if (this._state !== 'listening') return;
      try {
        const busy = await this.deps.isAirBusy();
        if (this._state !== 'listening') return;

        this.listenElapsedMs += ROOM_TIMING.listenMs;
        if (busy && this.listenElapsedMs < ROOM_TIMING.listenCapMs) {
          this.beginListening(purpose);
          return;
        }
        if (purpose === 'join') await this.beginAnnounceJoin();
        else if (purpose === 'cachedSend') await this.announceRememberedBand();
        else await this.beginAnnounceRollCall();
      } catch (err) {
        // A rejected dep (playProbe/isAirBusy/sendMessage) must not stall the
        // machine mid-chain: route to this purpose's existing deadline
        // destination — cold for the pre-join chain, idle for a roll call.
        this.handleDepsError(err, purpose === 'join' ? 'cold' : 'idle');
      }
    });
  }

  private async beginAnnounceJoin(): Promise<void> {
    this.setState('announcing');
    this.guardStall('announcing', 'cold', 'probe playback (join)');
    await this.deps.playProbe(PROBE_PURPOSE.joining);
    if (this._state !== 'announcing') return; // stale guard (e.g. stop() mid-await)

    this.setState('joinWait');
    // Same grace the collect window gets, and for the same reason: a peer that
    // draws the final reply slot only STARTS transmitting at the end of the
    // slot window, and a WELCOME is around three seconds of audio. Without it
    // the joiner declares an empty room while a welcome is still in the air.
    this.timer(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs, () => {
      if (this._state !== 'joinWait') return;
      this.finishToIdle();
    });
  }

  private async beginAnnounceRollCall(): Promise<void> {
    this.setState('rollCall');
    this.guardStall('rollCall', 'idle', 'probe playback (roll call)');
    await this.deps.playProbe(PROBE_PURPOSE.rollCall);
    if (this._state !== 'rollCall') return;

    this.setState('collecting');
    this.timer(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs, () => {
      if (this._state !== 'collecting') return;
      this.finishRollCall();
    });
  }

  /**
   * Announce a file on a band we negotiated earlier, with no probe and no
   * collect window.
   *
   * Enters 'collecting' because that is precisely the state
   * `sendFileComingAndTransmit` runs in on the normal path — by the time
   * finishRollCall calls it the collect window has already expired, so
   * 'collecting' there means "negotiation done, announcement pending", which
   * is exactly where we are. Sharing the state keeps one set of stale guards
   * and one stall guard rather than a parallel pair that could drift.
   */
  private async announceRememberedBand(): Promise<void> {
    const target = this.activeFileParams?.targetId ?? 0;
    const settings = this.freshBandFor(target);
    if (!settings) {
      // Aged out between beginSend and here (a busy air check can burn
      // listenCapMs). Fall back to deriving it properly rather than
      // transmitting on a band we just decided we no longer trust.
      if (this.activeFileParams) this.beginRollCall(this.activeFileParams);
      return;
    }
    this.setState('collecting');
    await this.sendFileComingAndTransmit(settings);
  }

  private beginRollCall(fileParams: PendingFile): void {
    this._lastError = null;
    this.collectedReports.clear();
    this.activeFileParams = fileParams;
    this.listenElapsedMs = 0;
    this.beginListening('rollCall');
  }

  private finishRollCall(): void {
    const target = this.activeFileParams?.targetId ?? 0;
    // An addressed transfer negotiates against its addressee alone. Including
    // everyone else's reports would pick settings for the worst device in the
    // room, throttling a transfer that device is not even receiving.
    const all = Array.from(this.collectedReports.values());
    const reports = target === 0 ? all : all.filter((r) => r.deviceId === target);
    dlog('ROOM', {
      rollCallDone: true,
      target: target === 0 ? 'broadcast' : target,
      reports: reports.length,
      from: reports.map((r) => r.deviceId).join(',') || 'none',
      knownMembers: Array.from(this._members.keys()).join(',') || 'none',
      us: this.deps.deviceId,
    }, { level: 'warn' });
    if (reports.length === 0) {
      this._lastError = target === 0
        ? 'roll call: no reports received — nobody home'
        : `roll call: no reply from ${target.toString(16).padStart(2, '0')} — not reachable`;
      this.activeFileParams = null;
      this.finishToIdle();
      return;
    }
    const settings = pickSettings(reports);
    // Remember it, so the next send to this peer needs none of this. Only for
    // an addressed transfer: a broadcast's settings are the room's collective
    // answer and belong to no single peer (see beginSend).
    if (target !== 0 && !settings.floor) {
      this.bandCache.set(target, { settings, atMs: this.deps.now() });
    }
    void this.sendFileComingAndTransmit(settings);
  }

  private async sendFileComingAndTransmit(settings: PickedSettings): Promise<void> {
    const fileParams = this.activeFileParams;
    if (!fileParams) return; // stop() cleared it mid-flight

    // The collect window's own deadline has already fired by the time this
    // runs (finishRollCall is what called us), so from here to the
    // fileComingLeadMs timer 'collecting' is deadline-free and the two awaits
    // below are the room's last unguarded ones.
    this.guardStall('collecting', 'idle', 'FILE_COMING send');
    try {
      // Carrier-sense before the announcement — the same deps.isAirBusy()
      // idiom every reply uses (see outbox.ts). This was the only transmit
      // path in the machine without it, and it is the path that can least
      // afford a collision: FILE_COMING is what arms every receiver, so a peer
      // still transmitting over it hears nothing, arms nothing, and stays out
      // of bandHandshake mode while we broadcast an entire file to a room that
      // never listened — and its burst corrupts the announcement for every
      // other member too. `lastError` stayed null throughout, so the send read
      // as successful.
      //
      // Busy air ABORTS the roll call rather than waiting. A bounded wait
      // would need a fresh deadline inside a window that has already expired
      // (collectExtraMs is spent by the time finishRollCall runs) and would
      // leave the collected reports aging while it ran; a retry chain is the
      // very mechanism that produced this collision (see armReplyAck). An
      // abort with lastError set is a failure the operator can see and act on
      // — "the channel was busy, send it again" — which is the whole point.
      if (await this.deps.isAirBusy()) {
        this._lastError = 'file send aborted: channel busy when FILE_COMING was due';
        this.activeFileParams = null;
        this.finishToIdle();
        return;
      }
      if (this._state !== 'collecting') return; // stale guard (e.g. stop() mid-await)

      await this.deps.sendMessage({
        type: ControlType.FileComing,
        senderId: this.deps.deviceId,
        targetId: fileParams.targetId,
        payload: packFileComing({
          pilotFreqHz: settings.pilotFreqHz,
          toneStartHz: settings.toneStartHz,
          toneCount: settings.toneCount,
          settleSymbols: OFDM_TUNING.trainingSettleSymbols,
          fileBytes: fileParams.fileBytes,
          durationMs: fileParams.durationMs,
        }),
      });
      if (this._state !== 'collecting') return; // stale guard (e.g. stop() mid-await)

      this.timer(ROOM_TIMING.fileComingLeadMs, () => {
        if (this._state !== 'collecting') return;
        this.deps.startFileTx(settings);
        this.setState('sending');
        this.timer(fileParams.durationMs + TRANSFER_TAIL_MARGIN_MS, () => {
          if (this._state !== 'sending') return;
          this.activeFileParams = null;
          this.finishToIdle();
        });
      });
    } catch (err) {
      // isAirBusy/sendMessage rejected (e.g. audio glitch mid-broadcast, or the
      // air check itself failing now that this path carrier-senses first) —
      // this is a roll call in progress, so the existing zero-report deadline
      // destination (idle) is the right fallback, not a stuck 'collecting'.
      this.handleDepsError(err, 'idle');
    }
  }

  // ---- reply-to-probe policy: WHAT is owed, and whether it earns a retry.
  //      WHEN it goes out — slot, carrier sense, re-roll, hold — is outbox.ts.

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
   * 'announcing'/'rollCall'/'sending'/'receiving': in those two we are
   * measuring the air or counting replies, and our own burst would corrupt
   * the measurement. 'announcing' and 'rollCall' are excluded because our own
   * probe is playing; 'sending'/'receiving' because a file transfer owns the
   * transmitter. 'cold' is excluded because there is no room to reply into.
   */
  private canTransmitReply(): boolean {
    return this._state === 'idle' || this._state === 'joinWait';
  }

  /**
   * The reply message itself, built at SEND time by the outbox.
   *
   * Both the purpose and the measured grid are read here rather than captured
   * when the probe was heard: a reply can sit queued for seconds (held through
   * a transfer, re-rolled past a busy slot), and what finally goes out should
   * carry the freshest thing we know about that peer.
   */
  private buildReply(proberId: number): ControlMessage {
    // The `??` is unreachable in practice: forgetReplyPurpose only drops a
    // peer's purpose once nothing is queued or awaiting ack for it, so an entry
    // being built always has one. Defaulting to a WELCOME rather than a REPORT
    // is still the right way to be wrong — a lost WELCOME leaves a joiner
    // believing the room is empty, whereas a REPORT costs one negotiation.
    const purpose = this.replyPurpose.get(proberId) ?? PROBE_PURPOSE.joining;
    const heardGrid = this._members.get(proberId)?.heardGrid ?? [];
    return purpose === PROBE_PURPOSE.rollCall
      ? {
          type: ControlType.Report,
          senderId: this.deps.deviceId,
          targetId: proberId,
          payload: packReport(heardGrid),
        }
      : {
          type: ControlType.Welcome,
          senderId: this.deps.deviceId,
          targetId: proberId,
          payload: packWelcome({ claim: DEFAULT_CLAIM, grid: heardGrid }),
        };
  }

  /**
   * Drop a peer's recorded reply purpose once nothing is owed to it.
   *
   * The purpose describes an owed reply, so it must not outlive the entry it
   * describes — otherwise it accumulates one stale entry per peer ever heard and
   * buildReply's fallback becomes load-bearing instead of belt-and-braces. Both
   * conditions have to be checked: a reply may be queued again (a fresh probe
   * arriving while a retry was pending) or still awaiting ack, and either one
   * still needs the purpose.
   */
  private forgetReplyPurpose(proberId: number): void {
    if (this.outbox.has(replyKey(proberId))) return;
    if (this.awaitingAck.has(proberId)) return;
    this.replyPurpose.delete(proberId);
  }

  /** A queued transmission made it onto the air. The outbox is done with it;
   *  everything from here is this room's own policy. */
  private onOutboxSent(entry: OutboxEntry): void {
    // A reply is one kind: WELCOME-vs-REPORT is not recorded on the entry at
    // all, because a fresh probe can change it after the entry is queued, so
    // armReplyAck reads replyPurpose for the truth.
    if (entry.kind === 'reply') {
      this.armReplyAck(entry.targetId, entry.attempts);
      this.forgetReplyPurpose(entry.targetId);
      return;
    }
    // An ACK is fire-and-forget — the room has no ack-for-an-ack, so nothing
    // here tracks its delivery.
    if (entry.kind === 'text') this.armTextAck(entry);
  }

  /**
   * Watch for traffic from `proberId`; re-queue the reply once if none arrives
   * within a slot window. Only 'joining'-purpose replies (WELCOMEs) are ever
   * watched — see below.
   *
   * Note this is not a retry-on-loss: nothing here transmits in response to a
   * WELCOME, so a prober that heard us perfectly is silent and the second send
   * happens anyway. See MAX_REPLY_ATTEMPTS and awaitingAck.
   *
   * `attemptsSpent` comes off the outbox entry the send belonged to, so a
   * re-queued retry carries its predecessor's count and the cap still bites.
   */
  private armReplyAck(proberId: number, attemptsSpent: number): void {
    // NEVER retry a roll-call reply. This is structural, not a tuning choice.
    //
    // ROOM_TIMING.collectExtraMs (4000) is sized so that one reply drawing the
    // LAST slot still finishes INSIDE the prober's collect window: the last
    // slot opens at 1500 ms, a control message is ~3.15 s of audio, worst case
    // ends at 4650 ms inside a 5800 ms window. A retry fires one slot window
    // (1800 ms) after the FIRST SEND COMPLETED — roughly s + 4950 + r ms for
    // slot offsets s and r — which is structurally outside that window.
    // Whenever s + r < 850 ms (6 of 36 equally likely slot pairs) the retry is
    // still in the air when the prober's collect deadline expires and it
    // announces FILE_COMING: our RX is muted for our own playback, so we never
    // demodulate the announcement, never arm the receiver, and the sender
    // broadcasts the whole file to nobody — while our burst also corrupts that
    // announcement for every other member.
    //
    // A lost REPORT costs this peer inclusion in ONE negotiation, not its
    // membership, and the prober is about to seize the channel anyway. So the
    // retry has nothing to win there and an entire transfer to lose. A lost
    // WELCOME is the opposite: it leaves the joiner believing the room is
    // empty, with nothing about to reveal otherwise.
    if (this.replyPurpose.get(proberId) === PROBE_PURPOSE.rollCall) return;

    if (attemptsSpent >= MAX_REPLY_ATTEMPTS) return;

    const retry: PendingAck = { proberId, attempts: attemptsSpent };
    this.awaitingAck.set(proberId, retry);
    this.timer(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs, () => {
      const pending = this.awaitingAck.get(proberId);
      if (!pending) {
        // Acknowledged — nothing more is owed, so the purpose can go too
        // (unless a fresh probe queued a new reply, which forgetReplyPurpose
        // checks for).
        this.forgetReplyPurpose(proberId);
        return;
      }
      this.awaitingAck.delete(proberId);
      // A newer probe already queued a fresh reply; that one supersedes this
      // retry (and carries the newer purpose).
      if (this.outbox.has(replyKey(proberId))) return;
      this.outbox.enqueue({
        kind: 'reply',
        targetId: proberId,
        dedupKey: replyKey(proberId),
        build: () => this.buildReply(proberId),
        attempts: pending.attempts,
      });
      this.outbox.drain();
    });
  }

  // ---- TEXT retry policy: same "one retry, then give up" discipline as a
  //      reply, but keyed on a real ACK frame rather than any-traffic-at-all,
  //      and with a broadcast rule a DM doesn't need — see checkTextAck.

  /**
   * A TEXT never made it onto the air at all — the outbox exhausted every
   * slot with the air busy, or `sendMessage` itself threw. Unlike a
   * checkTextAck failure (which follows an ACK window that only exists
   * because a send DID go out), nothing here armed any timer, so nothing
   * would otherwise ever resolve this record — it would sit in `sentText`
   * at attempts:0, reported 'sending' forever. Report 'failed' and remove
   * the record now rather than leaving a message the operator believes is
   * still in flight.
   *
   * No retry: slot exhaustion means the air was busy across the WHOLE
   * ~1.8 s carrier-sense window, not just one check, so the room has just
   * demonstrated it is congested. Spending more airtime on a second attempt
   * would punish everyone in a half-duplex room the same way an unconditional
   * broadcast retry would — see checkTextAck's broadcast rule for the same
   * reasoning applied one step earlier.
   */
  private failSentText(dedupKey: string): void {
    const msgId = textMsgIdFromDedupKey(dedupKey);
    if (msgId === undefined) return; // not a dedupKey this class produced
    const rec = this.sentText.get(msgId);
    if (!rec) return; // stop() cleared it already
    this.sentText.delete(msgId);
    this.deps.onTextStateChange?.(msgId, 'failed', [...rec.ackedBy]);
  }

  /** Arm the ACK-window timer for a TEXT that just went out. */
  private armTextAck(entry: OutboxEntry): void {
    const msgId = textMsgIdFromDedupKey(entry.dedupKey);
    if (msgId === undefined) return; // not a dedupKey this class produced
    const rec = this.sentText.get(msgId);
    if (!rec) return; // stop() cleared it mid-flight
    rec.attempts = entry.attempts;
    this.timer(ROOM_TIMING.ackWindowMs, () => this.checkTextAck(msgId));
  }

  /**
   * The ACK window for one send expired. Retry, or give up, per the rule the
   * brief exists to enforce:
   *
   * - DM: retry unless the addressee specifically acked.
   * - Broadcast: retry only if NOBODY acked. Retrying because one of several
   *   peers missed it would spend seconds of air punishing the ones that
   *   heard it — in a half-duplex room, one device talking blocks everyone,
   *   including the peers who already have the message.
   *
   * Either way, bounded by MAX_TEXT_ATTEMPTS, matching MAX_REPLY_ATTEMPTS's
   * discipline for the same reason: a genuinely deaf peer must not make this
   * device transmit forever.
   */
  private checkTextAck(msgId: number): void {
    const rec = this.sentText.get(msgId);
    if (!rec) return; // resolved or cleared already

    const acked = rec.targetId === 0 ? rec.ackedBy.length > 0 : rec.ackedBy.includes(rec.targetId);
    if (acked) return; // handleAck already reported 'delivered'

    if (rec.attempts >= MAX_TEXT_ATTEMPTS) {
      this.deps.onTextStateChange?.(msgId, 'failed', [...rec.ackedBy]);
      return;
    }

    const { targetId, payload } = rec;
    this.outbox.enqueue({
      kind: 'text',
      targetId,
      dedupKey: `text:${msgId}`,
      build: () => ({
        type: ControlType.Text, senderId: this.deps.deviceId, targetId, payload,
      }),
      attempts: rec.attempts,
    });
    this.outbox.drain();
  }

  // ---- shared plumbing ----

  private finishToIdle(): void {
    this.setState('idle');
    if (this.pendingSendFile) {
      const queued = this.pendingSendFile;
      this.pendingSendFile = null;
      this.beginSend(queued);
    }
  }

  /** A rejected dep promise (playProbe/sendMessage/isAirBusy) must not stall
   *  the machine mid-chain — route it through the same deadline destination
   *  its state would have used on success, recording why for the UI. */
  private handleDepsError(err: unknown, fallback: 'idle' | 'cold'): void {
    this._lastError = err instanceof Error ? err.message : String(err);
    this.collectedReports.clear();
    if (fallback === 'cold') {
      this.pendingSendFile = null;
      this.activeFileParams = null;
      this.outbox.clear();
      this.replyPurpose.clear();
      this.awaitingAck.clear();
      this.setState('cold');
    } else {
      this.activeFileParams = null;
      this.finishToIdle();
    }
  }

  /**
   * Guard the state we are about to await in: if we are still in it, and no
   * transition has happened since, `ROOM_STALL_MS` from now, the dep never
   * settled — treat it exactly like a rejected one.
   *
   * Gated on `transitionSeq` as well as on the state itself because a state can
   * legitimately be re-entered (beginListening recurses while the air is busy),
   * and an older entry's guard must not fire against a newer one's await.
   */
  private guardStall(state: RoomState, fallback: 'idle' | 'cold', what: string): void {
    const seq = this.transitionSeq;
    this.timer(ROOM_STALL_MS, () => {
      if (this._state !== state || this.transitionSeq !== seq) return;
      dlog('ROOM', { stalled: what, state, us: this.deps.deviceId }, { level: 'warn' });
      this.handleDepsError(new Error(`room: ${what} never completed after ${ROOM_STALL_MS} ms`), fallback);
    });
  }

  private setState(next: RoomState): void {
    this._state = next;
    this.transitionSeq++;
    this.deps.onStateChange?.(next, Array.from(this._members.values()));
    // Entering an eligible state is the moment a held reply can go out. Every
    // transition routes through here, so this is the single re-arm point —
    // there is no state whose entry can forget to check the queue.
    if (next === 'idle' || next === 'joinWait') this.outbox.drain();
  }

  /** Register a cancelable timer, tracked in `pendingTimers` so `stop()` can
   *  cancel everything outstanding in one pass. */
  private timer(delayMs: number, fn: () => void): void {
    const entry: { cancel?: () => void } = {};
    entry.cancel = this.deps.schedule(() => {
      if (entry.cancel) this.pendingTimers.delete(entry.cancel);
      fn();
    }, delayMs);
    this.pendingTimers.add(entry.cancel);
  }
}

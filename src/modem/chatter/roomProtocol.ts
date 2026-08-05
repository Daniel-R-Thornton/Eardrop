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
  parseWelcome,
  parseReport,
  parseFileComing,
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
}

export const ROOM_TIMING = {
  listenMs: 1000, listenCapMs: 10000,
  // JOIN_WAIT and COLLECT both.
  //
  // 300 ms, not the 1 s this shipped with. Slots exist so two peers do not
  // start talking at the same instant, but listen-before-talk is what
  // actually prevents the collision — the slot only has to be long enough
  // that a peer who started in the previous one is visible to the next
  // device's carrier sense. That check averages the last 250 ms of audio, so
  // 300 ms clears it with margin. A full second bought nothing and cost up to
  // five seconds of the join, which is most of the time a two-device room
  // spends waiting.
  replySlots: 6, replySlotMs: 300,
  // Grace after the last reply slot opens.
  //
  // Must exceed one whole control message, because a peer that draws the
  // final slot only STARTS transmitting then and a WELCOME is roughly 3.15 s
  // of audio. Anything less and the window shuts mid-reply: the roll call
  // reports an empty room while a peer is still audibly answering, and the
  // answer lands just after everyone stopped listening for it.
  collectExtraMs: 4000,
  fileComingLeadMs: 700,
} as const;

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

/** The outbox dedup key for a reply owed to `proberId`.
 *
 *  The outbox keys entries on a monotonic id, because a TEXT broadcast is not
 *  keyed by a peer at all. This string restores exactly what the old
 *  prober-keyed map gave for free: at most one reply chain in flight per peer,
 *  so a repeat probe — or a setState that re-drains — cannot start a second. */
const replyKey = (proberId: number): string => `reply:${proberId}`;

export class RoomProtocol {
  private _state: RoomState = 'cold';
  private readonly _members = new Map<number, Member>();
  private _lastError: string | null = null;

  private readonly pendingTimers = new Set<() => void>();
  private listenElapsedMs = 0;
  private pendingSendFile: PendingFile | null = null;
  private activeFileParams: PendingFile | null = null;
  private readonly collectedReports = new Map<number, PeerReport>();
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
      onSent: (entry) => this.onOutboxSent(entry),
      onFailed: (entry, err) => {
        // Exhausting every slot is not an error the operator can act on — the
        // air was busy for a whole slot window and the reply is simply given
        // up on. A rejected isAirBusy/sendMessage is: that is an audio fault,
        // and it surfaces in the UI exactly as it did before the extraction.
        if (err !== undefined) this._lastError = err instanceof Error ? err.message : String(err);
        if (entry.kind === 'reply') this.forgetReplyPurpose(entry.targetId);
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
    this.setState('cold');
  }

  /** user dropped a file; size+duration go into FILE_COMING */
  /** `targetId` 0 broadcasts to the room; anything else addresses one member. */
  sendFile(fileBytes: number, durationMs: number, targetId = 0): void {
    if (this._state !== 'idle') {
      this.pendingSendFile = { fileBytes, durationMs, targetId };
      return;
    }
    this.beginRollCall({ fileBytes, durationMs, targetId });
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
    if (this._state !== 'collecting') return;
    this.collectedReports.set(msg.senderId, { deviceId: msg.senderId, grid });
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

  // ---- join / roll-call carrier-sense (shared 'listening' state) ----

  private beginListening(purpose: 'join' | 'rollCall'): void {
    this.setState('listening');
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
    await this.deps.playProbe(PROBE_PURPOSE.rollCall);
    if (this._state !== 'rollCall') return;

    this.setState('collecting');
    this.timer(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs + ROOM_TIMING.collectExtraMs, () => {
      if (this._state !== 'collecting') return;
      this.finishRollCall();
    });
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
    void this.sendFileComingAndTransmit(pickSettings(reports));
  }

  private async sendFileComingAndTransmit(settings: PickedSettings): Promise<void> {
    const fileParams = this.activeFileParams;
    if (!fileParams) return; // stop() cleared it mid-flight

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
    // Reply policy only — any other kind of owed transmission owns its own
    // follow-up. A reply is one kind: WELCOME-vs-REPORT is not recorded on the
    // entry at all, because a fresh probe can change it after the entry is
    // queued, so armReplyAck reads replyPurpose for the truth.
    if (entry.kind !== 'reply') return;
    this.armReplyAck(entry.targetId, entry.attempts);
    this.forgetReplyPurpose(entry.targetId);
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

  // ---- shared plumbing ----

  private finishToIdle(): void {
    this.setState('idle');
    if (this.pendingSendFile) {
      const queued = this.pendingSendFile;
      this.pendingSendFile = null;
      this.beginRollCall(queued);
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

  private setState(next: RoomState): void {
    this._state = next;
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

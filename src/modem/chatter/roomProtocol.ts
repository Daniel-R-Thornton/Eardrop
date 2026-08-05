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
 *     |                                              reports==0  |  reports>0
 *     +---------------------- lastError set <--------------------+
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
 * every outstanding timer via a single `pendingTimers` set. Most timer
 * callbacks re-check `this.state` before acting (and again after every
 * await) so a stale timer firing after a later transition is a no-op, never
 * a regression to an earlier state. `armReplyAck`'s retry timer is the
 * exception: it isn't state-shaped (a reply can be owed in either 'idle' or
 * 'joinWait'), so it gates on membership in `awaitingAck` instead — cleared
 * by any contact from the prober, and by `stop()`/the cold error path
 * alongside `replyQueue.clear()` — which is the same "stale timer is a
 * no-op" property, just keyed on the map rather than on `this.state`.
 *
 * `listening` is shared by both carrier-sense phases (join and roll-call) —
 * carrier sense is carrier sense regardless of what comes after it.
 *
 * Replies to probes are QUEUED, not state-gated: `onProbeHeard` records what
 * is owed and `drainReplyQueue` sends it whenever the local transmitter is
 * free (`canTransmitReply`). Gating the send on a single state meant two
 * devices joining at once were both in `joinWait` when the other's probe
 * arrived and neither ever replied.
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

/** Total sends per owed reply, including the first. A lost WELCOME leaves the
 *  joiner believing the room is empty, so one retry is worth roughly two
 *  seconds of extra airtime; more than that just makes a genuinely deaf peer
 *  expensive for everyone else. */
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

interface PendingReply {
  proberId: number;
  /** What the prober announced — decides WELCOME vs REPORT. Overwritten by a
   *  fresh probe, because the newest announcement is the true one: a device
   *  that ran a roll call and then refreshed and rejoined needs a WELCOME. */
  purpose: ProbePurpose;
  /** Sends attempted for this reply so far, including the first — read by
   *  armReplyAck to decide whether a retry is still owed. Capped at
   *  MAX_REPLY_ATTEMPTS: once attempts reaches it, the prober is given up on
   *  rather than retried again. */
  attempts: number;
  /** A slot chain is already in flight for this entry. */
  scheduled: boolean;
}

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
  /**
   * Replies transmitted but not yet known to have landed, keyed by prober id.
   *
   * "Acknowledged" is deliberately loose: anything at all heard from that
   * prober (a fresh probe, a REPORT, a WELCOME) proves the link works in the
   * direction that matters, and the room has no dedicated ack frame. Entries
   * that age out without any of that are re-queued once.
   */
  private readonly awaitingAck = new Map<number, PendingReply>();

  constructor(private readonly deps: RoomDeps) {}

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
    this.replyQueue.clear();
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
    // announcement is the true one.
    const queued = this.replyQueue.get(deviceId);
    if (queued) queued.purpose = purpose;
    else this.replyQueue.set(deviceId, { proberId: deviceId, purpose, attempts: 0, scheduled: false });

    this.drainReplyQueue();
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
      // sendMessage rejected (e.g. audio glitch mid-broadcast) — this is a
      // roll call in progress, so the existing zero-report deadline
      // destination (idle) is the right fallback, not a stuck 'collecting'.
      this.handleDepsError(err, 'idle');
    }
  }

  // ---- reply-to-probe: slotted, carrier-sensed, re-rolling among later slots ----

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

  private scheduleReply(baseTimeMs: number, candidateSlots: number[], entry: PendingReply): void {
    if (candidateSlots.length === 0) {
      // Give up — no slot left to try. Narrower exposure than the two delete
      // sites below (nothing has awaited across this one), but the identity
      // check is here anyway for consistency of the invariant.
      if (this.replyQueue.get(entry.proberId) === entry) this.replyQueue.delete(entry.proberId);
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
        // sendMessage is ~3s of audio; a `stop()`/cold-error/re-probe can
        // replace the queue entry at this key while we were awaiting it (a
        // cleared queue plus a fresh probe from the same prober creates a
        // brand-new, not-yet-sent entry under the same id). Delete only if
        // the entry still at this key is the one we just sent — a plain
        // delete-by-key would discard that newer, unsent entry. armReplyAck
        // must stay INSIDE this guard too: if it ran unconditionally, a send
        // that resolves after stop()/a cold error torn down this room would
        // arm a retry into a room that no longer exists (or one we've since
        // rejoined under a fresh id table).
        if (this.replyQueue.get(entry.proberId) === entry) {
          this.replyQueue.delete(entry.proberId);
          this.armReplyAck(entry);
        }
      } catch (err) {
        // isAirBusy/sendMessage rejected — surface the error and stop blocking
        // this prober. Same identity check as the success path above.
        if (this.replyQueue.get(entry.proberId) === entry) this.replyQueue.delete(entry.proberId);
        this._lastError = err instanceof Error ? err.message : String(err);
      }
    });
  }

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
      this.replyQueue.clear();
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
    if (next === 'idle' || next === 'joinWait') this.drainReplyQueue();
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

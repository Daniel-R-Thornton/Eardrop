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
 *     |             up to listenCapMs,                            onProbeHeard
 *     |             then force through)                           (reply slot)
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
 * Every state reached via a timer carries its OWN deadline back to idle (or
 * cold, for the pre-join chain) so nothing can get stuck; `stop()` cancels
 * every outstanding timer via a single `pendingTimers` set. Timer callbacks
 * re-check `this.state` before acting (and again after every await) so a
 * stale timer firing after a later transition is a no-op, never a
 * regression to an earlier state.
 *
 * `listening` is shared by both carrier-sense phases (join and roll-call) —
 * carrier sense is carrier sense regardless of what comes after it.
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
import { OFDM_TUNING } from '../types';

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
  replySlots: 6, replySlotMs: 1000, // JOIN_WAIT and COLLECT both
  // Grace after the last reply slot opens. A peer that draws the final slot
  // only STARTS transmitting at replySlots*replySlotMs; its control message is
  // then roughly a second of audio (handshake-band preamble + payload), on top
  // of worker encode latency and the offset between our window opening and its
  // slot clock starting (it can only begin timing once it has buffered and
  // decoded our whole ~4 s probe). At 500 ms the last slot's reply routinely
  // landed after the window shut and the roll call reported "nobody home"
  // while a peer was audibly answering.
  collectExtraMs: 2500,
  fileComingLeadMs: 700,
} as const;

/** A device's real self-knowledge (measured passband/QAM ceiling) arrives in
 *  a later iteration; v1 claims this fixed, sensible default for every WELCOME. */
const DEFAULT_CLAIM: BestRangeClaim = { lowHz: 1500, highHz: 7800, maxQamOrder: 6 };

/** How long a completed send/receive stays "occupied" before falling back to
 *  idle — durationMs is the transfer's own estimate, plus slack for the
 *  last frame's tail and any scheduling jitter. */
const TRANSFER_TAIL_MARGIN_MS = 5000;

interface PendingFile {
  fileBytes: number;
  durationMs: number;
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
  /** Probers a WELCOME reply chain is already in flight for — dedupes a
   *  second `onProbeHeard` for the same device while the first reply
   *  attempt is still waiting out its slot(s). */
  private readonly pendingReplyTo = new Set<number>();

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
    this.pendingReplyTo.clear();
    this.setState('cold');
  }

  /** user dropped a file; size+duration go into FILE_COMING */
  sendFile(fileBytes: number, durationMs: number): void {
    if (this._state !== 'idle') {
      this.pendingSendFile = { fileBytes, durationMs };
      return;
    }
    this.beginRollCall({ fileBytes, durationMs });
  }

  /** worker heard a probe: id + measured grid */
  onProbeHeard(deviceId: number, grid: number[]): void {
    const existing = this._members.get(deviceId);
    this._members.set(deviceId, { ...existing, deviceId, lastHeardMs: this.deps.now(), heardGrid: grid });

    // Only 'idle' carries reply duty — a probe heard mid-join or mid-rollcall
    // just refreshes the member table (simultaneous announce is a collision
    // both sides retry naturally at the next roll call). Dedupe by prober:
    // a repeat probe from the same device while its reply chain is still
    // waiting out a slot must not start a second, redundant reply chain.
    //
    // WELCOME vs REPORT: the wire-level probe burst is identical for a join
    // announcement and a roll-call announcement (see probeBurst.ts) — there
    // is no purpose bit on the air, so a listener can only tell the two
    // apart by whether it already knows this prober. A never-seen-before
    // device is joining (reply WELCOME, onboarding it); an already-known
    // member is running a roll call (reply REPORT — "roll-call ack" per the
    // design spec's control-message table), since a member we've already
    // welcomed needs a fresh channel measurement, not another welcome.
    // Consequence: a device rejoining with the same deviceId while peers
    // still hold it in _members (page refresh, reconnect, a second start())
    // gets a REPORT while sitting in joinWait, not a WELCOME — see
    // handleReport, which treats that as a member refresh rather than
    // dropping it. The real fix is a purpose bit on the probe burst so
    // WELCOME vs REPORT is signaled explicitly instead of inferred from
    // membership.
    if (this._state === 'idle' && !this.pendingReplyTo.has(deviceId)) {
      this.pendingReplyTo.add(deviceId);
      const alreadyKnown = existing !== undefined;
      this.scheduleReply(
        this.deps.now(),
        Array.from({ length: ROOM_TIMING.replySlots }, (_unused, i) => i),
        deviceId,
        alreadyKnown,
      );
    }
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
    if (msg.targetId !== this.deps.deviceId) return;
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

    // A WELCOME arriving during a roll call counts as a report. Which reply a
    // peer sends is inferred from whether it already knows us (see
    // onProbeHeard), and that inference is one-sided: if our WELCOME to them
    // was lost when they joined, they still consider us a stranger and answer
    // our roll call with a WELCOME rather than a REPORT. Ignoring it fails the
    // roll call with "nobody home" while a peer is audibly replying — observed
    // on hardware. The payload carries the same measured grid a REPORT does,
    // so there is no reason to discard it.
    if (this._state === 'collecting') {
      this.collectedReports.set(msg.senderId, { deviceId: msg.senderId, grid: parsed.grid });
    }
  }

  private handleReport(msg: ControlMessage): void {
    if (msg.targetId !== this.deps.deviceId) return;
    const grid = parseReport(msg.payload);
    if (!grid) return;

    // A REPORT is also a member refresh, independent of roll-call state: a
    // device rejoining with the same deviceId (page refresh, reconnect, a
    // second start()) while peers still hold it in _members receives REPORT
    // (not WELCOME, see onProbeHeard) even while it sits in joinWait. Drop
    // that silently and the rejoiner finishes joining knowing nothing about
    // this peer — so always upsert the sender here, mirroring what
    // handleWelcome refreshes.
    const existing = this._members.get(msg.senderId);
    this._members.set(msg.senderId, {
      ...existing,
      deviceId: msg.senderId,
      lastHeardMs: this.deps.now(),
      theirViewOfUs: grid,
    });

    // Roll-call accumulation (feeds pickSettings) only happens while actively
    // collecting — a REPORT arriving outside that window is member-refresh
    // only, never counted toward the roll call.
    if (this._state !== 'collecting') return;
    this.collectedReports.set(msg.senderId, { deviceId: msg.senderId, grid });
  }

  private handleFileComing(msg: ControlMessage): void {
    if (this._state !== 'idle' && this._state !== 'joinWait') return;
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
    await this.deps.playProbe();
    if (this._state !== 'announcing') return; // stale guard (e.g. stop() mid-await)

    this.setState('joinWait');
    this.timer(ROOM_TIMING.replySlots * ROOM_TIMING.replySlotMs, () => {
      if (this._state !== 'joinWait') return;
      this.finishToIdle();
    });
  }

  private async beginAnnounceRollCall(): Promise<void> {
    this.setState('rollCall');
    await this.deps.playProbe();
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
    const reports = Array.from(this.collectedReports.values());
    if (reports.length === 0) {
      this._lastError = 'roll call: no reports received — nobody home';
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
        targetId: 0,
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

  private scheduleReply(
    baseTimeMs: number,
    candidateSlots: number[],
    proberId: number,
    replyWithReport: boolean,
  ): void {
    if (candidateSlots.length === 0) {
      this.pendingReplyTo.delete(proberId); // give up — no slot left to try
      return;
    }
    const idx = Math.floor(this.deps.rng() * candidateSlots.length);
    const slot = candidateSlots[idx];
    const laterSlots = candidateSlots.filter((s) => s > slot);
    const delay = Math.max(0, baseTimeMs + slot * ROOM_TIMING.replySlotMs - this.deps.now());

    this.timer(delay, async () => {
      if (this._state !== 'idle') {
        this.pendingReplyTo.delete(proberId);
        return;
      }
      try {
        const busy = await this.deps.isAirBusy();
        if (this._state !== 'idle') {
          this.pendingReplyTo.delete(proberId);
          return;
        }

        if (busy) {
          this.scheduleReply(baseTimeMs, laterSlots, proberId, replyWithReport); // still pending — chain continues
          return;
        }
        const heardGrid = this._members.get(proberId)?.heardGrid ?? [];
        await this.deps.sendMessage(
          replyWithReport
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
              },
        );
        this.pendingReplyTo.delete(proberId);
      } catch (err) {
        // isAirBusy/sendMessage rejected — we're already 'idle', so there's
        // no state to unwind, just surface the error and stop dedupe-blocking
        // this prober.
        this.pendingReplyTo.delete(proberId);
        this._lastError = err instanceof Error ? err.message : String(err);
      }
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
      this.pendingReplyTo.clear();
      this.setState('cold');
    } else {
      this.activeFileParams = null;
      this.finishToIdle();
    }
  }

  private setState(next: RoomState): void {
    this._state = next;
    this.deps.onStateChange?.(next, Array.from(this._members.values()));
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

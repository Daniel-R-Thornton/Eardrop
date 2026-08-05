/**
 * Outbox — the room's collision-avoidance layer for owed transmissions.
 *
 * This is the machinery that used to live inside RoomProtocol as
 * `replyQueue`/`drainReplyQueue`/`scheduleReply`: a queue of transmissions this
 * device owes someone, each sent in a randomly chosen slot, carrier-sensed
 * immediately before it goes out, and re-rolled into a later slot if the air
 * turns out to be busy. A WELCOME, a REPORT, an ACK and a TEXT all want exactly
 * that, so it lives here once rather than three more times.
 *
 * The Outbox owns WHEN an owed transmission goes out and nothing about WHAT is
 * owed: the owner hands over a `build` closure and gets `onSent`/`onFailed`
 * back. Every policy decision — which states may transmit, whether a send earns
 * a retry, how many attempts are worth the airtime — stays with the owner.
 *
 * Slot count and slot length are injected rather than read from ROOM_TIMING, so
 * that table stays the single source of the room's timing and this module has no
 * opinion about it (see ROOM_TIMING.replySlotMs for why 300 ms and not 1 s).
 *
 * `canTransmit()` is the load-bearing dep. Draining only while the local
 * transmitter is free is what keeps an owed send out of a window where it would
 * do damage: our own probe playing, a file transfer in progress, or — the
 * expensive one — a roll-call collect window, where our burst both corrupts the
 * prober's FILE_COMING for everyone in earshot and mutes our own receiver
 * against it, so an entire file gets broadcast to a room that never armed. That
 * failure was silent: nothing errored, the transfer just went nowhere.
 *
 * `build` is called at SEND time, not at enqueue time, so a reply carries the
 * freshest measurement the device has of that peer rather than whatever was
 * known several seconds earlier when the probe was first heard.
 */
import type { ControlMessage } from '../protocol/controlFrame';

/**
 * What class of transmission an entry is — the owner's own taxonomy, used only
 * to route `onSent`/`onFailed` back to the right policy.
 *
 * A reply is ONE kind, not a welcome kind and a report kind. Which of the two a
 * reply turns out to be is decided at send time from the prober's newest
 * announcement (see roomProtocol's replyPurpose), and that can flip after the
 * entry is queued — so a `kind` fixed at enqueue would be a field that lies
 * about what actually went on the air, and the first thing to branch on it
 * would be wrong.
 */
export type OutboxKind = 'reply' | 'text' | 'ack';

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

export interface OutboxSpec {
  kind: OutboxKind;
  targetId: number;
  dedupKey: string;
  build: () => ControlMessage;
  /** Sends already spent on this transmission — a re-queued retry carries its
   *  predecessor's count forward so the owner's attempt cap still bites. */
  attempts?: number;
}

export class Outbox {
  /**
   * Owed transmissions, keyed by entry id.
   *
   * Keyed by a monotonic id rather than by peer because a TEXT is a broadcast
   * and is not keyed by a peer at all. Dedup — "at most one unsent entry per
   * dedupKey" — is therefore explicit instead of falling out of the key; a
   * reply passes `reply:<proberId>`, which is exactly the one-reply-chain-per-
   * peer rule the peer-keyed map used to give for free.
   */
  private readonly entries = new Map<number, OutboxEntry>();
  private nextId = 1;
  /** Cancels for slot timers currently in flight, so `clear()` can take a
   *  torn-down room's pending sends off the air in one pass. */
  private readonly pendingTimers = new Set<() => void>();

  constructor(private readonly deps: OutboxDeps) {}

  /** Returns the new entry's id, or the existing id if dedupKey is queued. */
  enqueue(spec: OutboxSpec): number {
    const existing = this.find(spec.dedupKey);
    if (existing) return existing.id;
    const id = this.nextId++;
    this.entries.set(id, {
      id,
      kind: spec.kind,
      targetId: spec.targetId,
      dedupKey: spec.dedupKey,
      build: spec.build,
      attempts: spec.attempts ?? 0,
      scheduled: false,
    });
    return id;
  }

  has(dedupKey: string): boolean {
    return this.find(dedupKey) !== undefined;
  }

  /** The unsent entry under `dedupKey`, if any. Exists so an owner (or a test)
   *  can inspect `scheduled`/`attempts` without reaching through two layers of
   *  `private` into the entry map. */
  peek(dedupKey: string): OutboxEntry | undefined {
    return this.find(dedupKey);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Start a slot chain for every entry without one. Call on entry to an
   *  eligible state. */
  drain(): void {
    if (!this.deps.canTransmit()) return;
    for (const entry of Array.from(this.entries.values())) {
      if (entry.scheduled) continue;
      entry.scheduled = true;
      this.scheduleEntry(
        this.deps.now(),
        Array.from({ length: this.deps.replySlots }, (_unused, i) => i),
        entry,
      );
    }
  }

  clear(): void {
    for (const cancel of this.pendingTimers) cancel();
    this.pendingTimers.clear();
    this.entries.clear();
  }

  private find(dedupKey: string): OutboxEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.dedupKey === dedupKey) return entry;
    }
    return undefined;
  }

  private scheduleEntry(baseTimeMs: number, candidateSlots: number[], entry: OutboxEntry): void {
    if (candidateSlots.length === 0) {
      // Give up — no slot left to try. Nothing has awaited across this path, so
      // the entry cannot have been replaced under it; the identity check is
      // here for consistency of the invariant the two sites below rely on.
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
      this.deps.onFailed?.(entry);
      return;
    }
    const idx = Math.floor(this.deps.rng() * candidateSlots.length);
    const slot = candidateSlots[idx];
    const laterSlots = candidateSlots.filter((s) => s > slot);
    const delay = Math.max(0, baseTimeMs + slot * this.deps.replySlotMs - this.deps.now());

    this.timer(delay, async () => {
      // Not eligible any more (a transfer started, a roll call began): HOLD
      // the entry and clear `scheduled` so the next drain re-sends it.
      // Dropping it here is the old bug.
      if (!this.deps.canTransmit()) {
        entry.scheduled = false;
        return;
      }
      try {
        const busy = await this.deps.isAirBusy();
        // Re-checked after the await as well as before it: eligibility can
        // change across the air check itself (a FILE_COMING landing mid-await
        // steals the transmitter), and dropping the entry on THAT path is the
        // same bug in a different costume.
        if (!this.deps.canTransmit()) {
          entry.scheduled = false;
          return;
        }

        if (busy) {
          this.scheduleEntry(baseTimeMs, laterSlots, entry); // still pending — chain continues
          return;
        }
        entry.attempts += 1;
        await this.deps.sendMessage(entry.build());
        // sendMessage is ~3s of audio, and a `clear()` plus a fresh enqueue can
        // happen inside that window. Because `nextId` is monotonic and survives
        // `clear()`, this identity check can only ever see its own entry or
        // nothing — so what it enforces is "am I still queued?", and a newer
        // entry for the same dedupKey lives under a different id where no stale
        // closure can touch it. Kept as an identity comparison rather than a
        // `has`, because it is the invariant that makes that reasoning true
        // rather than incidental.
        //
        // `onSent` must stay INSIDE the guard. That half is load-bearing and
        // not merely defensive: a send resolving after the owner tore its room
        // down would otherwise arm a retry into a room that no longer exists.
        // In roomProtocol that means a rejoined session transmitting ~3 s of
        // unsolicited WELCOME to a peer that never probed it — from joinWait,
        // which is transmit-eligible, so possibly straight into another
        // device's collect window.
        if (this.entries.get(entry.id) === entry) {
          this.entries.delete(entry.id);
          this.deps.onSent?.(entry);
        }
      } catch (err) {
        // isAirBusy/sendMessage rejected — stop blocking this dedupKey and let
        // the owner surface the error. Same identity check as the success path
        // above; `onFailed` is deliberately outside it, because recording "the
        // audio glitched" is true regardless of who owns the queue now.
        if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
        this.deps.onFailed?.(entry, err);
      }
    });
  }

  /** Register a cancelable slot timer, tracked so `clear()` can cancel every
   *  chain still in flight in one pass. */
  private timer(delayMs: number, fn: () => void): void {
    const holder: { cancel?: () => void } = {};
    holder.cancel = this.deps.schedule(() => {
      if (holder.cancel) this.pendingTimers.delete(holder.cancel);
      fn();
    }, delayMs);
    this.pendingTimers.add(holder.cancel);
  }
}

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
      // Give up — no slot left to try. Narrower exposure than the two delete
      // sites below (nothing has awaited across this one), but the identity
      // check is here anyway for consistency of the invariant.
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
        // sendMessage is ~3s of audio; a `clear()` plus a fresh enqueue can
        // replace what sits under this dedupKey while we were awaiting it (a
        // cleared queue plus a fresh probe from the same prober creates a
        // brand-new, not-yet-sent entry). Delete only if the entry still at
        // this id is the one we just sent — a plain delete would discard that
        // newer, unsent entry. `onSent` must stay INSIDE this guard too: if it
        // ran unconditionally, a send that resolves after the owner tore its
        // room down would arm a retry into a room that no longer exists (or
        // one we've since rejoined under a fresh id table).
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

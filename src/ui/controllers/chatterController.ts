/**
 * ChatterController — wires the chatter room's pure state machine
 * (RoomProtocol, see roomProtocol.ts) to real audio I/O and app state.
 *
 * Every RoomDeps method here is a THIN adapter: encode/play/check-air/arm-rx
 * calls into the worker + player, nothing more. All protocol DECISIONS
 * (when to announce, roll call, pick settings, time out) live in
 * RoomProtocol — if a change here starts re-deciding something the protocol
 * already decides, that belongs in roomProtocol.ts instead.
 *
 * Mute discipline: every locally-originated playback (probe, control
 * message, or the negotiated file broadcast) mutes the worker's RX path for
 * the duration of playback PLUS a fixed echo tail, so the room's own speaker
 * output is never mistaken for an incoming transmission.
 */
import {
  RoomProtocol,
  type RoomDeps,
  type RoomState,
  type Member,
} from '../../modem/chatter/roomProtocol';
import { type PickedSettings } from '../../modem/chatter/settingsPick';
import type { ControlMessage, FileComingPayload } from '../../modem/protocol/controlFrame';
import type { ModemEvent } from '../../workers/modemSchema';
import { AudioPlayer } from '../../audio/player';
import { buildModemConfig } from './buildModemConfig';
import { getState, setState } from '../Store';
import { OFDM_DEFAULTS } from '../../modem/types';

/** Echo tail after our own playback ends, before RX un-mutes (room echo settle). */
const MUTE_TAIL_MS = 150;

/** Fudge factor + floor over a floor-settings bit-rate estimate for the
 *  FILE_COMING durationMs field. The real settings aren't picked until AFTER
 *  roll call, so this has to be a conservative (over-, never under-) guess —
 *  underestimating would let both ends time out mid-transfer; overestimating
 *  only keeps the room occupied a little longer than strictly necessary. */
const DURATION_FUDGE = 3;
const DURATION_FLOOR_MS = 2000;
/** Worst-case per-symbol bit budget (floor settings: 4 tones, QPSK). */
const FLOOR_BITS_PER_SYMBOL = 4 * 2;

// TODO: this heuristic hasn't been checked against a real end-to-end
// transfer's actual duration yet — only reasoned about as "conservative
// enough". Verify on the bench once Task 7's panel makes a manual chatter
// transfer possible, and tighten the fudge factor if it's wildly loose.
function estimateDurationMs(fileBytes: number, symbolsPerSec: number): number {
  const bytesPerSec = (FLOOR_BITS_PER_SYMBOL * symbolsPerSec) / 8;
  if (bytesPerSec <= 0) return DURATION_FLOOR_MS;
  return Math.ceil((fileBytes / bytesPerSec) * 1000 * DURATION_FUDGE) + DURATION_FLOOR_MS;
}

/** Cap on how long `leaveRoom` waits for an in-flight own-playback (typically
 *  `stop()`'s best-effort BYE) before tearing chatter mode down anyway — a
 *  wedged encode/play must not make leaveRoom hang forever. */
const LEAVE_PLAYBACK_TIMEOUT_MS = 2500;

/** The subset of AudioPlayer's surface ChatterController needs — lets tests
 *  supply a fake without touching AudioContext. */
export interface AudioPlayerLike {
  play(samples: Float32Array, sampleRate: number, deviceId?: string, clean?: boolean): Promise<void>;
}

/**
 * The worker-facing surface ChatterController needs — the same request
 * shape/idiom `ModemController` uses (`on` for events, promise-returning
 * request methods for encode/check commands) over the chatter commands added
 * to modemSchema.ts. A real implementation forwards these to the modem
 * worker exactly as `ModemController.encodeFile` forwards `encodeFile`
 * (post the command, resolve on the matching `'encoded'`/`'airStatus'`
 * event by request id).
 */
export interface ModemWorkerHandle {
  /** Hardware sample rate — same role as the AudioContext rate ModemController wraps. */
  readonly sampleRate: number;
  on<T extends ModemEvent['type']>(type: T, fn: (ev: Extract<ModemEvent, { type: T }>) => void): () => void;
  configure(cfg: ReturnType<typeof buildModemConfig>): void;
  /** Ensure the main RX pipeline (mic capture + worker startRx) is running. */
  startListening(micGain: number, deviceId?: string, deviceLabel?: string): Promise<void>;
  stopListening(): void;
  encodeFile(fileName: string, data: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }>;
  chatterStart(deviceId: number): void;
  chatterStop(): void;
  encodeProbe(deviceId: number): Promise<{ samples: Float32Array; sampleRate: number }>;
  encodeControl(msg: ControlMessage): Promise<{ samples: Float32Array; sampleRate: number }>;
  airCheck(): Promise<{ busy: boolean; rms: number }>;
  setRxMuted(muted: boolean): void;
}

export interface ChatterControllerOptions {
  player?: AudioPlayerLike;
  now?: () => number;
  rng?: () => number;
  schedule?: (fn: () => void, delayMs: number) => () => void;
}

function toStoreMembers(members: Member[]): {
  deviceId: number;
  lastHeardMs: number;
  claimLowHz?: number;
  claimHighHz?: number;
}[] {
  return members.map((m) => ({
    deviceId: m.deviceId,
    lastHeardMs: m.lastHeardMs,
    claimLowHz: m.claim?.lowHz,
    claimHighHz: m.claim?.highHz,
  }));
}

export class ChatterController {
  private readonly player: AudioPlayerLike;
  private readonly schedule: (fn: () => void, delayMs: number) => () => void;
  private readonly rng: () => number;
  private readonly deps: RoomDeps;
  private readonly room: RoomProtocol;

  private deviceId = 0;
  private rxArmed = false;
  private pendingFile: { fileName: string; data: Uint8Array } | null = null;
  /** The most recently started own-playback (probe/control/file), settled
   *  (never rejected) — lets `leaveRoom` wait out `stop()`'s fire-and-forget
   *  BYE before tearing chatter mode down out from under it. */
  private lastPlayback: Promise<void> = Promise.resolve();

  constructor(private readonly worker: ModemWorkerHandle, options: ChatterControllerOptions = {}) {
    this.player = options.player ?? new AudioPlayer();
    this.schedule = options.schedule ?? ((fn, delayMs) => {
      const t = setTimeout(fn, delayMs);
      return () => clearTimeout(t);
    });
    this.rng = options.rng ?? Math.random;
    const now = options.now ?? (() => performance.now());

    this.deps = {
      // Placeholder — joinRoom() overwrites this with the real picked id
      // before start() is called; RoomProtocol reads `deps.deviceId` live.
      deviceId: 0,
      now,
      rng: this.rng,
      schedule: this.schedule,
      playProbe: () => this.playAndMute(() => this.worker.encodeProbe(this.deviceId)),
      sendMessage: (msg: ControlMessage) => this.playAndMute(() => this.worker.encodeControl(msg)),
      isAirBusy: async () => (await this.worker.airCheck()).busy,
      startFileTx: (settings: PickedSettings) => { void this.transmitFile(settings); },
      armFileRx: (info: FileComingPayload) => this.armFileRx(info),
      onStateChange: (state: RoomState, members: Member[]) => {
        setState({
          chatterState: state,
          chatterMembers: toStoreMembers(members),
          chatterError: this.room.lastError,
        });
      },
    };
    this.room = new RoomProtocol(this.deps);

    // Subscribed once, for the controller's whole lifetime — this class
    // assumes one ChatterController per app session (never re-constructed
    // per join/leave cycle), so there's no matching `off()`/teardown here;
    // joinRoom/leaveRoom only start and stop the ROOM, not these listeners.
    worker.on('probeHeard', (ev) => this.room.onProbeHeard(ev.deviceId, ev.grid));
    worker.on('controlMessage', (ev) => {
      this.room.onMessage({
        type: ev.msg.type,
        senderId: ev.msg.senderId,
        targetId: ev.msg.targetId,
        payload: new Uint8Array(ev.msg.payload),
      } as ControlMessage);
    });
  }

  /** join the room: pick a random device id, tell the worker, start the state machine */
  async joinRoom(): Promise<void> {
    const deviceId = 1 + Math.floor(this.rng() * 255); // 1-255
    this.deviceId = deviceId;
    this.deps.deviceId = deviceId;

    const s = getState();
    this.worker.configure(buildModemConfig({
      useOFDM: true,
      pilotFreqHz: OFDM_DEFAULTS.pilotFreqHz,
      toneStartHz: OFDM_DEFAULTS.toneStartHz,
      toneCount: OFDM_DEFAULTS.toneCount,
      symbolsPerSec: s.symbolsPerSec,
      musicalMode: false,
      diversityMode: false,
      hwSampleRate: this.worker.sampleRate,
      bandHandshake: true,
    }));
    this.worker.chatterStart(deviceId);
    await this.worker.startListening(s.micGain, s.selectedInputId, s.selectedInputLabel);
    this.rxArmed = true;

    setState({ chatterOn: true, chatterDeviceId: deviceId, chatterError: null });
    this.room.start();
  }

  /** leave the room: stop the state machine, tear down the worker's chatter mode */
  async leaveRoom(): Promise<void> {
    this.room.stop(); // fires a best-effort BYE via a fire-and-forget deps.sendMessage
    // Give that BYE's encode+play chain a real chance to run before tearing
    // chatter mode down — chatterStop()/stopListening() below would
    // otherwise race it out from under it structurally (every time, not just
    // occasionally), since stop() doesn't await its own sendMessage call.
    await Promise.race([this.lastPlayback, this.timeout(LEAVE_PLAYBACK_TIMEOUT_MS)]);
    this.worker.chatterStop();
    this.worker.stopListening();
    this.rxArmed = false;
    this.pendingFile = null;
    setState({
      chatterOn: false,
      chatterState: 'off',
      chatterDeviceId: 0,
      chatterMembers: [],
      chatterError: null,
    });
  }

  /** Broadcast a file to the room (chatter path for the existing drop zone). */
  async broadcastFile(fileName: string, data: Uint8Array): Promise<void> {
    if (this.room.state !== 'idle') {
      setState({ chatterError: `cannot broadcast: room is ${this.room.state}, not idle` });
      return;
    }
    this.pendingFile = { fileName, data };
    const durationMs = estimateDurationMs(data.byteLength, getState().symbolsPerSec);
    this.room.sendFile(data.byteLength, durationMs);
  }

  // ---- RoomDeps adapters ----

  /** Mute RX for the duration of an own-playback (probe/control/file) plus a
   *  fixed echo tail, so the room's own speaker output is never demodulated
   *  as if it were incoming. Tracks the attempt on `lastPlayback` (settled,
   *  never rejected) so `leaveRoom` can wait one out; the returned promise
   *  still rejects normally for callers (RoomProtocol's own catch blocks). */
  private playAndMute(getAudio: () => Promise<{ samples: Float32Array; sampleRate: number }>): Promise<void> {
    const attempt = this.doPlayAndMute(getAudio);
    this.lastPlayback = attempt.catch(() => {});
    return attempt;
  }

  private async doPlayAndMute(getAudio: () => Promise<{ samples: Float32Array; sampleRate: number }>): Promise<void> {
    const { samples, sampleRate } = await getAudio();
    this.worker.setRxMuted(true);
    try {
      await this.player.play(samples, sampleRate);
    } finally {
      await this.timeout(MUTE_TAIL_MS);
      this.worker.setRxMuted(false);
    }
  }

  private timeout(delayMs: number): Promise<void> {
    return new Promise((resolve) => { this.schedule(resolve, delayMs); });
  }

  /** Ensure the RX pipeline is running before an incoming transfer's band
   *  card arrives — the transmission's own card does the tuning (see
   *  HandshakeReceiver); `info` carries nothing else this adapter needs
   *  (the receive timeout is RoomProtocol's own timer). */
  private armFileRx(info: FileComingPayload): void {
    void info;
    if (this.rxArmed) return;
    this.rxArmed = true;
    const s = getState();
    this.worker.startListening(s.micGain, s.selectedInputId, s.selectedInputLabel).catch((err) => {
      this.rxArmed = false;
      setState({ chatterError: err instanceof Error ? err.message : String(err) });
    });
  }

  private async transmitFile(settings: PickedSettings): Promise<void> {
    const pending = this.pendingFile;
    this.pendingFile = null;
    if (!pending) return;

    const s = getState();
    const cfg = buildModemConfig({
      useOFDM: true,
      pilotFreqHz: settings.pilotFreqHz,
      toneStartHz: settings.toneStartHz,
      toneCount: settings.toneCount,
      symbolsPerSec: s.symbolsPerSec,
      musicalMode: false,
      diversityMode: false,
      hwSampleRate: this.worker.sampleRate,
      bandHandshake: true,
      qamScaleOverride: s.qamScaleOverride,
      toneGains: settings.toneGains,
      trainingSettleSymbols: s.trainingSettleSymbols,
    });
    // Per-tone bit-loading from the negotiated settings overrides
    // buildModemConfig's uniform dataQamBits derivation — chatter's qamMap is
    // tailored per tone to the worst peer's measured margin (settingsPick.ts),
    // not a single global QAM order.
    cfg.qamMap = settings.qamMap.slice();
    cfg.emitLinkProfile = true;
    this.worker.configure(cfg);

    await this.playAndMute(() => this.worker.encodeFile(pending.fileName, pending.data));
  }
}

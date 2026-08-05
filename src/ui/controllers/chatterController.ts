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
import {
  ControlType,
  CONTROL_HEADER_WIRE,
  controlPayloadWireSize,
  type ControlMessage,
  type FileComingPayload,
} from '../../modem/protocol/controlFrame';
import type { ModemEvent } from '../../workers/modemSchema';
import { AudioPlayer, PLAYBACK_TARGET_PEAK } from '../../audio/player';
import { buildModemConfig } from './buildModemConfig';
import {
  getState, setState, CHATTER_PACKET_LOG_MAX, CHATTER_MESSAGE_LOG_MAX,
  type ChatterPacket, type ChatMessage,
} from '../Store';
import { OFDM_DEFAULTS, OFDM_HANDSHAKE } from '../../modem/types';
import { reportGridFreqs, type ProbePurpose } from '../../modem/protocol/probeBurst';
import { dlog } from '../../lib/debug/dlog';
import { handshakeToneGains } from '../../modem/chatter/handshakeGains';

/** OFDM tone spacing — the handshake band's tones sit on this grid. */
const OFDM_TONE_SPACING_HZ = OFDM_DEFAULTS.toneSpacingHz;

/** Echo tail after our own playback ends, before RX un-mutes (room echo settle). */
const MUTE_TAIL_MS = 150;

/**
 * Peak the transmitter AIMS under, not a peak it guarantees.
 *
 * Every segment `TxEngine.frameSegments` yields — handshake preamble, band
 * card, target-band preamble, data frames — is emitted at ONE fixed
 * deterministic scale, set as `0.95 / budget` by the modulator's own level
 * maths. But that budget is a measured PAPR budget: OFDMQPSKModulator's scale
 * doc states outright that it "IS NO LONGER A PROOF" and holds only up to
 * PAPR_CREST standard deviations, accepting occasional tail clipping in
 * exchange for not paying a permanent ~9 dB level penalty. So 0.95 is a design
 * target with a measured (and deliberately non-zero) exceedance probability,
 * and this constant is the transmitter's aim point — not a licence to assume
 * any particular sample is below it.
 */
const FRAME_SEGMENT_PEAK_AIM = 0.95;

/**
 * Fixed playback gain for the streamed file transmission.
 *
 * Volume-INDEPENDENT on purpose. The batch `play()` path normalises every
 * buffer to PLAYBACK_TARGET_PEAK regardless of `volume`, so probes and control
 * messages — which still go out through it — leave this device at one fixed
 * absolute level. The roll-call channel measurement and the -18 dB band pick
 * are made from probes at that level, and the file's own handshake segment is
 * the sync-critical head of the transmission on a band this branch documents
 * as unmeasured over the air. Letting the file's level ride the UI volume
 * slider meant the negotiation and the transfer it negotiates for went out at
 * different levels, quieter by 20·log10(volume) dB for any volume < 1.
 *
 * Derived from the transmitter's own aim point, NOT from measuring chunks:
 * per-chunk normalisation is banned outright (see AudioPlayer.playStream's
 * `schedule()` — it was measured stepping the level between chunks and
 * wrecking every channel estimate downstream), and buffering the whole
 * waveform to measure its true peak would give back the memory saving the
 * streaming path exists for.
 *
 * Residual, recorded honestly: this maps the transmitter's AIM POINT onto the
 * batch path's target peak, so it reproduces the batch level exactly only for a
 * transmission that actually reaches that aim. A real chatter waveform peaks
 * lower (0.69-0.74 measured across 4/8/16/32-tone configs, flat and tilted
 * gains), where batch `play()`'s peak-normalisation amplified it by 1/peak into
 * 0.95 — so the streamed file still goes out ~2.2-2.8 dB below the batch path.
 * Closing that last gap needs the waveform's real peak, which cannot be had
 * without measuring it.
 *
 * DO NOT RAISE THIS ABOVE 1.0 to chase that 2.2-2.8 dB. The only clip guard on
 * this path is in `playStream`'s `schedule()`, and it inspects the RAW chunk
 * BEFORE the gain node applies this number — so a gain above unity clips at the
 * destination with no clamp and no `clipClamped` log line, leaving a wrecked
 * transfer with nothing in the log to explain it. `playStream` clamps
 * `fixedGain` to 1.0 for exactly this reason, so raising it here would silently
 * do nothing rather than fail loudly. The transmitter's peak is also only a
 * measured PAPR aim (see FRAME_SEGMENT_PEAK_AIM), so headroom above it is not
 * actually free even in principle. The legitimate route is a TX-side
 * deterministic peak for the transmission about to be emitted, computed from
 * the configuration and plumbed through to here.
 */
const FILE_STREAM_GAIN = PLAYBACK_TARGET_PEAK / FRAME_SEGMENT_PEAK_AIM;

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

/** Cap on how long `joinRoom` waits for `startListening()` to settle before
 *  declaring the join failed. An ungranted mic permission prompt (the user
 *  never answers it, or the browser silently withholds the grant) leaves
 *  `startListening()`'s returned promise pending forever — it doesn't
 *  reject, it just never settles — so without this timeout `joinRoom` would
 *  hang indefinitely with no `chatterError` ever set. ~13s: long enough
 *  that a user answering a real permission dialog isn't cut off mid-click,
 *  short enough that a hung join surfaces well before the user assumes the
 *  app is simply broken. */
const JOIN_MIC_TIMEOUT_MS = 13000;

/** The subset of AudioPlayer's surface ChatterController needs — lets tests
 *  supply a fake without touching AudioContext. */
export interface AudioPlayerLike {
  play(samples: Float32Array, sampleRate: number, deviceId?: string, clean?: boolean): Promise<void>;
  /** Chunked playback — see AudioPlayer.playStream. Used for the file path so
   *  peak memory is one chunk rather than the whole waveform. */
  playStream(
    pull: () => Promise<Float32Array | null>,
    sampleRate: number,
    deviceId?: string,
    onProgress?: (scheduledSec: number) => void,
    fixedGain?: number,
  ): Promise<void>;
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
  /** Streaming encode — see ModemController.startFileStream. */
  startFileStream(fileName: string, data: Uint8Array): Promise<{
    sampleRate: number;
    totalSamples: number;
    pull: () => Promise<Float32Array | null>;
    cancel: () => void;
  }>;
  chatterStart(deviceId: number): void;
  chatterStop(): void;
  encodeProbe(deviceId: number, purpose: ProbePurpose): Promise<{ samples: Float32Array; sampleRate: number }>;
  encodeControl(msg: ControlMessage, toneGains?: number[]): Promise<{ samples: Float32Array; sampleRate: number }>;
  chatterScanPaused(paused: boolean): void;
  airCheck(): Promise<{ busy: boolean; rms: number }>;
  setRxMuted(muted: boolean): void;
}

export interface ChatterControllerOptions {
  player?: AudioPlayerLike;
  now?: () => number;
  rng?: () => number;
  schedule?: (fn: () => void, delayMs: number) => () => void;
}

/** dB floor for a zero-magnitude grid point — avoids -Infinity feeding the mean. */
const GRID_FLOOR_DB = -60;

/** Mean of `rawGrid` in dB relative to its own peak (≤ 0), plus the grid
 *  itself normalized so max = 1. Guards zero-length/all-zero grids by
 *  returning undefined rather than NaN/-Infinity. Display-only — never feeds
 *  a protocol decision. */
function computeLinkInfo(rawGrid: number[]): { linkDb: number; grid: number[] } | undefined {
  if (rawGrid.length === 0) return undefined;
  const peak = Math.max(...rawGrid);
  if (!(peak > 0)) return undefined;
  const grid = rawGrid.map((m) => m / peak);
  const linkDb = grid.reduce((sum, m) => sum + (m > 0 ? 20 * Math.log10(m) : GRID_FLOOR_DB), 0) / grid.length;
  return { linkDb, grid };
}

/**
 * Level of the fixed handshake band in a measured probe grid, in dB relative
 * to that grid's strongest point.
 *
 * Every control message rides OFDM_HANDSHAKE's tones. A probe burst sweeps
 * straight through that range and its ID pulses sit far below it, so probes
 * can decode perfectly on hardware whose response has already collapsed where
 * the control frames live — which looks like "they can hear each other but
 * cannot talk". This turns that into a number in the log instead of a guess.
 */
function handshakeBandDb(grid: number[]): number | null {
  const freqs = reportGridFreqs();
  const lo = OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz;
  // toneCount - 1: N tones spaced toneSpacingHz apart span (N-1) * spacing,
  // not N * spacing (8 tones 50 Hz apart cover 350 Hz, not 400) — this was
  // an off-by-one that made the logged/measured window run 50 Hz high.
  const hi = lo + (OFDM_HANDSHAKE.toneCount - 1) * OFDM_TONE_SPACING_HZ;
  const peak = Math.max(...grid);
  if (!(peak > 0)) return null;
  const inBand = grid.filter((_m, i) => freqs[i] >= lo - 100 && freqs[i] <= hi + 100);
  if (inBand.length === 0) return null;
  const mean = inBand.reduce((sum, m) => sum + m, 0) / inBand.length;
  return mean > 0 ? 20 * Math.log10(mean / peak) : GRID_FLOOR_DB;
}

/** Actual over-the-air bytes for a control message with `payloadLen` raw
 *  payload bytes: the fixed BCH-coded header plus the BCH-coded payload —
 *  same wire shape controlFrame.ts uses to encode/decode it. */
function controlWireBytes(payloadLen: number): number {
  return CONTROL_HEADER_WIRE + controlPayloadWireSize(payloadLen);
}

/** Maps a decoded ControlType to the packet log's `kind` — display labels
 *  only, mirrors controlFrame.ts's ControlType without adding new meaning. */
function controlKindFromType(type: ControlType): ChatterPacket['kind'] {
  switch (type) {
    case ControlType.Welcome: return 'welcome';
    case ControlType.FileComing: return 'fileComing';
    case ControlType.Bye: return 'bye';
    case ControlType.Text: return 'text';
    case ControlType.Ack: return 'ack';
    case ControlType.Report:
    default:
      return 'report';
  }
}

function toStoreMembers(members: Member[]): {
  deviceId: number;
  lastHeardMs: number;
  claimLowHz?: number;
  claimHighHz?: number;
  linkDb?: number;
  grid?: number[];
}[] {
  return members.map((m) => {
    const info = m.heardGrid ? computeLinkInfo(m.heardGrid) : undefined;
    return {
      deviceId: m.deviceId,
      lastHeardMs: m.lastHeardMs,
      claimLowHz: m.claim?.lowHz,
      claimHighHz: m.claim?.highHz,
      linkDb: info?.linkDb,
      grid: info?.grid,
    };
  });
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
  /** Re-entry guard: `chatterOn` in the Store only flips true at the END of
   *  `joinRoom`'s async chain, so a second click/call arriving mid-await sees
   *  `chatterOn === false` and would otherwise re-enter — re-rolling the
   *  device id mid-join and making `ModemController.startListening` spin up a
   *  SECOND `AudioRecorder` (leaking the first one's open mic stream) on top
   *  of the in-flight one. Mirrors the shape for `leaveRoom`. */
  private joining = false;
  private leaving = false;
  /** The most recently started own-playback (probe/control/file), settled
   *  (never rejected) — lets `leaveRoom` wait out `stop()`'s fire-and-forget
   *  BYE before tearing chatter mode down out from under it. */
  private lastPlayback: Promise<void> = Promise.resolve();
  /** Monotonic counter for ChatterPacket.seq (React key) — session-scoped, never reset. */
  private packetSeq = 0;
  /** Monotonic counter for ChatMessage.seq (React key) — session-scoped, never reset. */
  private messageSeq = 0;

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
      playProbe: (purpose) => this.playAndMute(() => this.worker.encodeProbe(this.deviceId, purpose), {
        kind: 'probe',
        peerId: 0,
        bytes: 0,
      }),
      sendMessage: (msg: ControlMessage) => this.playAndMute(
        // Pre-emphasise the handshake band using what THIS recipient reported
        // hearing of our probe. A broadcast (targetId 0) has no single right
        // curve, so it stays flat.
        () => this.worker.encodeControl(msg, this.handshakeGainsFor(msg.targetId)),
        {
        kind: controlKindFromType(msg.type),
          peerId: msg.targetId,
          bytes: controlWireBytes(msg.payload.byteLength),
        },
      ),
      isAirBusy: async () => (await this.worker.airCheck()).busy,
      startFileTx: (settings: PickedSettings) => { void this.transmitFile(settings); },
      armFileRx: (info: FileComingPayload) => this.armFileRx(info),
      onStateChange: (state: RoomState, members: Member[]) => {
        // While a file is in the air the room's scanners have nothing useful
        // to hear: the probe correlator and the control listener would only
        // chew CPU false-syncing on file audio, and on a phone that CPU is
        // competing with the demodulation that actually matters.
        this.worker.chatterScanPaused(state === 'sending' || state === 'receiving');
        setState({
          chatterState: state,
          chatterMembers: toStoreMembers(members),
          chatterError: this.room.lastError,
        });
      },
      // A received TEXT is definitionally delivered here — the ACK RoomProtocol
      // sends back is unconditional, not contingent on this callback existing.
      onTextReceived: ({ msgId, senderId, targetId, text }) => {
        this.recordMessage({
          msgId, senderId, targetId, text, dir: 'rx', ackedBy: [], state: 'delivered',
        });
      },
      // Patches the matching outbound message in place rather than appending
      // — the store holds ONE row per sent message, and ackedBy/state are its
      // mutable fields as delivery progresses.
      onTextAcked: (msgId, byDeviceId) => {
        this.patchSentMessage(msgId, (m) => ({
          ackedBy: m.ackedBy.includes(byDeviceId) ? m.ackedBy : [...m.ackedBy, byDeviceId],
        }));
      },
      onTextStateChange: (msgId, state, ackedBy) => {
        this.patchSentMessage(msgId, () => ({ state, ackedBy: [...ackedBy] }));
      },
    };
    this.room = new RoomProtocol(this.deps);

    // Subscribed once, for the controller's whole lifetime — this class
    // assumes one ChatterController per app session (never re-constructed
    // per join/leave cycle), so there's no matching `off()`/teardown here;
    // joinRoom/leaveRoom only start and stop the ROOM, not these listeners.
    worker.on('probeHeard', (ev) => {
      this.room.onProbeHeard(ev.deviceId, ev.grid, ev.purpose);
      const info = computeLinkInfo(ev.grid);
      // The probe just measured this peer's whole passband — report what it
      // found where the control messages actually live. A healthy probe with
      // a collapsed handshake band is the signature of "we can see each other
      // but never exchange a control frame".
      const hsDb = handshakeBandDb(ev.grid);
      dlog('ROOM', {
        probeFrom: ev.deviceId,
        meanDb: info ? info.linkDb.toFixed(1) : 'n/a',
        handshakeBandDb: hsDb === null ? 'n/a' : hsDb.toFixed(1),
        // toneCount - 1, not toneCount: see handshakeBandDb's identical fix.
        band: `${OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz}-${
          OFDM_HANDSHAKE.pilotFreqHz + OFDM_HANDSHAKE.toneStartHz
            + (OFDM_HANDSHAKE.toneCount - 1) * OFDM_TONE_SPACING_HZ}Hz`,
      }, { level: 'warn' });
      this.recordPacket({
        dir: 'rx',
        kind: 'probe',
        peerId: ev.deviceId,
        bytes: 0,
        note: info ? `grid ${info.linkDb.toFixed(1)} dB` : undefined,
      });
      // Patch linkDb/grid into the store's member mirror the instant a probe
      // is measured, rather than waiting for the next onStateChange snapshot
      // — idle -> rollCall only fires from an explicit sendFile(), so in a
      // quiet room onStateChange may not fire again for a long time, and the
      // graph's primary distance/colour input would sit undefined the whole
      // while. RoomProtocol.onProbeHeard (called just above) records the
      // same heardGrid on its own _members entry, so the next onStateChange
      // recomputes the identical linkDb/grid via toStoreMembers — the two
      // mirrors never diverge, this just gets there sooner.
      if (info) this.mergeMemberLinkInfo(ev.deviceId, info);
    });
    worker.on('controlMessage', (ev) => {
      this.room.onMessage({
        type: ev.msg.type,
        senderId: ev.msg.senderId,
        targetId: ev.msg.targetId,
        payload: new Uint8Array(ev.msg.payload),
      } as ControlMessage);
      this.recordPacket({
        dir: 'rx',
        kind: controlKindFromType(ev.msg.type),
        peerId: ev.msg.senderId,
        bytes: controlWireBytes(ev.msg.payload.byteLength),
      });
    });
  }

  /** join the room: pick a random device id, tell the worker, start the state machine.
   *  No-op while a join is already in flight or the room is already joined —
   *  `chatterOn` only flips true at the very end of this method, so without
   *  this guard a second call arriving mid-await would re-roll the device id
   *  and hand `ModemController.startListening` a second `AudioRecorder` on
   *  top of the first (leaked mic stream). */
  async joinRoom(): Promise<void> {
    if (this.joining || getState().chatterOn) return;
    this.joining = true;
    // Tracks whether `chatterStart` has already been sent to the worker this
    // attempt — if a later step fails/hangs, the catch below must undo it
    // with `chatterStop` rather than leaving the worker's chatter mode
    // running under a store that thinks the join never happened.
    let chatterStartSent = false;
    try {
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
      chatterStartSent = true;
      await this.withTimeout(
        this.worker.startListening(s.micGain, s.selectedInputId, s.selectedInputLabel),
        JOIN_MIC_TIMEOUT_MS,
        'timed out waiting for microphone permission',
      );
      this.rxArmed = true;

      setState({ chatterOn: true, chatterDeviceId: deviceId, chatterError: null });
      this.room.start();
    } catch (err) {
      // Undo whatever partial setup this attempt performed — a failed/hung
      // join must leave the store looking exactly like "never joined", not
      // half-joined with the worker's chatter mode silently still running.
      if (chatterStartSent) this.worker.chatterStop();
      this.rxArmed = false;
      this.deviceId = 0;
      this.deps.deviceId = 0;
      const reason = err instanceof Error ? err.message : String(err);
      setState({
        chatterOn: false,
        chatterState: 'off',
        chatterDeviceId: 0,
        chatterError: `could not join: ${reason}`,
      });
    } finally {
      this.joining = false;
    }
  }

  /** leave the room: stop the state machine, tear down the worker's chatter mode.
   *  No-op while a leave is already in flight or the room isn't joined — same
   *  re-entry hazard as `joinRoom` (`chatterOn` only flips false at the end). */
  async leaveRoom(): Promise<void> {
    if (this.leaving || !getState().chatterOn) return;
    this.leaving = true;
    try {
      let teardownErr: unknown;
      try {
        this.room.stop(); // fires a best-effort BYE via a fire-and-forget deps.sendMessage
        // Give that BYE's encode+play chain a real chance to run before tearing
        // chatter mode down — chatterStop()/stopListening() below would
        // otherwise race it out from under it structurally (every time, not just
        // occasionally), since stop() doesn't await its own sendMessage call.
        await Promise.race([this.lastPlayback, this.timeout(LEAVE_PLAYBACK_TIMEOUT_MS)]);
        this.worker.chatterStop();
        this.worker.stopListening();
      } catch (err) {
        // Teardown failing partway through must not wedge the store in a
        // half-joined state — fall through to the same not-joined reset the
        // happy path takes, just with an error recorded for the UI.
        teardownErr = err;
      }
      this.rxArmed = false;
      this.pendingFile = null;
      setState({
        chatterOn: false,
        chatterState: 'off',
        chatterDeviceId: 0,
        chatterMembers: [],
        chatterError: teardownErr
          ? `leave failed: ${teardownErr instanceof Error ? teardownErr.message : String(teardownErr)}`
          : null,
      });
    } finally {
      this.leaving = false;
    }
  }

  /** Broadcast a file to the room (chatter path for the existing drop zone). */
  /** `targetId` 0 (the default) sends to the whole room; anything else
   *  addresses one member — the air carries it to everyone either way, but
   *  only the addressee arms its receiver. */
  async broadcastFile(fileName: string, data: Uint8Array, targetId = 0): Promise<void> {
    if (this.room.state !== 'idle') {
      setState({ chatterError: `cannot send: room is ${this.room.state}, not idle` });
      return;
    }
    this.pendingFile = { fileName, data };
    const durationMs = estimateDurationMs(data.byteLength, getState().symbolsPerSec);
    this.room.sendFile(data.byteLength, durationMs, targetId);
  }

  /** Send a chat message. `targetId` 0 (the default) goes to the whole room;
   *  anything else addresses one member. Rejects over-long text via the
   *  protocol's own cap rather than silently truncating. */
  sendText(text: string, targetId = 0): void {
    if (!getState().chatterOn) {
      setState({ chatterError: 'join the room before sending a message' });
      return;
    }
    try {
      const msgId = this.room.sendText(text, targetId);
      this.recordMessage({
        msgId, senderId: this.deviceId, targetId, text,
        dir: 'tx', ackedBy: [], state: 'sending',
      });
    } catch (err) {
      setState({ chatterError: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Handshake-band pre-emphasis for a control message aimed at `targetId`.
   *
   * Uses `theirViewOfUs` — the curve THAT peer measured from OUR probe — not
   * what we measured of theirs. Those are different channels (their mic and
   * our speaker versus the reverse), and using the wrong one would emphasise
   * the wrong tones, which is how a link that works one way fails the other.
   *
   * Undefined for a broadcast: one waveform reaches everyone, so there is no
   * single correct curve, and the flat behaviour is the honest default.
   */
  private handshakeGainsFor(targetId: number): number[] | undefined {
    if (!targetId) return undefined;
    return handshakeToneGains(this.room.members.get(targetId)?.theirViewOfUs);
  }

  // ---- RoomDeps adapters ----

  /** Mute RX for the duration of an own-playback (probe/control/file) plus a
   *  fixed echo tail, so the room's own speaker output is never demodulated
   *  as if it were incoming. Tracks the attempt on `lastPlayback` (settled,
   *  never rejected) so `leaveRoom` can wait one out; the returned promise
   *  still rejects normally for callers (RoomProtocol's own catch blocks).
   *
   *  Also the SINGLE place a tx ChatterPacket is recorded — every own
   *  playback (probe, control message, file) routes through here, so this is
   *  the one spot that logs the event and stamps `chatterLastTx`, rather than
   *  scattering recording across each RoomDeps call site. Recorded before
   *  `getAudio()` runs, per the "observed" semantics (tx = immediately before
   *  playback starts) — all packet metadata (kind/peerId/bytes) is known
   *  upfront, without needing the encoded audio. */
  private playAndMute(
    getAudio: () => Promise<{ samples: Float32Array; sampleRate: number }>,
    packet: Omit<ChatterPacket, 'seq' | 'tMs' | 'dir'>,
  ): Promise<void> {
    this.recordPacket({ dir: 'tx', ...packet });
    setState({ chatterLastTx: this.deps.now() });
    const attempt = this.doPlayAndMute(getAudio);
    this.lastPlayback = attempt.catch(() => {});
    return attempt;
  }

  /** Streaming counterpart of `playAndMute` — same packet recording, same
   *  mute discipline and echo tail, same selected-speaker routing; the audio
   *  arrives in chunks instead of one buffer. Kept as a sibling rather than a
   *  flag on playAndMute because the two take different callbacks and share no
   *  body beyond the bookkeeping. */
  private playStreamAndMute(
    start: () => Promise<{ sampleRate: number; pull: () => Promise<Float32Array | null>; cancel: () => void }>,
    packet: Omit<ChatterPacket, 'seq' | 'tMs' | 'dir'>,
  ): Promise<void> {
    this.recordPacket({ dir: 'tx', ...packet });
    setState({ chatterLastTx: this.deps.now() });
    const attempt = this.doPlayStreamAndMute(start);
    this.lastPlayback = attempt.catch(() => {});
    return attempt;
  }

  private async doPlayStreamAndMute(
    start: () => Promise<{ sampleRate: number; pull: () => Promise<Float32Array | null>; cancel: () => void }>,
  ): Promise<void> {
    const { sampleRate, pull, cancel } = await start();
    this.worker.setRxMuted(true);
    try {
      // Read the output device at play time, so a device change mid-session
      // takes effect on the next burst (same reason as doPlayAndMute).
      //
      // FILE_STREAM_GAIN, not the volume slider: the control plane this
      // transfer was negotiated over goes out through batch play(), whose
      // normalisation makes its level volume-independent. See the constant.
      await this.player.playStream(
        pull, sampleRate, getState().selectedOutputId, undefined, FILE_STREAM_GAIN,
      );
    } catch (err) {
      // Cancel the worker-side generator, or a failed playback leaves it
      // holding the whole encode until the next stream replaces it.
      cancel();
      throw err;
    } finally {
      await this.timeout(MUTE_TAIL_MS);
      this.worker.setRxMuted(false);
    }
  }

  /** Push one ChatterPacket onto the bounded ring (display-only — never
   *  read by any protocol decision). */
  private recordPacket(p: Omit<ChatterPacket, 'seq' | 'tMs'>): void {
    const packet: ChatterPacket = { seq: this.packetSeq++, tMs: this.deps.now(), ...p };
    setState({ chatterPackets: [...getState().chatterPackets, packet].slice(-CHATTER_PACKET_LOG_MAX) });
  }

  /** Push one ChatMessage onto the bounded ring (display-only — never read
   *  by any protocol decision), mirroring `recordPacket`'s shape. */
  private recordMessage(m: Omit<ChatMessage, 'seq' | 'tMs'>): void {
    const message: ChatMessage = { seq: this.messageSeq++, tMs: this.deps.now(), ...m };
    setState({ chatterMessages: [...getState().chatterMessages, message].slice(-CHATTER_MESSAGE_LOG_MAX) });
  }

  /** Patch the fields a delivery-state update touches on the outbound
   *  message matching `msgId` (only ever `dir: 'tx'` — an inbound message has
   *  no delivery state of its own to track). A no-op if the message has
   *  scrolled out of the bounded ring already, or was never recorded (e.g. an
   *  ack for a session that predates this controller instance). */
  private patchSentMessage(msgId: number, patch: (m: ChatMessage) => Partial<ChatMessage>): void {
    const messages = getState().chatterMessages;
    const idx = messages.findIndex((m) => m.dir === 'tx' && m.msgId === msgId);
    if (idx === -1) return;
    const next = messages.slice();
    next[idx] = { ...next[idx], ...patch(next[idx]) };
    setState({ chatterMessages: next });
  }

  /** Patch `linkDb`/`grid` into the store's `chatterMembers` mirror for one
   *  peer, in place, without touching any other field or member — display
   *  only, mirrors what `toStoreMembers` will recompute from the same
   *  `heardGrid` the next time `onStateChange` fires. Inserts a minimal
   *  entry (matching the shape `onStateChange` would produce) if the peer
   *  isn't in the mirror yet — e.g. its very first probe. */
  private mergeMemberLinkInfo(deviceId: number, info: { linkDb: number; grid: number[] }): void {
    const members = getState().chatterMembers;
    const idx = members.findIndex((m) => m.deviceId === deviceId);
    const next = members.slice();
    if (idx === -1) {
      next.push({ deviceId, lastHeardMs: this.deps.now(), linkDb: info.linkDb, grid: info.grid });
    } else {
      next[idx] = { ...next[idx], linkDb: info.linkDb, grid: info.grid };
    }
    setState({ chatterMembers: next });
  }

  private async doPlayAndMute(getAudio: () => Promise<{ samples: Float32Array; sampleRate: number }>): Promise<void> {
    const { samples, sampleRate } = await getAudio();
    this.worker.setRxMuted(true);
    try {
      // Route to the SELECTED speaker, not the system default. Chatter is an
      // over-the-air protocol: playing out of whatever the OS picked (a
      // headset, typically) means the room never hears the burst — and the
      // operator hears every probe in their ears instead. Read at play time
      // so a device change mid-session takes effect on the next burst.
      await this.player.play(samples, sampleRate, getState().selectedOutputId);
    } finally {
      await this.timeout(MUTE_TAIL_MS);
      this.worker.setRxMuted(false);
    }
  }

  private timeout(delayMs: number): Promise<void> {
    return new Promise((resolve) => { this.schedule(resolve, delayMs); });
  }

  /** Races `p` against a `delayMs` timer; if the timer wins, rejects with
   *  `message` instead of leaving the caller awaiting a promise that may
   *  never settle (e.g. `startListening()` while a mic permission prompt
   *  sits unanswered). Cancels the timer once either side settles, so a
   *  normal resolve/reject doesn't leave a stray timer armed in the fake
   *  clock (or a real one) for the rest of the run. */
  private async withTimeout<T>(p: Promise<T>, delayMs: number, message: string): Promise<T> {
    let cancel: (() => void) | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      cancel = this.schedule(() => reject(new Error(message)), delayMs);
    });
    try {
      return await Promise.race([p, timedOut]);
    } finally {
      cancel?.();
    }
  }

  /** Ensure the RX pipeline is running before an incoming transfer's band
   *  card arrives — the transmission's own card does the tuning (see
   *  HandshakeReceiver); `info` carries nothing else this adapter needs
   *  (the receive timeout is RoomProtocol's own timer). */
  private armFileRx(info: FileComingPayload): void {
    // bytes is the raw file payload size by design here (unlike control
    // messages' bytes, which is the true encoded wire size) — fileBytes is
    // what FILE_COMING actually advertises; the modulated wire size depends
    // on settings not yet known to this adapter.
    this.recordPacket({ dir: 'rx', kind: 'file', bytes: info.fileBytes });

    // RECONFIGURE, don't just start listening.
    //
    // The sender transmits with bandHandshake on: a band card on the fixed
    // handshake band announcing the negotiated band, then the file itself
    // there. The worker only builds a HandshakeReceiver — the thing that can
    // read that card and hop — when its config says bandHandshake, and the
    // receiver's config came from the bench UI, where that is an unrelated
    // user toggle that defaults off. So a receiver could arm, sit on whatever
    // band the bench happened to be set to, and never hear the file at all
    // while its control plane worked perfectly. Observed exactly that: a PC
    // decoded FILE_COMING and then nothing.
    //
    // The announced band seeds the config so a missed card is survivable;
    // per-tone bit-loading still arrives in the transmission's own link
    // profile, as on the normal handshake path.
    //
    // Not guarded by rxArmed either: every transfer negotiates its own
    // settings, so a second one must re-arm rather than inherit the first's.
    const s = getState();
    this.worker.configure(buildModemConfig({
      useOFDM: true,
      bandHandshake: true,
      pilotFreqHz: info.pilotFreqHz,
      toneStartHz: info.toneStartHz,
      toneCount: info.toneCount,
      trainingSettleSymbols: info.settleSymbols,
      symbolsPerSec: s.symbolsPerSec,
      musicalMode: false,
      diversityMode: false,
      hwSampleRate: this.worker.sampleRate,
      qamScaleOverride: s.qamScaleOverride,
    }));
    this.rxArmed = true;
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
    // No link profile. It exists to tell the receiver a per-tone bit loading
    // it could not otherwise know, and settingsPick now negotiates uniform
    // QPSK — which is also what buildModemConfig defaults the RECEIVER to
    // (`dataQamBits ?? 2`), so both ends already agree without being told.
    // Emitting it anyway added a full atomic frame of airtime and one more
    // thing that has to decode before any data can; a receiver that missed
    // it was left guessing. Restore this alongside real per-tone loading.
    cfg.emitLinkProfile = false;
    this.worker.configure(cfg);

    // bytes is the raw file payload size by design (unlike control messages'
    // bytes, which is the true encoded wire size) — the actual modulated
    // wire size isn't a simple formula here (depends on the negotiated
    // per-tone bit-loading in cfg.qamMap above), so this reports the file
    // size itself rather than approximating the wire size.
    // A rejection here used to vanish: startFileTx calls this with `void`, so
    // an encode or playback failure became an unhandled rejection —
    // chatterError stayed null and RoomProtocol sat in 'sending' until its own
    // deadline, presenting a dead transfer as a live one. On a phone, where
    // there is no console to check, that is the difference between a
    // diagnosable failure and a silent one.
    try {
      await this.playStreamAndMute(
        () => this.worker.startFileStream(pending.fileName, pending.data),
        {
          kind: 'file',
          peerId: 0,
          bytes: pending.data.byteLength,
          note: pending.fileName,
        },
      );
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      dlog('ROOM', { fileTxFailed: reason, name: pending.fileName, bytes: pending.data.byteLength }, { level: 'warn' });
      setState({ chatterError: `send failed: ${reason}` });
    }
  }
}

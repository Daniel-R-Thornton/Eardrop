/**
 * Store.ts — Simple atomic state store for the Eardrop UI.
 * app.ts pushes updates, React components subscribe.
 */

import { useSyncExternalStore } from 'react';
import { DEFAULT_CONFIG, OFDM_DEFAULTS, OFDM_TUNING } from '../modem/types';
import type { Run } from '../modem/protocol/captureTypes';
import type { RoomState } from '../modem/chatter/roomProtocol';

// ─── State Shape ──────────────────────────────────────

export interface DecoderInfo {
  inFrame: boolean;
  consecutiveSync: number;
  bitsCollected: number;
  pilotFreq: number;
  pilotAmplitude: number;
  signalToNoise: number;
  noiseFloor: [number, number, number, number];
  energies: [number, number, number, number];
  relI: [number, number, number, number];
  relQ: [number, number, number, number];
  bitPattern: number;
  thresholds: [number, number, number, number];
  noiseFrames: number;
  blocksDecoded: number;
  blocksCrcFailed: number;
  noiseAvg: number;
}

export interface BlockLogEntry {
  type: string;
  len: number;
  time: number;
}

export interface SpeedTestResult {
  toneCount: number;
  micGain: number;
  pilotFreqHz: number;
  qamBits: 2 | 4 | 6;
  qamScale: number;
  success: boolean;
  passes: number;
  framesOk: number;
  framesTotal: number;
  /** Valid frames excluding PROFILE — the ones that prove data got through. */
  dataFramesOk?: number;
  merDb: number | null;
  evmPct: number | null;
  throughputKbps: number;
  durationMs: number;
  /** Staged MER of the last failed frame — signal quality when nothing decoded. */
  rawMerDb?: number | null;
  /** How far the receiver got: 0 nothing … 4 profile decoded. */
  syncLevel?: number;
  /** Composite score the auto-tune hunt maximises (higher = better). */
  score?: number;
  /** Which hunt axis this trial was probing ('grid' for an exhaustive sweep). */
  phase?: string;
  /** The debug ring saturated, so frame counts parsed from it may undercount. */
  logTruncated?: boolean;
  /** Repeats run at this point, when the path is noisy enough to need them. */
  attempts?: number;
  /** Scores of every attempt, worst-first ranking uses the minimum. */
  attemptScores?: number[];
}

export interface AppState {
  sendStatus: { type: string; msg: string } | null;
  recvStatus: { type: string; msg: string } | null;
  isListening: boolean;
  isSending: boolean;
  isPlaying: boolean;
  selectedFile: { name: string; size: number } | null;
  /** Persisted mic (input) device ID */
  selectedInputId: string;
  /**
   * Persisted mic LABEL, which is what actually survives.
   *
   * Chrome's deviceId is a salted hash whose salt rotates across restarts,
   * profile changes and permission changes, and on Linux device re-enumeration
   * can change it too — one debugging session saw four ids for two physical
   * mics. A stale id degrades silently into "browser default", so the label is
   * the durable handle and the id is resolved from it at start time (see
   * resolveInputDevice). It is also what per-device calibrations are keyed by.
   */
  selectedInputLabel: string;
  /** Persisted speaker (output) device ID */
  selectedOutputId: string;
  receivedFiles: Array<{ name: string; url: string; size: number }>;
  progress: number; // 0-100
  debug: DecoderInfo | null;
  blockLog: BlockLogEntry[];
  debugSamples: Float32Array | null;
  txSamples: Float32Array | null;
  debugVisible: boolean;
  txPayload: { name: string; bytes: string } | null;
  rxPayload: { name: string; bytes: string } | null;
  micLevel: number; // dB
  toneEnergies: number[];
  /** User-configurable pilot frequency */
  pilotFreqHz: number;
  /** Musical mode — use nice note intervals for data tones */
  musicalMode: boolean;
  /** User-configurable amplitude threshold ratio (lower = more sensitive) */
  ampThresholdRatio: number;
  /** Sync all-four-strong multiplier (lower = easier sync) */
  syncStrongMultiplier: number;
  /** Acoustic sweep test results */
  sweepResults: Array<{ freq: number; energy: number }> | null;
  /** Active tones: 2 or 4 */
  toneCount: number; // 2, 4, or 8
  /** OFDM: Hz above the pilot where the first data tone sits (start of the
   *  tone grid). Lower values move the grid into a better-behaved part of
   *  the speaker/mic response. Default 2000 = today's behavior. */
  toneStartHz: number;
  /**
   * Per-tone pre-emphasis calibrations, keyed by microphone LABEL, then by
   * `pilotFreqHz:toneStartHz:toneCount`.
   *
   * Keyed by DEVICE because the measured response belongs to the microphone —
   * four mics on this machine measured a flat band, a 17 dB tilt, a 21 dB comb
   * and a 20 dB tilt respectively. Keyed by BAND because the gains are per tone
   * INDEX, so reusing a set across a different grid would apply them to the
   * wrong frequencies. Values are linear multipliers, mean-unity in dB.
   *
   * By LABEL and not deviceId: Chrome's deviceId is a salted hash whose salt
   * rotates, so id-keyed entries silently stop matching and the correction just
   * stops being applied — with no error and no visible difference except a
   * response that looks like it changed. Older id-keyed entries are still read
   * as a fallback (see calibrationKeyFor) so nothing already measured is lost.
   */
  toneGainsByDevice: Record<string, Record<string, number[]>>;
  /**
   * Settle symbols the TX emits and the RX discards before training (see
   * OFDMEngine.generateSettleSymbols). Exposed because the right value is
   * hardware-dependent and pulls two ways: longer lets the output chain recover
   * from the chirp, but a longer preamble also gives an adaptive microphone DSP
   * more time to adapt to it. Both effects were measured on this machine.
   */
  trainingSettleSymbols: number;
  /** Phase 3 data-tone constellation, applied to ALL tones: 2=QPSK (default), 4=16-QAM, 6=64-QAM */
  dataQamBits: 2 | 4 | 6;
  /** Optional override for the fixed per-tone TX scale used in QAM data symbols.
   *  Higher = louder QAM data. Leave undefined for the default crest-factor scale. */
  qamScaleOverride?: number;
  /** Hail Mary diversity mode: all tones carry same bit for consensus */
  diversityMode: boolean;
  /** Enable experimental OFDM/QPSK (cyclic‑prefix) path */
  useOFDM: boolean;
  /** Symbols per second (baud rate) */
  symbolsPerSec: number;
  /** FFT spectrum data for waterfall display */
  fftSpectrum: Float32Array | null;
  /** Raw mic peak (0-1) for VU meter */
  rawPeak: number;
  /** Noise floor estimate for VU reference */
  noiseFloorDb: number;
  /** Debug trace log — raw per-frame BPSK data */
  debugTrace: Array<{
    sym: number;
    rawI: number[];
    bits: number[];
    frameHex: string;
    blockEvent?: string;
  }>;
  /** Diagnostic messages from last receive cycle */
  diagMessages: string[];
  /** Theme: 'dark' | 'light' */
  theme: 'dark' | 'light';
  /** Bit-level debug stream from decoder */
  debugByteStream: Array<{ byte: number; phase: string; bitOffset: number }>;
  /** Sentinel scanner shift register history */
  sentinelScan: Array<{ bit: number; shiftReg: number; matched: boolean; phase: string }>;
  /** Mic diagnostic snapshot */
  micDiag: {
    rmsDb: number;
    peak: number;
    zeroCrossingRate: number;
    ctxState: string;
    sampleRate: number;
    calibrationFactor: number;
    recentSamples: Float32Array;
  } | null;
  /** Playback volume multiplier (1-10, default 2) */
  playbackVolume: number;
  /** Mic pre-amp gain (1-20, default 1) */
  micGain: number;
  /** When true, play the WAV audio out loud while feeding it through the decoder */
  playWavDuringDecode: boolean;
  /** Captured demo-encode run (per-frame stage bundles) for the pipeline view */
  demoRun: Run | null;
  /** Pipeline playback pace */
  demoSpeed: 'realtime' | 'slow' | 'step';
  /** Which captured frame the pipeline is focused on */
  demoFrameIndex: number;
  /** Which pipeline stage is currently highlighted */
  demoStageIndex: number;
  /** True while the OFDM speed/auto-tune sweep is running */
  speedTestRunning: boolean;
  /** Progress of the current speed sweep: current/total combos */
  speedTestProgress: { current: number; total: number } | null;
  /** Per-combo results from the last speed sweep */
  speedTestResults: SpeedTestResult[];
  /** Highest-scoring combo from the last speed sweep */
  speedTestBest: SpeedTestResult | null;
  /** When true, speed test feeds samples straight back to the RX (no speaker/mic) */
  speedTestLoopback: boolean;
  /**
   * 'grid' = exhaustive sweep of every combo.
   * 'hunt' = coordinate descent: climb one variable to a local maximum, then
   * move to the next, repeating passes until nothing improves.
   */
  speedTestMode: 'grid' | 'hunt';
  /**
   * Band handshake: TX sends its preamble + profile on the fixed
   * OFDM_HANDSHAKE band and announces the real band in the v2 profile; RX
   * only ever listens on the handshake band. Kills the "match pilot/tone
   * start in both windows by hand" requirement.
   */
  bandHandshake: boolean;
  /**
   * Named "known-good" configuration snapshots, saved by the operator when a
   * combination works so it can be restored with one click after further
   * experimenting. Each preset holds the same fields the store persists
   * (CONFIG_FIELDS), including the per-device calibration gains.
   */
  configPresets: Record<string, Partial<AppState>>;

  // ─── Chatter room (see chatterController.ts / roomProtocol.ts) ───
  /** True once the operator has joined the room (until leaveRoom). */
  chatterOn: boolean;
  /** Mirrors RoomProtocol.state; 'off' when not in a room at all. */
  chatterState: RoomState | 'off';
  /** This device's randomly-picked room id (1-255); 0 until joined. */
  chatterDeviceId: number;
  /** Room roster, refreshed on every RoomProtocol state change. */
  chatterMembers: {
    deviceId: number;
    lastHeardMs: number;
    claimLowHz?: number;
    claimHighHz?: number;
    /** Mean of the member's heardGrid in dB relative to that grid's own peak.
     *  Higher (closer to 0) = stronger link. Undefined until a probe from
     *  them has been measured. */
    linkDb?: number;
    /** The 64-point REPORT_GRID response we measured from that member's
     *  probe, linear mags, normalized so max = 1. Undefined until measured. */
    grid?: number[];
  }[];
  /** Last RoomProtocol error, surfaced to the panel; null when clean. */
  chatterError: string | null;
  /** Bounded ring of observed control-plane events, newest last, for the room-mode packet log. */
  chatterPackets: ChatterPacket[];
  /** performance.now() of this device's last own transmission (for the "talking" pulse); null until the first one. */
  chatterLastTx: number | null;
  /** Bounded ring of chat messages, newest last, for the room-mode text UI.
   *  Not wired up yet — the controller that pushes into this lives in a
   *  follow-up task. */
  chatterMessages: ChatMessage[];
}

/** One chat message, newest LAST. Capped at CHATTER_MESSAGE_LOG_MAX.
 *  Display-only — never read by a protocol decision. */
export interface ChatMessage {
  /** Monotonic counter, unique per session — React key. */
  seq: number;
  /** Sender-assigned id, wraps at 256. Unique only per senderId. */
  msgId: number;
  senderId: number;
  /** 0 = the whole room. */
  targetId: number;
  text: string;
  tMs: number;
  dir: 'tx' | 'rx';
  /** Device ids that acknowledged this message. Meaningful for dir 'tx'. */
  ackedBy: number[];
  state: 'sending' | 'delivered' | 'failed';
}

export const CHATTER_MESSAGE_LOG_MAX = 100;

/** One observed control-plane event. Newest LAST. Capped at CHATTER_PACKET_LOG_MAX. */
export interface ChatterPacket {
  /** Monotonic counter, unique per session — React key. */
  seq: number;
  /** performance.now() at observation. */
  tMs: number;
  dir: 'tx' | 'rx';
  kind: 'probe' | 'welcome' | 'report' | 'fileComing' | 'bye' | 'file';
  /** Sender for rx, target for tx. 0 = broadcast, undefined = unknown. */
  peerId?: number;
  /** Wire bytes on the air for this event (probe = burst samples ÷ sampleRate → use 0). */
  bytes: number;
  /** Optional one-line detail, e.g. "32 tones @ 6900 Hz" or "grid −4.2 dB". */
  note?: string;
}

export const CHATTER_PACKET_LOG_MAX = 200;

const defaultDecoder: DecoderInfo = {
  inFrame: false,
  consecutiveSync: 0,
  bitsCollected: 0,
  pilotFreq: 0,
  pilotAmplitude: 0,
  signalToNoise: 0,
  noiseFloor: [0, 0, 0, 0],
  energies: [0, 0, 0, 0],
  relI: [0, 0, 0, 0],
  relQ: [0, 0, 0, 0],
  bitPattern: 0,
  thresholds: [0, 0, 0, 0],
  noiseFrames: 0,
  blocksDecoded: 0,
  blocksCrcFailed: 0,
  noiseAvg: 0,
};

const defaultState: AppState = {
  sendStatus: null,
  recvStatus: null,
  isListening: false,
  isSending: false,
  isPlaying: false,
  selectedFile: null,
  selectedInputId: '',
  selectedInputLabel: '',
  selectedOutputId: '',
  receivedFiles: [],
  progress: 0,
  debug: null,
  blockLog: [],
  debugSamples: null,
  txSamples: null,
  debugVisible: false,
  txPayload: null,
  rxPayload: null,
  micLevel: -80,
  toneEnergies: new Array(DEFAULT_CONFIG.toneCount).fill(0),
  pilotFreqHz: 600,
  musicalMode: false,
  ampThresholdRatio: 0.3,
  syncStrongMultiplier: 0.5,
  sweepResults: null,
  toneCount: DEFAULT_CONFIG.toneCount,
  toneGainsByDevice: {},
  trainingSettleSymbols: OFDM_TUNING.trainingSettleSymbols,
  toneStartHz: OFDM_DEFAULTS.toneStartHz,
  dataQamBits: 2,
  qamScaleOverride: undefined,
  diversityMode: false,
  useOFDM: false,
  symbolsPerSec: 50,
  fftSpectrum: null,
  rawPeak: 0,
  noiseFloorDb: -80,
  debugTrace: [],
  diagMessages: [],
  theme: 'dark',
  debugByteStream: [],
  sentinelScan: [],
  micDiag: null,
  playbackVolume: 2,
  micGain: 1,
  playWavDuringDecode: false,
  demoRun: null,
  demoSpeed: 'slow',
  demoFrameIndex: 0,
  demoStageIndex: 0,
  speedTestRunning: false,
  speedTestProgress: null,
  speedTestResults: [],
  speedTestBest: null,
  speedTestLoopback: false,
  speedTestMode: 'hunt',
  bandHandshake: false,
  configPresets: {},
  chatterOn: false,
  chatterState: 'off',
  chatterDeviceId: 0,
  chatterMembers: [],
  chatterError: null,
  chatterPackets: [],
  chatterLastTx: null,
  chatterMessages: [],
};

// ─── Store ────────────────────────────────────────────

type Listener = () => void;

let state: AppState = { ...defaultState };
const listeners = new Set<Listener>();

// -------------------------------------------------------------------
// Persistence – store UI settings in localStorage so they survive reload.
// -------------------------------------------------------------------
const PERSIST_KEY = 'eardrop_ui_state';

/** Load persisted UI state from localStorage (if any) */
function loadPersistedState(): Partial<AppState> | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    // Basic sanity‑check – ensure required fields exist
    if (typeof parsed.toneCount !== 'number') return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * The configuration-related fields — everything else is transient. This one
 * list drives reload persistence, change detection in setState, AND what a
 * named config preset captures, so the three can never drift apart.
 */
const CONFIG_FIELDS = [
  'toneCount', 'toneStartHz', 'toneGainsByDevice', 'trainingSettleSymbols',
  'dataQamBits', 'qamScaleOverride', 'pilotFreqHz', 'musicalMode',
  'ampThresholdRatio', 'syncStrongMultiplier', 'diversityMode', 'useOFDM',
  'symbolsPerSec', 'micGain', 'playbackVolume', 'selectedInputId',
  'selectedInputLabel', 'selectedOutputId', 'theme', 'bandHandshake',
] as const satisfies readonly (keyof AppState)[];

/** Deep-cloned snapshot of the configuration fields of `s`. */
function snapshotConfig(s: AppState): Partial<AppState> {
  const snap: Record<string, unknown> = {};
  for (const k of CONFIG_FIELDS) {
    // structuredClone so nested objects (toneGainsByDevice) are frozen at
    // save time rather than aliased to live state.
    snap[k] = s[k] === undefined ? undefined : structuredClone(s[k]);
  }
  return snap as Partial<AppState>;
}

/** Save the current UI state (only the fields we want to persist) */
function persistState(s: AppState): void {
  try {
    const toSave: Partial<AppState> = {
      ...snapshotConfig(s),
      configPresets: s.configPresets,
    };
    localStorage.setItem(PERSIST_KEY, JSON.stringify(toSave));
  } catch (_) {
    // Silently ignore storage errors (e.g., in private mode)
  }
}

// Load persisted state at module init (if present)
const persisted = loadPersistedState();
if (persisted) {
  state = { ...state, ...persisted };
}


export function getState(): AppState {
  return state;
}

export function setState(update: Partial<AppState>): void {
  state = { ...state, ...update };
  // Only persist when a persisted config key actually changed.
  if (CONFIG_FIELDS.some((k) => k in update) || 'configPresets' in update) {
    persistState(state);
  }
  listeners.forEach((fn) => fn());
}

// ─── Named config presets ─────────────────────────────
// One-click "get back to the working state": snapshot the CONFIG_FIELDS
// (including per-device calibration gains) under a name, restore later
// through the normal setState path so everything downstream reconfigures
// exactly as if the controls were moved by hand.

export function saveConfigPreset(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  setState({
    configPresets: { ...state.configPresets, [trimmed]: snapshotConfig(state) },
  });
}

export function loadConfigPreset(name: string): void {
  const preset = state.configPresets[name];
  if (!preset) return;
  // Clone on the way out too — the loaded state must not alias the stored
  // preset, or later edits would silently rewrite it.
  setState(structuredClone(preset));
}

export function deleteConfigPreset(name: string): void {
  if (!(name in state.configPresets)) return;
  const next = { ...state.configPresets };
  delete next[name];
  setState({ configPresets: next });
}

export function resetState(): void {
  // Clear persisted config so a fresh reload starts from defaults.
  localStorage.removeItem(PERSIST_KEY);
  state = { ...defaultState };
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(defaultState),
  );
}

/**
 * Store.ts — Simple atomic state store for the Eardrop UI.
 * app.ts pushes updates, React components subscribe.
 */

import { useSyncExternalStore } from 'react';
import { DEFAULT_CONFIG } from '../modem/types';
import type { Run } from '../modem/protocol/captureTypes';

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
}

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

/** Save the current UI state (only the fields we want to persist) */
function persistState(s: AppState): void {
  try {
    const toSave: Partial<AppState> = {
      // Persist only the configuration‑related fields – everything else is transient.
      toneCount: s.toneCount,
      dataQamBits: s.dataQamBits,
      qamScaleOverride: s.qamScaleOverride,
      pilotFreqHz: s.pilotFreqHz,
      musicalMode: s.musicalMode,
      ampThresholdRatio: s.ampThresholdRatio,
      syncStrongMultiplier: s.syncStrongMultiplier,
      diversityMode: s.diversityMode,
      useOFDM: s.useOFDM,
      symbolsPerSec: s.symbolsPerSec,
      micGain: s.micGain,
      playbackVolume: s.playbackVolume,
      selectedInputId: s.selectedInputId,
      selectedOutputId: s.selectedOutputId,
      theme: s.theme,
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
  const persistedKeys: Array<keyof AppState> = [
    'toneCount', 'dataQamBits', 'qamScaleOverride', 'pilotFreqHz', 'musicalMode', 'ampThresholdRatio',
    'syncStrongMultiplier', 'diversityMode', 'useOFDM', 'symbolsPerSec',
    'micGain', 'playbackVolume', 'selectedInputId', 'selectedOutputId', 'theme',
  ];
  if (persistedKeys.some((k) => k in update)) {
    persistState(state);
  }
  listeners.forEach((fn) => fn());
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

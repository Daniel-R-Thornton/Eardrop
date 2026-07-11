/**
 * Store.ts — Simple atomic state store for the Eardrop UI.
 * app.ts pushes updates, React components subscribe.
 */

import { useSyncExternalStore } from 'react';
import { DEFAULT_CONFIG } from '../modem/types';

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
    'toneCount', 'pilotFreqHz', 'musicalMode', 'ampThresholdRatio',
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

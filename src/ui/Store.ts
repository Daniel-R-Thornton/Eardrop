/**
 * Store.ts — Simple atomic state store for the Eardrop UI.
 * app.ts pushes updates, React components subscribe.
 */

import { useSyncExternalStore } from "react";

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
  receivedFiles: Array<{ name: string; url: string; size: number }>;
  progress: number; // 0-100
  debug: DecoderInfo | null;
  blockLog: BlockLogEntry[];
  debugSamples: Float32Array | null;
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
  toneCount: number;
}

const defaultDecoder: DecoderInfo = {
  inFrame: false, consecutiveSync: 0, bitsCollected: 0,
  pilotFreq: 0, pilotAmplitude: 0, signalToNoise: 0,
  noiseFloor: [0, 0, 0, 0], energies: [0, 0, 0, 0],
  relI: [0, 0, 0, 0], relQ: [0, 0, 0, 0], bitPattern: 0,
  thresholds: [0, 0, 0, 0], noiseFrames: 0,
  blocksDecoded: 0, blocksCrcFailed: 0, noiseAvg: 0,
};

const defaultState: AppState = {
  sendStatus: null,
  recvStatus: null,
  isListening: false,
  isSending: false,
  isPlaying: false,
  selectedFile: null,
  receivedFiles: [],
  progress: 0,
  debug: null,
  blockLog: [],
  debugSamples: null,
  debugVisible: false,
  txPayload: null,
  rxPayload: null,
  micLevel: -80,
  toneEnergies: [0, 0, 0, 0],
  pilotFreqHz: 412.5,
  musicalMode: false,
  ampThresholdRatio: 0.3,
  syncStrongMultiplier: 0.5,
  sweepResults: null,
  toneCount: 4,
};

// ─── Store ────────────────────────────────────────────

type Listener = () => void;

let state: AppState = { ...defaultState };
const listeners = new Set<Listener>();

export function getState(): AppState { return state; }

export function setState(update: Partial<AppState>): void {
  state = { ...state, ...update };
  listeners.forEach(fn => fn());
}

export function resetState(): void {
  state = { ...defaultState };
  listeners.forEach(fn => fn());
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useStore<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(defaultState),
  );
}

/** Shared modem configuration */
export interface ModemConfig {
  sampleRate: number;       // 3200
  symbolsPerSec: number;    // 25 -> 128 samples/symbol
  bitsPerFrame: number;     // 4
  pilotFreqHz: number;      // 62.5 Hz (below audible)
  pilotAmplitude: number;   // 0.125
  syncSymbols: number;      // 8 sync symbols for robust wake detection
}

/** 4 tone frequencies (Hz) — each carries 1 bit */
export const TONES = [500, 700, 900, 1100] as const;

export const DEFAULT_CONFIG: ModemConfig = {
  sampleRate: 3200,
  symbolsPerSec: 25,
  bitsPerFrame: 4,
  pilotFreqHz: 62.5,
  pilotAmplitude: 0,   // disabled — leaks into data-tone detectors
  syncSymbols: 10,
};

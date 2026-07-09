/**
 * Modem configuration and constants.
 *
 * Pilot-Relative Modem:
 *   - Encoder selects a pilot frequency (default 62.5 Hz)
 *   - Data tones are at pilotFreq + TONE_OFFSETS[t] (relative, not absolute)
 *   - Decoder scans to discover pilot frequency, tracks phase via PLL
 *   - All measurements (energy, phase) are relative to the tracked pilot
 *   - 2 bits per tone: amplitude (ON/OFF) + phase (0°/180° BPSK)
 */

export interface ModemConfig {
  /** Modem sample rate (3200 Hz) */
  sampleRate: number;
  /** Symbol rate (25 sym/s → 128 samples/symbol) */
  symbolsPerSec: number;
  /** Bits per frame (8 = 2 bits × 4 tones: amplitude + phase) */
  bitsPerFrame: number;

  // ── Pilot ──
  /** Whether the pilot tone is enabled */
  pilotEnabled: boolean;
  /** Pilot frequency in Hz (configurable — default 237.5) */
  pilotFreqHz: number;
  /** Musical mode — use pleasant note intervals for data tones */
  musical: boolean;
  /** Pilot amplitude (0.125 = leaves headroom for 4 data tones at 0.2 each) */
  pilotAmplitude: number;

  // ── Data tones (relative to pilot) ──
  /** Data tone amplitude (0.2 ensures pilot + 4×0.2 = 0.925 < 1.0) */
  dataToneAmplitude: number;
  /** Amplitude threshold ratio relative to pilot: tone ON if energy > pilotAmp * this */
  amplitudeThresholdRatio: number;
  /** Number of active tones (2 or 4) */
  toneCount: number;
  /** Hail Mary mode: 1 tone data, all tones repeat same bit for consensus voting */
  diversityMode: boolean;
  /** Amplitude threshold ratio relative to pilot: tone ON if energy > pilotAmp * this */
  ampThresholdRatio?: number;
  /** Sync strong multiplier for frame sync sensitivity */
  syncStrongMultiplier?: number;

  // ── Sync / framing ──
  /** Number of sync symbols in the sync burst */
  syncSymbols: number;
  /** Sentinel pattern (unused — actual sentinel from getSentinel() in framing.ts) */
  sentinel: number;

  // ── Squawk calibration ──
  /** How many data symbols between squawk beacons (0 = disabled) */
  squawkIntervalSymbols: number;
  /** How many symbols per squawk packet */
  squawkSymbols: number;

  // ── ECC ──
  /** Error correction scheme */
  eccScheme: 'hamming74' | 'bch3116';
  /** Interleaver depth */
  interleaveDepth: number;

  // ── Payload framing ──
  /** Symbols per payload block (before next squawk/framing overhead) */
  payloadBlockSymbols: number;
}

/** Tone frequency offsets from pilot (standard mode).  Speaker-safe musical frequencies below 800 Hz.
 *  Nominal tones: 475, 525, 625, 775 Hz — near B4, C5, D#5/Eb5, G5.
 *  All are integer-cycle multiples (f/25): 19, 21, 25, 31 cycles at 3200 Hz.
 */
export const TONE_OFFSETS: [number, number, number, number] = [
  237.5, 487.5, 737.5, 1087.5,
] as const;

/** Musical mode offsets — playable intervals from pilot */
export const MUSICAL_OFFSETS: [number, number, number, number] = [
  87.5,
  162.5,
  287.5,
  487.5, // 500, 575, 700, 900 Hz — B4, D5, F5, A5
] as const;

/** Get offsets based on musical mode */
export function getOffsets(musical: boolean): [number, number, number, number] {
  return musical ? MUSICAL_OFFSETS : TONE_OFFSETS;
}

/** Compute absolute tone frequencies for a given pilot frequency */
export function getToneFreqs(
  pilotFreqHz: number,
  musical = false,
): [number, number, number, number] {
  const offs = getOffsets(musical);
  return [
    pilotFreqHz + offs[0],
    pilotFreqHz + offs[1],
    pilotFreqHz + offs[2],
    pilotFreqHz + offs[3],
  ];
}

/** Get default tone frequencies (using DEFAULT_CONFIG pilot freq) */
export function getDefaultToneFreqs(musical = false): [number, number, number, number] {
  return getToneFreqs(DEFAULT_CONFIG.pilotFreqHz, musical);
}

/** Tone colors for debug display (one per tone index) */
export const TONE_COLORS = ['#4a9eff', '#ff6b4a', '#5eead4', '#f472b6'];

/**
 * 16-bit warble code for preamble detection.
 * Each bit selects the warble frequency for a 32-sample interval:
 *   0 = pilotFreq - 50 Hz
 *   1 = pilotFreq + 50 Hz
 * The decoder cross-correlates against this code to reject noise.
 */
export const WARBLE_CODE = 0xac94; // 1010 1100 1001 0100
/** Minimum bits (out of 16) that must correlate to accept warble detection */
export const WARBLE_CODE_THRESHOLD = 12;

export const DEFAULT_CONFIG: ModemConfig = {
  sampleRate: 3200,
  symbolsPerSec: 25,
  bitsPerFrame: 8,

  pilotEnabled: true,
  pilotFreqHz: 412.5,
  musical: false,
  pilotAmplitude: 0.4,

  dataToneAmplitude: 0.5,
  amplitudeThresholdRatio: 0.3,
  toneCount: 4,
  diversityMode: false,

  syncSymbols: 10,

  sentinel: 0x8888, // unused — actual framing uses getSentinel() in framing.ts

  squawkIntervalSymbols: 32,
  squawkSymbols: 8,

  eccScheme: 'bch3116',
  interleaveDepth: 8,

  payloadBlockSymbols: 32,
};

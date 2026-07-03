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

  // ── Sync / framing ──
  /** Number of sync symbols in the sync burst */
  syncSymbols: number;
  /** 16-bit sentinel pattern (all OFF-tone phase bits = 0 to match decoder convention) */
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

/** Tone frequency offsets from pilot (standard mode).  Default pilot 237.5+437.5=675, etc. */
export const TONE_OFFSETS: [number, number, number, number] = [
  437.5, 637.5, 837.5, 1037.5,
] as const;

/** Musical mode offsets — C5, E5, G5, C6 intervals from pilot (using 25 Hz bins for frame alignment) */
export const MUSICAL_OFFSETS: [number, number, number, number] = [
  300, 425, 550, 775,  // pilot+300≈C5, +425≈E5, +550≈G5, +775≈C6 (nearest 25Hz bins)
] as const;

/** Get offsets based on musical mode */
export function getOffsets(musical: boolean): [number, number, number, number] {
  return musical ? MUSICAL_OFFSETS : TONE_OFFSETS;
}

/** Compute absolute tone frequencies for a given pilot frequency */
export function getToneFreqs(pilotFreqHz: number, musical = false): [number, number, number, number] {
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
export const TONE_COLORS = ["#4a9eff", "#ff6b4a", "#5eead4", "#f472b6"];

export const DEFAULT_CONFIG: ModemConfig = {
  sampleRate: 3200,
  symbolsPerSec: 25,
  bitsPerFrame: 8,

  pilotEnabled: true,
  pilotFreqHz: 237.5,
  musical: false,
  pilotAmplitude: 0.4,

  dataToneAmplitude: 0.5,
  amplitudeThresholdRatio: 0.3,

  syncSymbols: 10,

  sentinel: 0x8888,  // block format: 0x88 high nibble 0x8 → amp bits [1,0,0,0] → frame 0x80

  squawkIntervalSymbols: 32,
  squawkSymbols: 8,

  eccScheme: 'bch3116',
  interleaveDepth: 8,

  payloadBlockSymbols: 32,
};

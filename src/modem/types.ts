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
  /** Modem sample rate in Hz (default: 3200 Hz for backward compatibility). 
   *  Can be set to native audio rates (44100, 48000, etc.) for higher throughput.
   */
  sampleRate: number;
  /** Symbol rate (samples per symbol is derived from sampleRate and FFT size). */
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
  /** OFDM: Hz above the pilot where the first data tone sits (start of the
   *  tone grid). Lower values pull the whole grid into a better part of the
   *  speaker/mic frequency response. Default OFDM_DEFAULTS.toneStartHz
   *  (2000) reproduces today's behavior. Must stay >= MIN_TONE_START_HZ so
   *  the lowest data tone can't alias onto the pilot. */
  toneStartHz?: number;

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
  100, 200, 300, 400, // 100Hz spacing — optimal from interference sweep
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

/** Tone colors for debug display — spectral ramp, low → high frequency (8 tones) */
export const TONE_COLORS = [
  '#4a9eff', // t0 blue
  '#35d0c5', // t1 teal
  '#3dff88', // t2 green
  '#b8e34a', // t3 lime
  '#ffd23d', // t4 yellow
  '#ff9838', // t5 orange
  '#ff5c5c', // t6 red
  '#e06bff', // t7 violet
];

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
  sampleRate: 3200, // Modem native rate. App sets audioCtx.sampleRate at runtime for Encoder/Decoder path.
  symbolsPerSec: 25,
  bitsPerFrame: 8,

  pilotEnabled: true,
  pilotFreqHz: 600, // Optimal: in 300-1500Hz sweet spot, tones at 700/800/900/1000Hz
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

/** OFDM symbol timing — defined in TIME so any hardware rate works. */
export const OFDM_SYMBOL_MS = 20; // FFT-equivalent window: 50 Hz tone grid
export const OFDM_CP_MS = 5; // cyclic prefix / timing guard

export function ofdmSamples(sampleRate: number): {
  fftSamples: number;
  cpSamples: number;
  symSamples: number;
} {
  const fftSamples = Math.round((sampleRate * OFDM_SYMBOL_MS) / 1000);
  const cpSamples = Math.round((sampleRate * OFDM_CP_MS) / 1000);
  return { fftSamples, cpSamples, symSamples: fftSamples + cpSamples };
}

/** Native-rate OFDM defaults — tones in the 2–4 kHz hardware sweet spot. */
export const OFDM_DEFAULTS = {
  pilotFreqHz: 1900,
  pilotAmplitude: 2.0,
  toneStartHz: 2000,
  toneSpacingHz: 50,
  toneCount: 32,
} as const;

/**
 * OFDM tuning levers — every knob that trades robustness for speed, in one
 * place. Invariant: syncBurstSymbols >= syncMinFrames + 2 + trainingSymbols
 * (detection consumes syncMinFrames windows, boundary alignment can skip up
 * to ~1 symbol, and training needs trainingSymbols full sync symbols).
 */
export const OFDM_TUNING = {
  /** TX: repeated all-zero-phase symbols prepended to every transmission */
  syncBurstSymbols: 24,
  /** RX: sync symbols consumed to train per-tone channel estimates */
  trainingSymbols: 12,
  /** RX: consecutive above-threshold windows required to declare sync */
  syncMinFrames: 8,
  /** TX: trailing silence symbols after the tail frame */
  tailSilenceSymbols: 6,
  /** RX: minimum cyclic-prefix correlation score to accept a sync boundary */
  cpCorrelationMinScore: 0.35,
  /** RX: minimum CP correlation sharpness (peak / mean) to reject flat hum */
  cpCorrelationMinSharpness: 1.1,
  /** TX/RX: known QAM-scale reference symbols inserted after the profile
   *  frames (only when the announced qamMap uses any tone above QPSK) —
   *  every tone carries its order's outer-corner constellation point at
   *  the real data-path qamScale, so RX can re-fit per-tone channel
   *  estimates at the ACTUAL data amplitude (see
   *  OFDMQPSKDemodulator.calibrateQamRef). */
  qamRefSymbols: 4,
  /** TX: peak amplitude of the chirped sync burst (constant-envelope, so this
   *  is every sample's magnitude). Reduced from 1.0 (full-scale) to avoid
   *  driving the transmitting speaker's limiter/compressor hard for the full
   *  600ms burst duration, whose release can smear into the channel-training
   *  window that follows. Detection is a normalized cross-correlation (see
   *  rxEngine `normScore`), so this is scale-invariant to detection. */
  chirpAmplitude: 0.6,
} as const;

/**
 * Verify that the OFDM sync burst is long enough for detection,
 * boundary alignment slack, and channel training.
 */
export function checkOfdmTuningInvariants(): void {
  if (
    OFDM_TUNING.syncBurstSymbols <
    OFDM_TUNING.syncMinFrames + 2 + OFDM_TUNING.trainingSymbols
  ) {
    throw new Error(
      `OFDM_TUNING invariant violated: syncBurstSymbols (${OFDM_TUNING.syncBurstSymbols}) must be >= syncMinFrames (${OFDM_TUNING.syncMinFrames}) + 2 + trainingSymbols (${OFDM_TUNING.trainingSymbols})`,
    );
  }
}
checkOfdmTuningInvariants();

/**
 * Minimum Hz separation between the pilot and the first (lowest) data tone.
 * Guards against a toneStartHz config that would alias the lowest data tone
 * onto the pilot itself — shared by every ofdmToneFrequencies() caller
 * (TX and RX alike) so the clamp can never diverge between the two sides.
 */
export const MIN_TONE_START_HZ = 600;

export function ofdmToneFrequencies(opts: {
  toneCount: number;
  pilotFreqHz?: number;
  startHz?: number;
  spacingHz?: number;
}): Float32Array {
  const pilot = opts.pilotFreqHz ?? 0;
  const rawStart = opts.startHz ?? OFDM_DEFAULTS.toneStartHz;
  const start = Math.max(MIN_TONE_START_HZ, rawStart);
  const spacing = opts.spacingHz ?? OFDM_DEFAULTS.toneSpacingHz;
  const freqs = new Float32Array(opts.toneCount);
  for (let t = 0; t < opts.toneCount; t++) freqs[t] = pilot + start + t * spacing;
  return freqs;
}

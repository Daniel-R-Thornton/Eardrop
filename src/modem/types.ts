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
 * The FIXED handshake config — the only band knowledge a receiver needs when
 * bandHandshake is enabled. TX transmits chirp + preamble + the band card
 * here (see bandCard.ts); the card announces the real band and both sides
 * hop, the receiver by swapping in a fresh engine (HandshakeReceiver).
 *
 * Values chosen from bench measurements, not aesthetics: 8 QPSK tones at
 * 6900-7250 Hz decoded at MER 21-22 dB on the weakest hardware measured (a
 * laptop DMIC + micro-speaker) — QPSK needs ~10 dB, so the handshake carries
 * ~11 dB of margin. Few tones = maximum power per tone. CHANGING ANY VALUE
 * BREAKS COMPATIBILITY with every deployed receiver — this is a wire
 * constant, not a tuning knob.
 *
 * gapSymbols: silence between the handshake segment and the target-band
 * transmission. The post-hop engine must meet the target chirp the way a
 * cold receiver does — quiet first. Bench 2026-08-03: without the gap, the
 * chirp correlator fired on the card symbols' 1850 Hz pilot (the template
 * sweeps through 1850) at norm ~0.15, the CP probe then VALIDATED the false
 * detect because cards are real OFDM with real cyclic prefixes, and the
 * engine trained during the actual chirp — target tones measured ~1e-4 and
 * the transfer was dead before it started.
 */
export const OFDM_HANDSHAKE = {
  pilotFreqHz: 1850,
  toneStartHz: 5050, // tones at 6900-7250 Hz
  toneCount: 8,
  gapSymbols: 8,
} as const;

/**
 * OFDM tuning levers — every knob that trades robustness for speed, in one
 * place.
 *
 * INVARIANT:
 *   syncBurstSymbols >= syncMinFrames + 2 + trainingSettleSymbols + trainingSymbols
 *
 * Detection consumes syncMinFrames windows, boundary alignment can skip up to
 * ~1 symbol, then the RX discards trainingSettleSymbols and accumulates
 * trainingSymbols. Anything short of that and the receiver runs off the end of
 * the burst and starts consuming DATA symbols as training — the frame is then
 * simply lost, with no error that points at the cause. Adding
 * trainingSettleSymbols without raising syncBurstSymbols did exactly that and
 * broke four decode tests, so the invariant is asserted in tuning.test.ts.
 */
export const OFDM_TUNING = {
  /** TX: repeated sync symbols prepended to every transmission, and the pool
   *  the ENERGY-sync path reads its training out of. Sized by the invariant
   *  above: 8 + 2 + 16 + 12 = 38, rounded up to 40. */
  syncBurstSymbols: 40,
  /**
   * Centre frequency of the sync chirp, in Hz. DECOUPLED from pilotFreqHz.
   *
   * The chirp used to be centred on the pilot, which was harmless while the
   * pilot sat far below the data band — but the pilot has to move close to the
   * band for a different reason (the drift correction extrapolates pilot phase
   * by toneFreq/pilotFreq, so a pilot at 1850 with tones at 8850 amplifies a
   * two-sample timing error into ~148 degrees of rotation). Moving the pilot to
   * 6300 cut measured drift from -291 to -11, and dragged the chirp to
   * 6200-6400 Hz with it.
   *
   * That broke the link a different way. The chain compresses PER BAND (the
   * chain diagnostic showed a single loud tone squashed 14 dB while a 40-tone
   * grid of the same total power was untouched), and the chirp is the loudest
   * thing in the transmission. Sitting it next to the data band compressed that
   * band and then released across the frame: received pilot went 0.367 during
   * training to 2.67 during data, a 17 dB swing, and no data frame decoded.
   *
   * So the chirp keeps its own low band, well away from any usable data
   * frequency. It only provides coarse timing (see rxEngine's chirpCorrelate),
   * so its frequency is unconstrained by anything else. TX and RX must agree —
   * both read this value, and a mismatch makes the correlation template the
   * wrong shape and nothing syncs.
   */
  chirpCenterHz: 1850,
  /**
   * TX: chirp duration, in symbol periods. DECOUPLED from syncBurstSymbols.
   *
   * These were the same number, which coupled two unrelated things: raising the
   * settle period forces syncBurstSymbols up (see the invariant), which would
   * then have LENGTHENED the chirp — and since the chirp is the loudest thing in
   * the transmission and the settle period exists to recover from it, that is
   * exactly backwards. 32 symbols = 800 ms, the length at which chirp
   * correlation measured norm ~0.70.
   */
  chirpSymbols: 32,
  /** RX: sync symbols consumed to train per-tone channel estimates */
  trainingSymbols: 12,
  /**
   * Sync symbols transmitted BEFORE the ones used for training, and discarded
   * by the RX — a settling period so channel estimates are taken with the
   * transmitting chain in the same gain state the data will see.
   *
   * The 600 ms chirp drives the output limiter, and training used to begin in
   * the very next symbol. Measured over the air: the received pilot was 8.6 dB
   * stronger during data than during training at 32 tones (9.7 dB at 40), so
   * every channel estimate was taken against a compressed chain and the
   * reference then drifted for the whole transmission as the limiter released
   * (pilot gain correction walking to its 2.0 clamp). QPSK survives that —
   * phase-only decisions — while 16-QAM and above do not.
   *
   * Raised 8 -> 16 (200 ms -> 400 ms) on measurement: with the training burst
   * de-cohered, the received preamble-to-data step fell from 12.2 dB to 7.6 dB
   * but did not close. 7.6 dB is very close to the chirp-to-preamble peak ratio
   * (0.558 / 0.208 = 8.6 dB), which identifies the CHIRP as the remaining
   * compressor — and the envelope probe measured its recovery taking ~350 ms,
   * longer than the 200 ms of settle it had.
   *
   * Deliberately filled with ordinary sync symbols rather than SILENCE. Silence
   * would let the chain release all the way to its idle gain, which is not the
   * state the data occupies either; the goal is steady state at data level, not
   * an unloaded chain. These symbols are identical to the training ones, so the
   * only cost is preamble time.
   *
   * TX and RX must agree EXACTLY: TxEngine emits trainingSymbols + this, and
   * RxEngine discards this many windows after sync before it starts
   * accumulating. There is no room for slack in either direction — the receiver
   * finds the preamble/data boundary by COUNTING, nothing else. Emit more than
   * it consumes and the leftovers are demodulated as data (the giveaway is a
   * first data symbol reading ~0 degrees on every tone, since a training symbol
   * equalized by an estimate trained on training symbols is exactly that);
   * emit fewer and it consumes real data as training. A "slack" term was tried
   * to absorb boundary-alignment loss and did the former.
   */
  trainingSettleSymbols: 16,
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
  /**
   * TX/RX: expendable warm-up symbols inserted AFTER the QAM reference
   * symbols, before the header frame (only when some tone is above QPSK —
   * an all-QPSK waveform is unchanged). Near-corner magnitude, varying
   * pseudo-random per-tone phase/magnitude.
   *
   * Why: the received gain droops ~2.4 dB across the ~20 symbols following
   * the ref burst (Meteor Lake DMIC bench, 2026-07-31 — QD g 1.0 -> 0.76),
   * and header frames transmitted inside that transient failed RS decode at
   * MER ~13.8 while frames sent after it decoded at 15.9+. Warm-up placed
   * BEFORE the refs demonstrably does not preempt the transient (three runs:
   * gain flat at 1.0 through 40 warm-up symbols at two different loudness
   * levels, droop still started at the refs) — so the warm-up instead sits
   * after them and absorbs the transient. 40 symbols = ~1 s, roughly twice
   * the measured settle. The RX discards exactly this many windows between
   * the ref symbols and the first data window.
   */
  qamWarmupSymbols: 40,
  /**
   * TX: CEILING on the chirped sync burst's peak amplitude (constant-envelope,
   * so this is every sample's magnitude). generateChirpBurst takes
   * min(this, the preamble's coherent peak); the coherent peak sits above this
   * value at every tone count, so in practice this IS the chirp level.
   *
   * MEASURED, not derived (bench, 2026-07-31, 32 tones / pilot 1850): at 0.6
   * the chirp detected WORSE than at 0.12 — correlation norm 0.476-0.581 with
   * the peak pinned at the probe-window edge (idx=300) and handoff scores
   * ~0.87-0.93, vs norm 0.686-0.703, boundary within a few samples, and
   * handoff 0.947-0.969 at 0.12. The detection score is normalized by input
   * RMS, so a hotter chirp gains nothing once the acoustic chain compresses
   * on it; 0.12 is also the level at which the Jul-30 32-tone run decoded
   * payload end-to-end.
   */
  chirpAmplitude: 0.12,
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

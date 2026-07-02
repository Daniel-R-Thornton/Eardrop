/**
 * channel.ts — Acoustic channel simulator for modem testing.
 *
 * Sits between encoder output (Float32Array PCM) and decoder input.
 * Applies configurable impairments to simulate real-world acoustic paths:
 *
 *   AWGN        — Additive White Gaussian Noise at configurable SNR
 *   Doppler     — Frequency offset (carrier shift)
 *   Multi-path  — Delayed+attenuated copies (echo)
 *   Amp drift   — Slow volume fade/surge (simulates movement)
 *   Phase noise — Random phase jitter per sample
 *   Band-limit  — Low-pass filter (simulates speaker/mic FR)
 *   Impulse     — Random clicks/pops (simulates room noise)
 *   Attenuation — Scalar gain reduction
 */

import { debugLogger, STAGE, LOG_LEVEL } from "./debugger";

// ─── Random number helpers (no external deps) ────────

/** Simple seeded PRNG (mulberry32) for reproducible tests */
export function createRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller transform for Gaussian noise */
function gaussianNoise(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// ─── Channel Config ──────────────────────────────────

export interface ChannelConfig {
  /** Overall signal attenuation (gain). 1.0 = no change */
  attenuation: number;
  /** AWGN signal-to-noise ratio in dB. 0 = no noise, 40 = very clean */
  snrDb: number;
  /** Doppler frequency shift in Hz (positive = up, negative = down) */
  dopplerHz: number;
  /** Multi-path: array of [delay_samples, attenuation] pairs */
  echoes: Array<{ delaySamples: number; attenuation: number }>;
  /** Amplitude modulation: slow volume change { rate(Hz), depth(0-1) } */
  ampMod: { rateHz: number; depth: number };
  /** Phase noise standard deviation in radians */
  phaseNoiseStd: number;
  /** Low-pass filter cutoff frequency in Hz (0 = no filter) */
  lowpassCutoffHz: number;
  /** Impulse noise: random clicks at given rate (clicks per second) */
  impulseRate: number;
  /** Impulse noise amplitude (relative to signal peak) */
  impulseAmplitude: number;
  /** Random seed for reproducibility */
  seed: number;
}

export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  attenuation: 1.0,
  snrDb: 0,       // 0 = no noise added
  dopplerHz: 0,
  echoes: [],
  ampMod: { rateHz: 0, depth: 0 },
  phaseNoiseStd: 0,
  lowpassCutoffHz: 0,
  impulseRate: 0,
  impulseAmplitude: 0.5,
  seed: 42,
};

// ─── Channel Simulator ───────────────────────────────

export interface ChannelStats {
  inputSamples: number;
  outputSamples: number;
  appliedAttenuation: boolean;
  appliedNoise: boolean;
  noiseSnrDb: number;
  appliedDoppler: boolean;
  dopplerShiftHz: number;
  appliedEcho: boolean;
  echoCount: number;
  appliedAmpMod: boolean;
  appliedPhaseNoise: boolean;
  appliedLowpass: boolean;
  lowpassCutoffHz: number;
  appliedImpulse: boolean;
  impulseClicks: number;
}

export class Channel {
  private cfg: ChannelConfig;
  private rng: () => number;
  private stats: ChannelStats;
  private sampleRate: number;

  /** Phase accumulator for Doppler and phase noise */
  private dopplerPhase = 0;

  /** Low-pass filter state (1-pole) */
  private lpState = 0;

  /** Phase noise from previous sample (for smoothing) */
  private prevPhaseNoise = 0;

  /** Amp mod phase */
  private ampModPhase = 0;

  constructor(sampleRate = 3200, cfg?: Partial<ChannelConfig>) {
    this.sampleRate = sampleRate;
    this.cfg = { ...DEFAULT_CHANNEL_CONFIG, ...cfg };
    this.rng = createRng(this.cfg.seed);
    this.stats = this.resetStats();
  }

  /** Update channel config (reconfigures mid-test) */
  setConfig(cfg: Partial<ChannelConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
    this.rng = createRng(this.cfg.seed);
  }

  /** Get current config */
  getConfig(): Readonly<ChannelConfig> { return this.cfg; }

  /** Reset internal state (PLL, filters) for new transmission */
  reset(): void {
    this.dopplerPhase = 0;
    this.lpState = 0;
    this.prevPhaseNoise = 0;
    this.ampModPhase = 0;
    this.stats = this.resetStats();
  }

  /** Get accumulated stats */
  getStats(): Readonly<ChannelStats> { return { ...this.stats }; }

  /**
   * Process audio through the channel simulator.
   * @param input — Encoder output PCM samples
   * @returns — Decoder input PCM samples (with impairments)
   */
  process(input: Float32Array): Float32Array {
    this.reset();
    const n = input.length;
    const output = new Float32Array(n);
    const { cfg, sampleRate: sr } = this;

    // Pre-compute noise RMS level from signal RMS
    let signalRms = 0;
    if (cfg.snrDb > 0) {
      let sumSq = 0;
      for (let i = 0; i < n; i++) sumSq += input[i] * input[i];
      signalRms = Math.sqrt(sumSq / n);
      this.stats.appliedNoise = true;
    }

    // Pre-allocate echo buffer
    const maxDelay = cfg.echoes.length > 0
      ? Math.max(...cfg.echoes.map(e => e.delaySamples)) : 0;
    const echoBuf: number[] = new Array(maxDelay).fill(0);

    // Build low-pass filter coefficient if needed
    let lpAlpha = 0;
    if (cfg.lowpassCutoffHz > 0 && cfg.lowpassCutoffHz < sr / 2) {
      lpAlpha = 1 - Math.exp(-2 * Math.PI * cfg.lowpassCutoffHz / sr);
      this.stats.appliedLowpass = true;
    }

    // Impulse tick counter
    let impulseCounter = 0;
    let impulseInterval = 0;
    if (cfg.impulseRate > 0) {
      impulseInterval = Math.max(1, Math.round(sr / cfg.impulseRate));
    }

    for (let i = 0; i < n; i++) {
      let s = input[i];

      // 1. Attenuation
      if (cfg.attenuation !== 1.0) {
        s *= cfg.attenuation;
      }

      // 2. Amplitude modulation (slow volume drift)
      if (cfg.ampMod.rateHz > 0 && cfg.ampMod.depth > 0) {
        const mod = 1 - cfg.ampMod.depth * 0.5 +
          cfg.ampMod.depth * 0.5 * Math.sin(2 * Math.PI * this.ampModPhase);
        s *= mod;
        this.ampModPhase += cfg.ampMod.rateHz / sr;
        if (this.ampModPhase >= 1.0) this.ampModPhase -= 1.0;
      }

      // 3. Frequency shift (Doppler) — rotate sample by accumulating phase offset
      if (cfg.dopplerHz !== 0) {
        this.dopplerPhase += cfg.dopplerHz / sr;
        if (this.dopplerPhase >= 1.0) this.dopplerPhase -= 1.0;
        if (this.dopplerPhase < 0) this.dopplerPhase += 1.0;
        const theta = 2 * Math.PI * this.dopplerPhase;
        // Simple rotation: s * cos(theta) — this is a rough FM approximation
        s *= Math.cos(theta);
      }

      // 4. Phase noise
      if (cfg.phaseNoiseStd > 0) {
        const noise = gaussianNoise(this.rng) * cfg.phaseNoiseStd;
        // Smooth the phase noise
        const smoothNoise = noise * 0.3 + this.prevPhaseNoise * 0.7;
        this.prevPhaseNoise = smoothNoise;
        s *= Math.cos(smoothNoise);
      }

      // 5. Multi-path (echo)
      if (cfg.echoes.length > 0) {
        // Store current sample in echo buffer
        if (maxDelay > 0) echoBuf[i % maxDelay] = s;

        // Add echo contributions
        for (const echo of cfg.echoes) {
          if (echo.delaySamples > 0 && echo.delaySamples <= maxDelay) {
            const delayedIdx = (i - echo.delaySamples + maxDelay) % maxDelay;
            s += echoBuf[delayedIdx] * echo.attenuation;
          }
        }
      }

      // 6. Low-pass filter (1-pole IIR)
      if (lpAlpha > 0) {
        this.lpState = this.lpState + lpAlpha * (s - this.lpState);
        s = this.lpState;
      }

      // 7. AWGN
      if (cfg.snrDb > 0 && signalRms > 1e-12) {
        const noiseRms = signalRms / Math.pow(10, cfg.snrDb / 20);
        s += gaussianNoise(this.rng) * noiseRms;
      }

      // 8. Impulse noise
      if (impulseInterval > 0) {
        impulseCounter++;
        if (impulseCounter >= impulseInterval) {
          impulseCounter = 0;
          // Randomize interval slightly
          impulseInterval = Math.max(1,
            Math.round(sr / cfg.impulseRate) + Math.round(this.rng() * 10 - 5));
          s += gaussianNoise(this.rng) * cfg.impulseAmplitude;
          this.stats.impulseClicks++;
        }
      }

      output[i] = s;
    }

    // Update stats
    this.stats.inputSamples = n;
    this.stats.outputSamples = n;
    this.stats.appliedAttenuation = cfg.attenuation !== 1.0;
    this.stats.noiseSnrDb = cfg.snrDb;
    this.stats.appliedDoppler = cfg.dopplerHz !== 0;
    this.stats.dopplerShiftHz = cfg.dopplerHz;
    this.stats.appliedEcho = cfg.echoes.length > 0;
    this.stats.echoCount = cfg.echoes.length;
    this.stats.appliedAmpMod = cfg.ampMod.rateHz > 0 && cfg.ampMod.depth > 0;
    this.stats.appliedPhaseNoise = cfg.phaseNoiseStd > 0;
    this.stats.lowpassCutoffHz = cfg.lowpassCutoffHz;
    this.stats.appliedImpulse = cfg.impulseRate > 0;

    // Log channel config to debugger
    debugLogger.info(STAGE.CHANNEL, {
      snr_db: cfg.snrDb,
      doppler_hz: cfg.dopplerHz,
      echoes: cfg.echoes.length,
      amp_mod: cfg.ampMod.rateHz > 0 ? `${cfg.ampMod.rateHz}Hz` : 'off',
      phase_noise: cfg.phaseNoiseStd,
      lp_cutoff: cfg.lowpassCutoffHz,
      impulse_rate: cfg.impulseRate,
      clicks: this.stats.impulseClicks,
    }, `Channel: SNR=${cfg.snrDb}dB Doppler=${cfg.dopplerHz}Hz Echoes=${cfg.echoes.length}`);

    return output;
  }

  private resetStats(): ChannelStats {
    return {
      inputSamples: 0,
      outputSamples: 0,
      appliedAttenuation: false,
      appliedNoise: false,
      noiseSnrDb: 0,
      appliedDoppler: false,
      dopplerShiftHz: 0,
      appliedEcho: false,
      echoCount: 0,
      appliedAmpMod: false,
      appliedPhaseNoise: false,
      appliedLowpass: false,
      lowpassCutoffHz: 0,
      appliedImpulse: false,
      impulseClicks: 0,
    };
  }
}

/**
 * Decoder — Ported from TapewormFS lib/ofdm/src/modem_decoder.cpp
 *
 * Multi-tone energy detection decoder.
 * Uses Goertzel-style correlation on 4 frequencies.
 * Continuous pre-sync noise profiling for robust real-world operation.
 */
import { ModemConfig, TONES, DEFAULT_CONFIG } from "./types";
import { hammingDecode } from "../hamming";

export interface DecoderDebugInfo {
  /** Raw audio peak amplitude in this frame (0-1 range) */
  peakAmp: number;
  energies: [number, number, number, number];
  avg: number;
  noiseAvg: number;
  strong: boolean;
  consecutiveSync: number;
  inFrame: boolean;
  bitsCollected: number;
  noiseFloor: [number, number, number, number];
  noiseMax: [number, number, number, number];
  /** Per-tone thresholds after noise profiling */
  thresholds: [number, number, number, number];
  /** Per-tone energy fraction of total frame energy (0-1) */
  ratios: [number, number, number, number];
  /** Number of noise frames collected (ready when >= 30) */
  noiseFrames: number;
  /** Bit pattern decoded this frame (4 bits, one per tone: 0=below thr, 1=above) */
  bitPattern: number;
  /** End-detection SNR (avg / noiseFloor avg) */
  signalToNoise: number;
  /** Burst threshold used for strong/weak decision */
  burstThreshold: number;
  /** Frames since last strong detection */
  framesSinceStrong: number;
  /** Frames since last exit from data mode */
  framesSinceExit: number;
  /** Remaining sync symbols to skip */
  frameSkip: number;
}

export class Decoder {
  private cfg: ModemConfig;
  private sps = 128;

  // Buffer
  private buf: number[] = [];

  // State
  private inFrame = false;
  private consecutiveSync = 0;
  private frameSkip = 0;
  private bitCollector: number[] = [];
  private bitsCollected = 0;

  // ── Noise profiling (per frequency band) ──
  /** Running average noise floor */
  private noiseFloor: [number, number, number, number] = [0, 0, 0, 0];
  /** Running max noise (decays slowly) — catches transient noise */
  private noiseMax: [number, number, number, number] = [0, 0, 0, 0];
  /** How many noise frames we've sampled (pre-sync) */
  private noiseFrames = 0;

  // Accumulated decoded frames
  private decodedBytes: number[] = [];

  // Timeout-based end detection
  private framesSinceStrong = 0;
  private lastStrongBits = 0;
  /** Frames elapsed since last exiting data mode — enforces settling period */
  private framesSinceExit = 0;
  private dataFramesExecuted = 0;  // safety timeout — exit data mode after 150 frames (6s)
  private expectedTotalBytes = 0;  // length-based exit — 0 = unlimited, >0 = auto-stop after N bytes
  private totalBytesEmitted = 0;    // cumulative bytes emitted since entering data mode
  /** Reference peak amplitude measured during sync — used for adaptive end detection */
  private peakAmpRef = 0;
  /** Per-tone peak energy measured during sync preambles — used for burst auto-calibration */
  private syncPeak: [number, number, number, number] = [2e-10, 2e-10, 2e-10, 2e-10];
  /** Calibration complete flag — set after first sync entry */
  private calibrated = false;

  // Debug log
  public debugLog: DecoderDebugInfo[] = [];
  public logging = false;
  /** Bypass noise profiling — pre-fills noise floor so decoder is ready instantly */
  public fastSync = false;

  onFrame: ((data: Uint8Array) => void) | null = null;

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.sps = this.cfg.sampleRate / this.cfg.symbolsPerSec;
  }

  reset() {
    this.buf = [];
    this.inFrame = false;
    this.consecutiveSync = 0;
    this.frameSkip = 0;
    this.bitCollector = [];
    this.bitsCollected = 0;
    this.noiseFloor = [3e-10, 3e-10, 3e-10, 3e-10];
    this.noiseMax = [3e-10, 3e-10, 3e-10, 3e-10];
    this.noiseFrames = this.fastSync ? 25 : 0;
    this.decodedBytes = [];
    this.framesSinceStrong = 0;
    this.lastStrongBits = 0;
    this.syncPeak = [2e-10, 2e-10, 2e-10, 2e-10];
    this.framesSinceExit = 0;
    this.dataFramesExecuted = 0;
    this.expectedTotalBytes = 0;
    this.peakAmpRef = 0;
    this.debugLog = [];
  }

  /** Feed one audio sample */
  feedSample(sample: number) {
    this.buf.push(sample);
    if (this.buf.length < this.sps) return;

    // Grab one symbol window (128 samples)
    const window = this.buf.slice(0, this.sps);
    this.buf.splice(0, this.sps);

    // Energy at each tone using sin/cos correlation
    const energies: [number, number, number, number] = [0, 0, 0, 0];
    let total = 0;
    for (let t = 0; t < 4; t++) {
      energies[t] = this.detectEnergy(window, t);
      total += energies[t];
    }

    const avg = total / 4;
    const noiseAvg =
      (this.noiseFloor[0] + this.noiseFloor[1] + this.noiseFloor[2] + this.noiseFloor[3]) / 4;

    // ── Sync / burst detection ──
    // If we have a noise floor, require avg > noiseAvg * SYNC_MARGIN
    // If noise floor is near zero (silence), use absolute threshold
    // Acoustic path attenuates tone energies to ~1e-8–1e-6 vs 0.25 direct.
    // Use relative check (2x noise floor) — this adapts to any noise level.
    // Use auto-calibrated burst threshold based on measured sync peak
    const calibPeak = Math.max(...this.syncPeak);
    // Calibration only tightens: whichever is lower (noise-based or peak-based).
    const burstThresh = Math.min(noiseAvg * 0.8, Math.max(calibPeak * 0.10, 2e-11));
    // Sync preamble has ALL 4 tones ON simultaneously — room noise typically has
    // one dominant frequency. Require all 4 tones above 12% of frame energy.
    const allFourStrong = total > 1e-12
      && (energies[0] / total) > 0.08
      && (energies[1] / total) > 0.08
      && (energies[2] / total) > 0.08
      && (energies[3] / total) > 0.08;
    const isBurst = (avg > burstThresh) && allFourStrong;

    // ── Noise profiling (pre-sync) ──
    // Collect at least 25 noise samples (~1s) before trusting sync detection.
    // Without forced profiling, the first room-noise frame exceeds the absolute
    // floor and prevents the noise floor from ever being established.
    // Once profiling complete, FREEZE the noise floor — do not update it during
    // payload transmission. Signal energy corrupts the background reference.
    if (!this.inFrame) {
      this.framesSinceExit++;
      if (this.noiseFrames < 25) {
        this.noiseFrames++;

        const alpha = this.noiseFrames < 25 ? (1 / this.noiseFrames) : 0.1;
        for (let t = 0; t < 4; t++) {
          this.noiseFloor[t] = this.noiseFloor[t] * (1 - alpha) + energies[t] * alpha;
          if (energies[t] > this.noiseMax[t]) {
            this.noiseMax[t] = energies[t];
          } else {
            this.noiseMax[t] *= 0.9999;
          }
        }
      }
    }

    // ── Sync detection ──
    const strong = isBurst;

    // Track per-tone peak: only update during sustained bursts (≥3 consecutive),
    // so isolated room transients don't permanently poison the calibration.
    // Decay toward noise floor when quiet frames resume.
    if (strong && !this.inFrame && this.consecutiveSync >= 3) {
      for (let t = 0; t < 4; t++) {
        if (energies[t] > this.syncPeak[t]) {
          this.syncPeak[t] = energies[t];
        }
      }
    } else if (!strong && !this.inFrame) {
      // Decay calibration peak toward noise max after 20 quiet frames
      const noiseRef = Math.max(...this.noiseMax) * 2;
      for (let t = 0; t < 4; t++) {
        this.syncPeak[t] = Math.max(this.syncPeak[t] * 0.95, noiseRef);
      }
    }

    if (strong) {
      this.consecutiveSync++;
    } else {
      this.consecutiveSync = 0;
      if (!this.inFrame) this.frameSkip = 0;
    }

    // Debug log
    if (this.logging) {
      const thresholds: [number, number, number, number] = [0, 0, 0, 0];
      let bitPat = 0;
      for (let t = 0; t < 4; t++) {
        thresholds[t] = this.noiseFloor[t] * 4;
        if (energies[t] > this.noiseFloor[t] * 4) bitPat |= (1 << (3 - t));
      }
      const endNoiseAvg = (this.noiseFloor[0] + this.noiseFloor[1] + this.noiseFloor[2] + this.noiseFloor[3]) / 4;
      const snr = endNoiseAvg > 1e-12 ? avg / endNoiseAvg : 999;
      const bThresh = Math.min(noiseAvg * 0.8, Math.max(Math.max(...this.syncPeak) * 0.10, 2e-11));
      const totalEDbg = energies[0] + energies[1] + energies[2] + energies[3];
      this.debugLog.push({
        peakAmp: Math.max(...window.map(Math.abs)),
        energies,
        avg,
        ratios: totalEDbg > 1e-12
          ? energies.map((e: number) => e / totalEDbg) as [number, number, number, number]
          : [0, 0, 0, 0],
        noiseAvg,
        strong,
        consecutiveSync: this.consecutiveSync,
        inFrame: this.inFrame,
        bitsCollected: this.bitsCollected,
        noiseFloor: [...this.noiseFloor],
        noiseMax: [...this.noiseMax],
        thresholds,
        noiseFrames: this.noiseFrames,
        bitPattern: bitPat,
        signalToNoise: snr,
        burstThreshold: bThresh,
        framesSinceStrong: this.framesSinceStrong,
        framesSinceExit: this.framesSinceExit,
        frameSkip: this.frameSkip,
      });
      if (this.debugLog.length > 200) this.debugLog.shift();
    }

    // ── Enter data mode after sync detected ──
    // Require 3 consecutive sync frames (matching the sync symbol count) to
    // enter data mode. A single noisy frame shouldn't trigger it.
    // Also require noise profiling to be complete (>=25 frames / ~1s).
    // fastSync bypasses settling-period gate — enter on strong sync pattern
    // Require 6 of 8 sync symbols (robust wake detection)
    const canEnter = this.fastSync
      ? (this.consecutiveSync >= 8 && this.noiseFrames >= 25)
      : (this.consecutiveSync >= 8 && this.noiseFrames >= 25 && (this.framesSinceExit >= 50 || this.consecutiveSync >= 10));
    if (canEnter && !this.inFrame) {
      this.inFrame = true;
      this.bitCollector = [];
      this.bitsCollected = 0;
      this.framesSinceStrong = 0;
      this.dataFramesExecuted = 0;
      this.totalBytesEmitted = 0;
      this.lastStrongBits = 0;
      this.framesSinceExit = 0;
      this.peakAmpRef = 0;
      // Skip remaining sync symbols. This frame (which triggered sync)
      // is already consumed by detection and won't contribute to bitCollector.
      this.frameSkip = Math.max(0, this.cfg.syncSymbols - this.consecutiveSync) + 2; // +2 guard symbols
      // Round up to even — Hamming codewords span 2 symbols
      if (this.frameSkip % 2 !== 0) this.frameSkip++;
      if (this.logging) {
        console.log("[DEC] SYNC DETECTED — entering data mode", {
          noiseFrames: this.noiseFrames,
          consecutiveSync: this.consecutiveSync,
          frameSkip: this.frameSkip,
          framesSinceExit: this.framesSinceExit,
          energies: energies.map(e => e.toExponential(2)),
          avg: avg.toExponential(2),
          noiseFloor: this.noiseFloor.map(n => n.toExponential(2)),
        });
      }
    }

    // ── Decode bits during data frame ──
    if (this.inFrame) {
      if (this.frameSkip > 0) {
        this.frameSkip--;
        return;
      }

      // End detection: use tone energy SNR, not raw peak amplitude.
      // Room noise can have high peakAmp but low tone energy — the modem
      // signal is only present when tone energies exceed the noise floor.
      const endNoiseAvg = (this.noiseFloor[0] + this.noiseFloor[1] + this.noiseFloor[2] + this.noiseFloor[3]) / 4;
      const signalToNoise = avg / Math.max(endNoiseAvg, 1e-12);

      if (signalToNoise > 2.0) {
        this.framesSinceStrong = 0;
      } else {
        this.framesSinceStrong++;
      }

      // Safety timeouts — prevent infinite noise collection
      this.dataFramesExecuted++;
      if (this.dataFramesExecuted > 150 || this.bitsCollected > 10240) {
        // Too long in data mode — emit whatever we have and exit
        if (DEBUG) console.log(`[DEC] data-mode timeout after ${this.dataFramesExecuted}frames / ${this.bitsCollected}bits`);
        this.emitFrame();
        this.inFrame = false;
        return;
      }

      // ── Bit detection — per-tone SNR (compensates for frequency-response imbalance) ──
      // Each tone is ON if its energy exceeds 4× its own noise floor.
      // This handles speakers/mics with uneven response across the 4 tones.
      let frameBits = 0;
      for (let t = 0; t < 4; t++) {
        const bit = energies[t] > this.noiseFloor[t] * 4 ? 1 : 0;
        frameBits = (frameBits << 1) | bit;
        this.bitCollector.push(bit);
        this.bitsCollected++;
      }
      if (this.logging && this.bitsCollected <= 16) {
        console.log(`[DEC] first data frame: bits=${this.bitsCollected-4}-${this.bitsCollected-1} pat=${frameBits.toString(2).padStart(4,'0')} eng=${energies.map(e=>e.toExponential(2)).join(' ')}`);
      }

      // Track last known-good bit position for noise trimming
      if (signalToNoise > 1.3) this.lastStrongBits = this.bitsCollected;

      // Exit after consecutive dead frames — trim noise bits collected during countdown
      if (this.framesSinceStrong >= 8 && this.bitsCollected >= 4) {
        if (this.logging) console.log(`[DEC] end-of-signal after ${this.bitsCollected} bits (SNR=${signalToNoise.toFixed(1)})`);
        // Trim noise bits: keep only bits collected up to the last strong frame
        if (this.lastStrongBits > 0 && this.lastStrongBits < this.bitCollector.length) {
          this.bitCollector.length = this.lastStrongBits;
          this.bitsCollected = this.lastStrongBits;
        }
        this.emitFrame();
        this.inFrame = false;
        return;
      }
    }
  }

  /**
   * Per-tone adaptive threshold.
   * Uses running noise floor + a relative floor based on the strongest tone
   * in this frame — works for both direct loopback (high energy) and acoustic
   * (low energy) paths.
   */
  private bitThreshold(toneIdx: number, maxEnergy: number): number {
    // Per-frame relative: threshold = 30% of strongest tone in this frame.
    // Adapts automatically to any signal level — loopback or acoustic.
    const relThresh = maxEnergy * 0.30;

    // Absolute floor — never go below 1e-11 even in silence
    const absFloor = 1e-11;

    return Math.max(relThresh, absFloor);
  }

  /** Set expected total byte count for length-based exit (0 = unlimited) */
  setExpectedTotal(n: number) { this.expectedTotalBytes = n; }

  /** Check if any data has been decoded */
  hasData(): boolean {
    return this.decodedBytes.length > 0;
  }

  /** Flush remaining data and emit any pending frame */
  flush(): Uint8Array {
    let result = new Uint8Array(0);
    if (this.inFrame && this.bitsCollected >= 4) {
      // Trim noise bits collected after the last strong frame
      if (this.lastStrongBits > 0 && this.lastStrongBits < this.bitCollector.length) {
        this.bitCollector.length = this.lastStrongBits;
        this.bitsCollected = this.lastStrongBits;
      }
      result = this.emitFrame();
      this.inFrame = false;
    }
    // Also return any bytes accumulated from previous emitFrame calls
    const remaining = this.takeBytes();
    if (remaining.length > 0) {
      const combined = new Uint8Array(result.length + remaining.length);
      combined.set(result, 0);
      combined.set(remaining, result.length);
      return combined;
    }
    return result;
  }

  /** Get all accumulated bytes */
  takeBytes(): Uint8Array {
    const bytes = new Uint8Array(this.decodedBytes);
    this.decodedBytes = [];
    return bytes;
  }

  getProgress(): number {
    return this.bitsCollected;
  }

  /** Current noise floor for each tone (for debug display) */
  getNoiseFloor(): [number, number, number, number] {
    return [...this.noiseFloor];
  }

  /** Current noise max for each tone (for debug display) */
  getNoiseMax(): [number, number, number, number] {
    return [...this.noiseMax];
  }

  // ─── private ───────────────────────────────────────

  private detectEnergy(samples: number[], toneIdx: number): number {
    const freq = TONES[toneIdx];
    let sinCorr = 0, cosCorr = 0;
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const phase = 2 * Math.PI * freq * i / this.cfg.sampleRate;
      sinCorr += samples[i] * Math.sin(phase);
      cosCorr += samples[i] * Math.cos(phase);
    }
    return (sinCorr * sinCorr + cosCorr * cosCorr) / (n * n);
  }

  private emitFrame() {
    // Hamming(7,4) decode: group bits in 8-bit codewords, correct 1-bit errors.
    // Leftover bits (<8) are kept in bitCollector for the next emitFrame call
    // so every emitted byte is on a proper codeword boundary.
    let codeword = 0;
    let cwBits = 0;
    let nibbleBuf = 0;
    let nibbleBits = 0;
    let consumed = 0;
    for (const b of this.bitCollector) {
      codeword = (codeword << 1) | (b & 1);
      cwBits++;
      consumed++;
      if (cwBits >= 8) {
        const nibble = hammingDecode(codeword);
        nibbleBuf = (nibbleBuf << 4) | (nibble & 0xf);
        nibbleBits += 4;
        if (nibbleBits >= 8) {
          this.decodedBytes.push((nibbleBuf >> 4) & 0xff);
          this.totalBytesEmitted++;
          if (this.expectedTotalBytes > 0 && this.totalBytesEmitted >= this.expectedTotalBytes) {
            if (DEBUG) console.log(`[DEC] length exit at ${this.totalBytesEmitted}B`);
            this.inFrame = false;
            break;
          }
          nibbleBits -= 8;
          nibbleBuf &= 0xf;
        }
        codeword = 0;
        cwBits = 0;
      }
    }
    // Keep leftover bits for next frame — don't pad/drop them
    this.bitCollector.splice(0, consumed);
    this.bitsCollected = this.bitCollector.length;

    const data = new Uint8Array(this.decodedBytes);
    this.decodedBytes = [];
    if (this.onFrame) this.onFrame(data);
    return data;
  }
}

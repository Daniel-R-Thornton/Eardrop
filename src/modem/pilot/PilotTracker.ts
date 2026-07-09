/**
 * PilotTracker — Unified pilot discovery and phase tracking.
 *
 * Extracted from Decoder to reduce its size and give pilot management
 * a single owner. Wraps PilotScanner (frequency discovery) and
 * PilotPLL (continuous phase tracking) with a simplified API.
 */

import { PilotScanner, PilotPLL, toneIQ, getDataToneFreqs } from '../pilot';
import type { PilotDiscovery, PilotScannerConfig } from '../pilot';

export interface PilotTrackerConfig {
  sampleRate: number;
  pilotFreqHz: number;
  musical: boolean;
  /** If true, pre-fills noise profile so decoder is ready instantly (loopback mode) */
  fastSync: boolean;
}

export class PilotTracker {
  private cfg: PilotTrackerConfig;
  private scanner: PilotScanner;
  private pll: PilotPLL | null = null;

  private _discovered = false;
  private _pilotFreq = 0;
  private _pilotAmplitude = 0;
  private _toneFreqs: [number, number, number, number] = [500, 700, 900, 1100];

  /** Number of audio samples processed by feedSample */
  private _samplesSeen = 0;

  constructor(config: PilotTrackerConfig) {
    this.cfg = config;

    this.scanner = new PilotScanner({
      sampleRate: config.sampleRate,
      targetFreq: config.pilotFreqHz,
      freqTolerance: 30,
    });
  }

  // ─── Feed API ────────────────────────────────────────

  /**
   * Feed one audio sample for noise learning + pilot discovery + PLL tracking.
   * Call once per sample during the entire reception.
   */
  feedSample(sample: number): void {
    // Noise profiling (first ~1024 samples, after initial silence)
    if (!this.scanner.hasNoiseProfile() && this._samplesSeen >= 1024) {
      this.scanner.learnNoise(sample, 1024);
    }
    this._samplesSeen++;

    // Real-time feed for frequency scanning
    this.scanner.feedSampleRT(sample);

    // PLL tracking (continuous, once pilot is discovered)
    if (this.pll) {
      this.pll.update(sample);
      this._pilotAmplitude = this.pll.getAmplitude();
    }
  }

  /**
   * Attempt to lock onto the pilot. Called once per symbol frame.
   * Uses configured frequency for fast lock; falls back to scanner.
   *
   * @param framesSinceExit Number of noise frames profiled (for stability check)
   * @returns true if pilot was just discovered this call
   */
  tryDiscover(noiseFrames: number, noiseStable: boolean): boolean {
    if (this._discovered) return false;

    // Wait for sufficient noise profiling before attempting discovery
    const profilingReady =
      this.cfg.fastSync || noiseFrames >= 12 || (noiseStable && noiseFrames >= 8);

    if (!profilingReady) return false;

    this._discovered = true;
    this._pilotFreq = this.cfg.pilotFreqHz;
    this._pilotAmplitude = 0.05;

    this._toneFreqs = getDataToneFreqs(this.cfg.pilotFreqHz, this.cfg.musical);

    this.pll = new PilotPLL(this.cfg.pilotFreqHz, 0, 0.05, {
      sampleRate: this.cfg.sampleRate,
    });

    return true;
  }

  // ─── Read API ────────────────────────────────────────

  get discovered(): boolean {
    return this._discovered;
  }
  get pilotFreq(): number {
    return this._pilotFreq;
  }
  get pilotAmplitude(): number {
    return this._pilotAmplitude;
  }
  get toneFreqs(): [number, number, number, number] {
    return this._toneFreqs;
  }
  get samplesSeen(): number {
    return this._samplesSeen;
  }
  get phase(): number {
    return this.pll?.getPhase() ?? 0;
  }

  /**
   * Rotate raw I/Q values to the pilot-relative reference frame.
   * Returns null if PLL is not yet initialized.
   */
  rotateToPilotRef(rawI: number, rawQ: number): { i: number; q: number } | null {
    return this.pll?.rotateToPilotRef(rawI, rawQ) ?? null;
  }

  // ─── Lifecycle ───────────────────────────────────────

  reset(): void {
    this.scanner.reset();
    this.pll = null;
    this._discovered = false;
    this._pilotFreq = 0;
    this._pilotAmplitude = 0;
    this._toneFreqs = [500, 700, 900, 1100];
    this._samplesSeen = 0;
  }
}

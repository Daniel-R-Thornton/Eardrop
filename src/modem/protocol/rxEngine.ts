/**
 * rxEngine.ts — Complete receive engine for the Eardrop modem.
 *
 * State machine: WAITING → (preamble detected) → collecting frames
 *   → HEADER frame (type=0x01) → DATA frames (type=0x02) → TAIL (type=0x03) → COMPLETE
 *
 * Demodulation:
 *   - toneIQ() over 128-sample windows for per-tone I/Q
 *   - PilotPLL for continuous phase tracking
 *   - BPSK: correctedI < 0 ? 1 : 0 (hard decision)
 *   - 2 frames = 1 byte → feed to sentinel scanner
 *
 * Preamble detection: fixed timing (detect energy, wait ~620ms, start frame scan)
 * Frame format: 79-byte atomic frame (sentinel + BCH header + RS payload)
 */

import { type ModemConfig, TONE_OFFSETS, DEFAULT_CONFIG } from '../types';
import { PilotPLL, toneIQ, getDataToneFreqs } from '../pilot';
import { decodeFrame, FRAME_SIZE, PAYLOAD_DATA_SIZE, RAW_HEADER_SIZE } from '../protocol/atomicFrame';
import { SentinelScanner } from '../receiver/SentinelScanner';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import { ofdmSamples, ofdmToneFrequencies, OFDM_DEFAULTS, OFDM_SYMBOL_MS, OFDM_CP_MS, OFDM_TUNING } from '../types';
import { dlog } from '../../lib/debug/dlog';

// ─── Constants ───────────────────────────────────────

/** Samples per symbol — set per-instance from symbol rate */
const TONE_COUNT = 4;
const ENERGY_THRESHOLD = 0.0003;

// ─── RxState ─────────────────────────────────────────

export enum RxState {
  WAITING, // Waiting for signal energy
  PREAMBLE, // Receiving preamble (waiting for it to pass)
  FRAMES, // Scanning for atomic frames
  COMPLETE, // File received
  ERROR, // Error state
}

// ─── Types ───────────────────────────────────────────

export interface ReceivedFile {
  fileName: string;
  data: Uint8Array;
  totalBytes: number;
}

// ─── RxEngine ────────────────────────────────────────

export class RxEngine {
  /** Toggle verbose logging (preamble, calibration, per-frame debug). Off by default. */
  static verboseRxLogging = false;

  /** Quiet log helper — only prints when RxEngine.verboseRxLogging is true */
  private static rxLog(...args: any[]) {
    if (RxEngine.verboseRxLogging) console.log(...args);
  }

  private cfg: ModemConfig;
  private sps: number;

  // Demodulation buffer
  private buf: number[] = [];

  // OFDM mode
  private useOFDM: boolean = false;
  private ofdmDemod: OFDMQPSKDemodulator | null = null;
  private ofdmSyncFrames = 0;
  /** Energy threshold for OFDM sync detection — based on total tone energy, not pilot-only */
  private ofdmSyncMinFrames = OFDM_TUNING.syncMinFrames;
  private ofdmSyncThreshold = 0.06;
  /** Count of OFDM sync symbols processed for channel training */
  private ofdmTrainingSymbols = 0;
  /** Detection (syncMinFrames) + boundary-alignment slack (1) + training (trainingSymbols) must fit in sync burst */
  private readonly OFDM_TRAINING_SYMBOLS = OFDM_TUNING.trainingSymbols;

  /** OFDM tone count (4 or 8 — multiples of 4 only) */
  private ofdmToneCount = 4;
  /** OFDM demod tone frequencies — used for sync-energy detection too */
  private ofdmToneFreqs: Float32Array = new Float32Array(0);
  /** Rolling buffer of recent samples (2 OFDM symbols) for boundary search */
  private ofdmAlignBuf: number[] = [];
  /** Samples still to discard so the window grid lands on a symbol boundary */
  private ofdmSkip = 0;
  /** EMA of waiting-state tone energy — adapts the sync threshold to mic gain */
  private ofdmNoiseEma = 0;
  /** Windows processed since OFDM sync detection (sync-loss watchdog) */
  private ofdmWindowsSinceDetect = 0;
  /** Whether the scanner produced a frame since the last OFDM detection */
  private ofdmFrameSeen = false;
  /** Watchdog: reset to WAITING if no frame within this many windows (~15 s at any rate) */
  private get OFDM_WATCHDOG_WINDOWS() {
    return Math.round(15000 / (OFDM_SYMBOL_MS + OFDM_CP_MS));
  }

  // PLL
  private pll: PilotPLL | null = null;
  private pilotAmplitude = 0;
  private toneFreqs: [number, number, number, number] = [650, 900, 1150, 1500];

  /** Most recent raw I/Q values per tone (updated every symbol window) */
  private lastRawIQs: Array<{ i: number; q: number }> = [];

  // Accumulators for BPSK bit -> byte packing
  private bchBuf: number[] = [];
  private bchBufCount = 0;
  private samplesSeen = 0;

  // State machine
  private state: RxState = RxState.WAITING;
  private warbleFrames = 0;
  private preambleFrames = 0;
  private warbleThreshold = 0.025;
  private warbleTimeoutCount = 0;
  private markerPeakE = 0;

  // File assembly
  private fileID = 0;
  private fileName = '';
  private fileSize = 0;
  private fileData: number[] = [];
  private totalFrames = 0;
  private framesReceived = 0;

  // Frame scanner
  private scanner: SentinelScanner;

  // Completed file
  private completedFile: ReceivedFile | null = null;

  // Per-tone I/Q calibration references (from Gray code calibration)
  /** Reference vectors for bit=0 (ref0I/Q) and bit=1 (ref1I/Q) per tone */
  private ref0I: number[] = [1, 1, 1, 1];
  private ref0Q: number[] = [0, 0, 0, 0];
  private ref1I: number[] = [-1, -1, -1, -1];
  private ref1Q: number[] = [0, 0, 0, 0];
  /** Previous frame I/Q values for differential BPSK detection */
  private prevFrameI: number[] = [0, 0, 0, 0];
  private prevFrameQ: number[] = [0, 0, 0, 0];
  /** Absolute phase state tracker for DBPSK→absolute conversion */
  private absBits: number[] = [0, 0, 0, 0];
  /** Calibration frame counter (0..15 for Gray code) */
  private calFrameCount = 0;
  /** Previous calibration frame I/Q values for difference computation (per-tone) */
  private prevCalIQs: Array<Array<{ i: number; q: number }>> = [];
  /** Gray code sequence shared with transmitter */
  private readonly grayCodes = [0, 1, 3, 2, 6, 7, 5, 4, 12, 13, 15, 14, 10, 11, 9, 8];
  /** Marker flag */
  private markerSeen = false;
  /** Guard counter */
  private guardFrames = 0;

  /** Ring buffer of decoded warble code bits (0=low freq, 1=high freq) */
  private warbleCodeBits: number[] = [];
  /** Expected 16-bit warble code from types.ts (imported via config or local const) */
  private readonly WARBLE_CODE = 0xac94;
  private readonly WARBLE_CODE_THRESHOLD = 9;

  constructor(cfg: Partial<ModemConfig & { useOFDM?: boolean }> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.useOFDM = (cfg as any).useOFDM === true;

    // Default SPS = 256 for atomic frame protocol (BPSK). OFDM may override.
    this.sps = 256;

    this.toneFreqs = getDataToneFreqs(this.cfg.pilotFreqHz, !!this.cfg.musical);
    this.scanner = new SentinelScanner();

    // Initialize OFDM demodulator (256 FFT + 16 CP = 272 samples/symbol)
    if (this.useOFDM) {
      this.initOfdmDemod();
      const { symSamples: sps } = ofdmSamples(this.cfg.sampleRate);
      dlog('RX-OFDM', {
        pilot: this.cfg.pilotFreqHz,
        sps,
        tones: this.ofdmToneCount,
      });
    }

    this.scanner.onFrame = (frame: Uint8Array) => {
      dlog('RX', { scanFrame: frame.length });
      this.ofdmFrameSeen = true;
      this.processFrame(frame);
    };
  }

  // ─── Public API ──────────────────────────────────────
  private dbgFrameCount = 0;

  feedSample(sample: number): void {
    this.samplesSeen++;

    // Initialize PLL on first sample
    if (!this.pll) {
      this.pll = new PilotPLL(this.cfg.pilotFreqHz, 0, 0.05, {
        sampleRate: this.cfg.sampleRate,
      });
      dlog('RX', { pllPilot: this.cfg.pilotFreqHz });
    }

    // Feed EVERY sample to the PLL for continuous phase tracking
    this.pll.update(sample);
    this.pilotAmplitude = this.pll.getAmplitude();

    // ── OFDM symbol-boundary alignment ──
    if (this.useOFDM) {
      if (this.state === RxState.WAITING) {
        // Keep the last 4 symbols of audio for the CP boundary search —
        // extra periods let the search average correlation across repeats
        this.ofdmAlignBuf.push(sample);
        if (this.ofdmAlignBuf.length > 4 * this.sps) this.ofdmAlignBuf.shift();
      }
      if (this.ofdmSkip > 0) {
        this.ofdmSkip--;
        return;
      }
    }

    // ── Buffer samples and process by state ──
    this.buf.push(sample);
    if (this.buf.length < this.sps) return;
    const window = this.buf.slice(0, this.sps);
    this.buf.splice(0, this.sps);
    const rawIQs = this.toneFreqs.map((f) => toneIQ(window, f, this.cfg.sampleRate));
    this.lastRawIQs = rawIQs; // Store for debug snapshot
    const totalE = rawIQs.reduce((a, r) => a + Math.hypot(r.i, r.q), 0);

    // ── WAITING: detect sync (OFDM or warble) ──
    if (this.state === RxState.WAITING) {
      // OFDM mode: detect energy at the tone frequencies (not just pilot).
      // The sync burst has all 4 tones at QPSK 0°, so total tone energy is high.
      if (this.useOFDM && this.ofdmDemod) {
        // Measure energy at the actual OFDM tone frequencies — this.toneFreqs
        // are the BPSK tones, which only partially overlap the OFDM bins and
        // made detection marginal (fired barely above threshold).
        const totalE = Array.from(this.ofdmToneFreqs).reduce((acc, f) => {
          const iq = toneIQ(window, f, this.cfg.sampleRate);
          return acc + Math.hypot(iq.i, iq.q);
        }, 0);
        // Adaptive threshold: the fixed value is meaningless across mic
        // gains (at high gain the noise floor alone crosses it). Track the
        // waiting-state energy and require 3x the floor.
        const effThr = Math.max(this.ofdmSyncThreshold, 3 * this.ofdmNoiseEma);
        if (totalE < effThr) {
          this.ofdmNoiseEma = this.ofdmNoiseEma * 0.95 + totalE * 0.05;
        }
        // Heartbeat while waiting: 1 line per 25 windows (~2/s)
        dlog(
          'OFDM-SYNC',
          { e: totalE, thr: effThr, sync: this.ofdmSyncFrames },
          { every: 25 },
        );
        this.ofdmSyncFrames = totalE > effThr ? this.ofdmSyncFrames + 1 : 0;

        if (this.ofdmSyncFrames >= this.ofdmSyncMinFrames) {
          // Validate before committing: a real sync burst has cyclic-prefix
          // structure — a HIGH score at ONE offset. Room noise has no CP
          // structure (low score); periodic hum correlates at every offset
          // (high score, low sharpness). Rejecting here prevents training
          // on noise and going deaf for the actual transmission.
          const probe = this.findOfdmBlockStart(this.ofdmAlignBuf);
          // Sharpness: clean bursts measure ~1.7-1.9 (identical repeated
          // symbols partially correlate at every offset); flat periodic hum
          // measures ~1.0-1.3. The adaptive energy floor is the third layer.
          if (probe.score < 0.35 || probe.sharpness < 1.5) {
            dlog(
              'OFDM-SYNC',
              { falseTrigger: true, e: totalE, score: probe.score, sharp: probe.sharpness },
              { level: 'warn' },
            );
            this.ofdmSyncFrames = 0;
            return;
          }

          // Signal detected! Enter FRAMES state.
          dlog('OFDM-SYNC', { detected: true, e: totalE });
          this.ofdmWindowsSinceDetect = 0;
          this.ofdmFrameSeen = false;
          this.state = RxState.FRAMES;
          this.fileData = [];
          this.framesReceived = 0;
          this.receivedPayloadSeqs = new Set();
          this.fileID = 0;
          this.fileName = '';
          this.fileSize = 0;
          this.totalFrames = 0;
          this.ofdmSyncFrames = 0;
          this.ofdmTrainingSymbols = 0;
          this.ofdmDemod?.resetTraining();

          // Align the window grid to the TX symbol boundary. Energy detection
          // fires at an arbitrary offset; the CP only absorbs offsets within
          // its 16 samples, so without alignment ~94% of receptions straddle
          // symbol boundaries and demodulate garbage.
          const { offset: boundary, score } = probe;
          if (boundary >= 0) {
            const skip =
              (((boundary - this.ofdmAlignBuf.length) % this.sps) + this.sps) %
              this.sps;
            this.ofdmSkip = skip;
            dlog(
              'OFDM-SYNC',
              { boundary, skip, score },
              { level: score < 0.5 ? 'warn' : 'info' },
            );
          } else {
            dlog('OFDM-SYNC', { aligned: false, alignBuf: this.ofdmAlignBuf.length }, { level: 'warn' });
          }
          this.buf = [];
          this.ofdmAlignBuf = [];
        }
        return;
      }

      // ── BPSK warble detection (existing path) ──
      // --- Track sub-frame warble energies FIRST for alternation check ---
      const qRatios: number[] = [0, 0, 0, 0];
      for (let q = 0; q < 4; q++) {
        const qStart = q * 32;
        const qWindow = window.slice(qStart, qStart + 32);
        if (qWindow.length >= 32) {
          const qLow = toneIQ(qWindow, this.cfg.pilotFreqHz - 50, this.cfg.sampleRate);
          const qHigh = toneIQ(qWindow, this.cfg.pilotFreqHz + 50, this.cfg.sampleRate);
          const qELow = Math.hypot(qLow.i, qLow.q);
          const qEHigh = Math.hypot(qHigh.i, qHigh.q);
          qRatios[q] = qEHigh > 1e-12 ? qELow / qEHigh : 0;
        }
      }

      // --- Warble code correlation ---
      for (let q = 0; q < 4; q++) {
        const bit = qRatios[q] > 1.0 ? 0 : 1;
        this.warbleCodeBits.push(bit);
        if (this.warbleCodeBits.length > 32) this.warbleCodeBits.shift();
      }

      // Compute code correlation: try all 16 alignments (16 possible bit phases)
      let bestCodeCorr = 0;
      let bestCodeOffset = 0;
      if (this.warbleCodeBits.length >= 16) {
        for (let offset = 0; offset < 16; offset++) {
          let corr = 0;
          for (let b = 0; b < 16; b++) {
            const rxBit = this.warbleCodeBits[this.warbleCodeBits.length - 16 + b];
            const txBit = (this.WARBLE_CODE >> (15 - ((b + offset) % 16))) & 1;
            if (rxBit === txBit) corr++;
          }
          if (corr > bestCodeCorr) {
            bestCodeCorr = corr;
            bestCodeOffset = offset;
          }
        }
      }

      const wLow = toneIQ(window, this.cfg.pilotFreqHz - 50, this.cfg.sampleRate);
      const wHigh = toneIQ(window, this.cfg.pilotFreqHz + 50, this.cfg.sampleRate);
      const eLow = Math.hypot(wLow.i, wLow.q);
      const eHigh = Math.hypot(wHigh.i, wHigh.q);
      const eTot = eLow + eHigh;

      // Energy check (per-frame) + code correlation (final validation only)
      const ratio = eLow > eHigh ? eLow / eHigh : eHigh / eLow;
      // Use energy + approximate ratio check for per-frame warble detection
      const isWarbleFrame =
        eTot > this.warbleThreshold && ratio < 3.0 && eLow > 0.005 && eHigh > 0.005;
      if (isWarbleFrame) {
        this.warbleFrames++;
        if (this.warbleFrames === 1)
          RxEngine.rxLog(
            `[WARBLE] frame 0 eLow=${eLow.toExponential(2)} eHigh=${eHigh.toExponential(2)} codeCorr=${bestCodeCorr}/16`,
          );
        if (this.warbleFrames === 2)
          RxEngine.rxLog(
            `[WARBLE] frame 1 eLow=${eLow.toExponential(2)} eHigh=${eHigh.toExponential(2)} codeCorr=${bestCodeCorr}/16`,
          );
        if (this.warbleFrames >= 5) {
          // Final validation: check code correlation before declaring warble detected
          const codeOk =
            this.warbleCodeBits.length >= 16 && bestCodeCorr >= this.WARBLE_CODE_THRESHOLD;
          if (!codeOk) {
            dlog('WARBLE', { reject: true, corr: bestCodeCorr, need: this.WARBLE_CODE_THRESHOLD });
            this.warbleFrames = 0;
          } else {
            RxEngine.rxLog(
              `[WARBLE] Detected after ${this.warbleFrames} frames (codeCorr=${bestCodeCorr}/16)`,
            );
            this.state = RxState.PREAMBLE;
            this.markerPeakE = 0;
          }
        }
      } else {
        if (this.warbleFrames > 0 || (eTot > 0.01 && ratio < 3.0)) {
          RxEngine.rxLog(
            `[WARBLE] reject: eTot=${eTot.toExponential(2)} codeCorr=${bestCodeCorr}/16 thr=${this.WARBLE_CODE_THRESHOLD} eLow=${eLow.toExponential(2)} eHigh=${eHigh.toExponential(2)}`,
          );
        }
        this.warbleFrames = 0;
      }

      return;
    }

    // ── PREAMBLE: state machine driven by energy signatures ──
    if (this.state === RxState.PREAMBLE) {
      const signs = rawIQs.map((r) => (r.i >= 0 ? '+' : '-')).join('');
      if (totalE > this.markerPeakE) this.markerPeakE = totalE;
      this.preambleFrames++;
      // Timeout: if no marker found within 80 frames (~3.2s), reset to WAITING
      if (this.preambleFrames > 80) {
        this.warbleTimeoutCount++;
        const newThreshold = 0.025 * Math.pow(1.5, this.warbleTimeoutCount);
        dlog('PREAMBLE', { timeout: this.warbleTimeoutCount, newThr: newThreshold });
        this.warbleThreshold = newThreshold;
        this.state = RxState.WAITING;
        this.warbleFrames = 0;
        this.markerSeen = false;
        this.preambleFrames = 0;
        this.markerPeakE = 0;
        this.guardFrames = 0;
        this.buf = [];
        return;
      }

      // Detect marker: all 4 tones ON produces distinctly high energy
      if (totalE > 0.15 && !this.markerSeen) {
        this.markerSeen = true;
        RxEngine.rxLog(`[MARKER] E=${totalE.toExponential(2)} signs=[${signs}]`);
        this.calFrameCount = 0;
        this.prevCalIQs = [];
        return;
      }
      // After marker: 16 Gray code calibration frames
      if (this.markerSeen && this.calFrameCount < 16) {
        const gc = this.grayCodes[this.calFrameCount];
        const bits = [(gc >> 3) & 1, (gc >> 2) & 1, (gc >> 1) & 1, gc & 1];
        RxEngine.rxLog(
          `[CAL] frame ${this.calFrameCount} gc=0x${gc.toString(2).padStart(4, '0')} bits=[${bits.join(',')}] I=${rawIQs.map((r) => r.i.toFixed(3)).join(',')}`,
        );
        // Accumulate this frame's I/Q per tone into the correct bit bucket
        // Store per-tone I/Q for difference-based reference computation
        this.prevCalIQs.push(rawIQs.map((r) => ({ i: r.i, q: r.q })));
        this.calFrameCount++;
        if (this.calFrameCount >= 16) {
          // Direct centroid averaging: for each tone, separate calibration frames
          // by their bit value (0 or 1) and average the I/Q per bin.
          const cal0I: number[] = [0, 0, 0, 0];
          const cal0Q: number[] = [0, 0, 0, 0];
          const cal1I: number[] = [0, 0, 0, 0];
          const cal1Q: number[] = [0, 0, 0, 0];
          const cnt0: number[] = [0, 0, 0, 0];
          const cnt1: number[] = [0, 0, 0, 0];

          for (let f = 0; f < 16; f++) {
            const gc = this.grayCodes[f];
            const bits = [(gc >> 3) & 1, (gc >> 2) & 1, (gc >> 1) & 1, gc & 1];
            for (let t = 0; t < TONE_COUNT; t++) {
              if (bits[t] === 0) {
                cal0I[t] += this.prevCalIQs[f][t].i;
                cal0Q[t] += this.prevCalIQs[f][t].q;
                cnt0[t]++;
              } else {
                cal1I[t] += this.prevCalIQs[f][t].i;
                cal1Q[t] += this.prevCalIQs[f][t].q;
                cnt1[t]++;
              }
            }
          }

          for (let t = 0; t < TONE_COUNT; t++) {
            if (cnt0[t] > 0) {
              this.ref0I[t] = cal0I[t] / cnt0[t];
              this.ref0Q[t] = cal0Q[t] / cnt0[t];
            }
            if (cnt1[t] > 0) {
              this.ref1I[t] = cal1I[t] / cnt1[t];
              this.ref1Q[t] = cal1Q[t] / cnt1[t];
            }
          }
          dlog('CAL', {
            refs: [0, 1, 2, 3]
              .map(
                (t) =>
                  `t${t}:${this.ref0I[t].toFixed(2)},${this.ref0Q[t].toFixed(2)}/${this.ref1I[t].toFixed(2)},${this.ref1Q[t].toFixed(2)}`,
              )
              .join(' '),
          });
          // Initialize absolute phase state from last calibration frame
          const lastGc = this.grayCodes[this.prevCalIQs.length - 1];
          this.absBits = [(lastGc >> 3) & 1, (lastGc >> 2) & 1, (lastGc >> 1) & 1, lastGc & 1];
          dlog('CAL', { absBits: this.absBits.join('') });
          // Initialize differential BPSK from last calibration frame's I values
          const lastCal = this.prevCalIQs[this.prevCalIQs.length - 1];
          for (let t = 0; t < TONE_COUNT; t++) {
            this.prevFrameI[t] = lastCal[t].i;
            this.prevFrameQ[t] = lastCal[t].q;
          }
        }
        return;
      }
      // After calibration: guard frames (pilot only)
      if (this.calFrameCount >= 16) {
        this.guardFrames++;
        if (this.guardFrames === 1) dlog('GUARD', { waiting: 2 });
        if (this.guardFrames >= 2) {
          RxEngine.rxLog('[FRAMES] entering data decode');
          this.state = RxState.FRAMES;
          this.fileData = [];
          this.framesReceived = 0;
          this.receivedPayloadSeqs = new Set();
          this.fileID = 0;
          this.fileName = '';
          this.fileSize = 0;
          this.totalFrames = 0;
          this.buf = [];
        }
      }
      return;
    }

    // ── Bit detection: OFDM/QPSK path ──
    let frameBits = 0;
    const bits: number[] = [];

    if (this.useOFDM && this.ofdmDemod) {
      // Sync-loss watchdog: a false trigger (or missed frame) previously left
      // the receiver stuck in FRAMES forever, deaf to the next transmission.
      this.ofdmWindowsSinceDetect++;
      if (!this.ofdmFrameSeen && this.ofdmWindowsSinceDetect > this.OFDM_WATCHDOG_WINDOWS) {
        dlog('OFDM-SYNC', { watchdogReset: true, windows: this.ofdmWindowsSinceDetect }, { level: 'warn' });
        this.state = RxState.WAITING;
        this.ofdmSyncFrames = 0;
        this.ofdmTrainingSymbols = 0;
        this.ofdmDemod.resetTraining();
        this.buf = [];
        this.ofdmAlignBuf = [];
        return;
      }

      // OFDM training phase: use first N symbols of sync burst to train channel estimates
      if (this.ofdmTrainingSymbols < this.OFDM_TRAINING_SYMBOLS) {
        this.ofdmDemod.trainOnSyncSymbol(window);
        this.ofdmTrainingSymbols++;
        if (this.ofdmTrainingSymbols >= this.OFDM_TRAINING_SYMBOLS) {
          dlog('OFDM-TRAIN', { done: true, symbols: this.ofdmTrainingSymbols });
        }
        return; // Don't process bits during training
      }

      // OFDM/QPSK demodulation — FFT + per-tone equalization + QPSK decode
      const result = this.ofdmDemod.demodulate(window);
      // Tones are grouped in 4-tone blocks; each block carries one byte
      // (b0 lane = upper nibble, b1 lane = lower nibble — matches the BPSK
      // frame-pair format consumed below). 8 tones → 2 bytes per symbol.
      const blockCount = Math.max(1, Math.floor(this.ofdmToneCount / 4));
      for (let blk = 0; blk < blockCount; blk++) {
        let fbUpper = 0;
        let fbLower = 0;
        for (let j = 0; j < 4; j++) {
          const bitIdx = (blk * 4 + j) * 2;
          const b0 = result.bits[bitIdx] ?? 0;
          const b1 = result.bits[bitIdx + 1] ?? 0;
          fbUpper |= b0 << (7 - j * 2);
          fbUpper |= 1 << (6 - j * 2);
          fbLower |= b1 << (7 - j * 2);
          fbLower |= 1 << (6 - j * 2);
        }
        this.bchBuf.push(fbUpper, fbLower);
        this.bchBufCount += 2;
        if (blk === 0) frameBits = fbUpper;
      }
      for (let t = 0; t < TONE_COUNT && t < result.toneIQ.length; t++) {
        rawIQs[t] = result.toneIQ[t];
      }
      this.pilotAmplitude = result.pilotAmplitude;
    } else {
      // ── Differential BPSK bit detection ──
      // Compare each tone's I against the PREVIOUS frame's I.
      // Bit=0 if same sign (no phase change), Bit=1 if opposite sign (phase flip).
      // Differential BPSK using full I/Q dot product
      // Error propagation is handled by the Hamming-distance sentinel scanner
      for (let t = 0; t < TONE_COUNT; t++) {
        const prevI = this.prevFrameI[t];
        const prevQ = this.prevFrameQ[t];
        // DBPSK: dot product of consecutive frames
        const dot = prevI * rawIQs[t].i + prevQ * rawIQs[t].q;
        const diffBit = (prevI !== 0 || prevQ !== 0) && dot < 0 ? 1 : 0;
        const dpskAbs = this.absBits[t] ^ diffBit;

        // Centroid: nearest neighbor to cal references
        const d0 = (rawIQs[t].i - this.ref0I[t]) ** 2 + (rawIQs[t].q - this.ref0Q[t]) ** 2;
        const d1 = (rawIQs[t].i - this.ref1I[t]) ** 2 + (rawIQs[t].q - this.ref1Q[t]) ** 2;
        const centAbs = d1 < d0 ? 1 : 0;

        const separation = Math.max(d0, d1) / Math.max(Math.min(d0, d1), 1e-12);
        const confident = separation > 1.3;
        const absBit = confident ? centAbs : dpskAbs;
        this.absBits[t] = absBit;

        bits.push(absBit);
        frameBits |= absBit << (7 - t * 2);
        frameBits |= 1 << (6 - t * 2);
        this.prevFrameI[t] = rawIQs[t].i;
        this.prevFrameQ[t] = rawIQs[t].q;
      }
    }

    // Debug: first 5 frames — show centroid distances and decision mode
    if (this.dbgFrameCount === 0) {
      const sepInfo = [0, 1, 2, 3].map((t) => {
        const d0 = (rawIQs[t].i - this.ref0I[t]) ** 2 + (rawIQs[t].q - this.ref0Q[t]) ** 2;
        const d1 = (rawIQs[t].i - this.ref1I[t]) ** 2 + (rawIQs[t].q - this.ref1Q[t]) ** 2;
        const sep = Math.max(d0, d1) / Math.max(Math.min(d0, d1), 1e-12);
        return `t${t}:${sep.toFixed(1)}x`;
      }).join(' ');
      RxEngine.rxLog(`[RX] Centroid separations: ${sepInfo}`);
    }

    // Debug: first 5 frames with expected sentinel comparison, then periodic progress
    this.dbgFrameCount++;
    if (this.dbgFrameCount <= 5) {
      const sentinelBytes = [0xe7, 0x9f, 0xe7];
      const byteIdx = Math.floor((this.dbgFrameCount - 1) / 2);
      const nibble = (this.dbgFrameCount - 1) % 2 === 0 ? 'upper' : 'lower';
      // eslint-disable-next-line no-useless-assignment -- assigned inside if block, used in log below
      let expectedStr = '?';
      if (byteIdx < 3) {
        const b = sentinelBytes[byteIdx];
        const nibVal = nibble === 'upper' ? (b >> 4) & 0xf : b & 0xf;
        const expPh = [(nibVal >> 3) & 1, (nibVal >> 2) & 1, (nibVal >> 1) & 1, nibVal & 1];
        let eb = 0;
        for (let t = 0; t < TONE_COUNT; t++) {
          eb |= expPh[t] << (7 - t * 2);
          eb |= 1 << (6 - t * 2);
        }
        expectedStr = `0x${  eb.toString(16).padStart(2, '0')}`;
        const rawSigns = rawIQs.map((r) => (r.i >= 0 ? '+' : '-')).join('');
        // Extract absolute bits from frameBits (positions 7,5,3,1)
        const absBitsStr = [0, 1, 2, 3]
          .map((t) => ((frameBits >> (7 - t * 2)) & 1).toString())
          .join('');
        const expStr = expPh.join('');
        const matchStr = absBitsStr
          .split('')
          .map((b, i) => (b === expStr[i] ? '✓' : '✗'))
          .join('');
        RxEngine.rxLog(
          `[RX] Frame ${this.dbgFrameCount}: bits=0x${frameBits.toString(16).padStart(2, '0')} exp=${expectedStr} I=${rawIQs.map((r) => r.i.toFixed(3)).join(',')} got=[${absBitsStr}] want=[${expStr}] ${matchStr}`,
        );
      } else {
        RxEngine.rxLog(
          `[RX] Frame ${this.dbgFrameCount}: bits=0x${frameBits.toString(16).padStart(2, '0')}`,
        );
      }
    } else if (this.dbgFrameCount % 50 === 0) {
      RxEngine.rxLog(
        `[RX] Frame ${this.dbgFrameCount}: ${this.fileData.length}B assembled (${this.framesReceived} payload frames)`,
      );
    }

    // Skip common bchBuf push in OFDM mode (OFDM branch already pushed)
    if (!this.useOFDM) {
      this.bchBuf.push(frameBits);
      this.bchBufCount++;
    }
    // Consume frame-pair entries two at a time — 8-tone OFDM pushes 4 per
    // symbol (2 blocks), so loop rather than taking a single pair.
    while (this.bchBufCount >= 2) {
      const upper = this.bchBuf.shift()!;
      const lower = this.bchBuf.shift()!;
      this.bchBufCount -= 2;
      const hi =
        (((upper >> 7) & 1) << 3) |
        (((upper >> 5) & 1) << 2) |
        (((upper >> 3) & 1) << 1) |
        ((upper >> 1) & 1);
      const lo =
        (((lower >> 7) & 1) << 3) |
        (((lower >> 5) & 1) << 2) |
        (((lower >> 3) & 1) << 1) |
        ((lower >> 1) & 1);
      const blockByte = (hi << 4) | lo;
      this.scanner.feedByte(blockByte);
    }
  }

  /** Batch entry point — behaviorally identical to per-sample feeding. */
  feedChunk(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) this.feedSample(chunk[i]);
  }

  /** Frame-assembly progress snapshot for telemetry. */
  getProgress(): {
    state: number;
    framesReceived: number;
    totalFrames: number;
    fileName: string;
    fileSize: number;
    bytesAssembled: number;
  } {
    return {
      state: this.state,
      framesReceived: this.framesReceived,
      totalFrames: this.totalFrames,
      fileName: this.fileName,
      fileSize: this.fileSize,
      bytesAssembled: this.fileData.length,
    };
  }

  /**
   * (Re)create the OFDM demodulator from config. Clamps toneCount to a
   * multiple of 4 (block packing carries one byte per 4-tone block).
   * Returns the demod tone frequencies for logging.
   */
  private initOfdmDemod(): Float32Array {
    const { symSamples } = ofdmSamples(this.cfg.sampleRate);
    this.sps = symSamples;
    let ofdmToneCount = this.cfg.toneCount || OFDM_DEFAULTS.toneCount;
    if (ofdmToneCount % 4 !== 0) {
      dlog('RX-OFDM', { badToneCount: ofdmToneCount, using: 4 }, { level: 'warn' });
      ofdmToneCount = 4;
    }
    this.ofdmToneCount = ofdmToneCount;
    const demodToneFreqs = ofdmToneFrequencies({ toneCount: ofdmToneCount });
    this.ofdmToneFreqs = demodToneFreqs;
    this.ofdmDemod = new OFDMQPSKDemodulator({
      sampleRate: this.cfg.sampleRate,
      toneFrequencies: demodToneFreqs,
      pilotFreqHz: this.cfg.pilotFreqHz,
    });
    return demodToneFreqs;
  }

  /**
   * Find the OFDM symbol boundary in recent audio via cyclic-prefix
   * correlation: the first CP samples of a symbol equal its last CP samples,
   * so corr(x[o..o+cp], x[o+fft..o+fft+cp]) peaks once per symbol at o =
   * block start. Returns the offset in `recent` (0..sps-1), or -1 if no
   * confident peak.
   */
  private findOfdmBlockStart(recent: number[]): {
    offset: number;
    score: number;
    sharpness: number;
  } {
    const fft = ofdmSamples(this.cfg.sampleRate).fftSamples;
    const cp = this.sps - fft;
    if (recent.length < this.sps + cp) return { offset: -1, score: 0, sharpness: 0 };
    let bestOffset = -1;
    let bestScore = -Infinity;
    let scoreSum = 0;
    let scoreCount = 0;
    const maxOffset = Math.min(this.sps, recent.length - fft - cp);
    // Average the CP correlation over as many whole sync-symbol periods as
    // the buffer holds — one 16-sample window is noise-fragile.
    const periods = Math.max(1, Math.floor((recent.length - fft - cp) / this.sps));
    for (let offset = 0; offset < maxOffset; offset++) {
      let corr = 0;
      let energy = 0;
      for (let p = 0; p < periods; p++) {
        const base = offset + p * this.sps;
        if (base + fft + cp > recent.length) break;
        for (let n = 0; n < cp; n++) {
          const early = recent[base + n];
          const late = recent[base + n + fft];
          corr += early * late;
          energy += early * early + late * late;
        }
      }
      const score = energy > 1e-9 ? corr / (energy / 2) : 0;
      scoreSum += Math.abs(score);
      scoreCount++;
      if (score > bestScore) {
        bestScore = score;
        bestOffset = offset;
      }
    }
    // Sharpness = peak vs average. A real sync burst correlates only at the
    // true boundary (sharp peak). Periodic interference — e.g. 50 Hz mains
    // hum, whose period divides the 256-sample lag exactly — correlates at
    // EVERY offset, giving a high but flat score profile.
    const meanScore = scoreCount > 0 ? scoreSum / scoreCount : 0;
    const sharpness = meanScore > 1e-9 ? bestScore / meanScore : 0;
    return { offset: bestOffset, score: bestScore, sharpness };
  }

  getState(): RxState {
    return this.state;
  }

  getFile(): ReceivedFile | null {
    return this.completedFile;
  }

  getDebugByteLog(): Array<{ byte: number; phase: string; bitOffset: number }> {
    return this.scanner.getByteLog();
  }

  getShiftRegHistory(): Array<{ bit: number; shiftReg: number; matched: boolean; phase: string }> {
    return this.scanner.getShiftRegHistory();
  }

  reset(): void {
    this.state = RxState.WAITING;
    this.warbleFrames = 0;
    this.warbleThreshold = 0.025;
    this.warbleTimeoutCount = 0;
    this.markerSeen = false;
    this.preambleFrames = 0;
    this.markerPeakE = 0;
    this.guardFrames = 0;
    this.buf = [];
    this.absBits = [0, 0, 0, 0];
    this.warbleCodeBits = [];
    this.calFrameCount = 0;
    this.prevCalIQs = [];
    this.prevFrameI = [0, 0, 0, 0];
    this.prevFrameQ = [0, 0, 0, 0];
    this.ref0I = [1, 1, 1, 1];
    this.ref0Q = [0, 0, 0, 0];
    this.ref1I = [-1, -1, -1, -1];
    this.ref1Q = [0, 0, 0, 0];
    this.bchBuf = [];
    this.bchBufCount = 0;
    this.pll = null;
    this.pilotAmplitude = 0;
    this.samplesSeen = 0;
    this.dbgFrameCount = 0;
    // Re-create OFDM demod on reset
    if (this.useOFDM) {
      this.initOfdmDemod();
    }
    this.fileData = [];
    this.framesReceived = 0;
    this.receivedPayloadSeqs = new Set();
    this.fileName = '';
    this.fileSize = 0;
    this.totalFrames = 0;
    this.completedFile = null;
    this.ofdmSyncFrames = 0;
    this.scanner.reset();
  }

  // ─── Private ─────────────────────────────────────

  private computeCRC16(data: Uint8Array): number {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i] << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
        else crc <<= 1;
      }
    }
    return crc & 0xffff;
  }

  private processFrame(frame: Uint8Array): void {
    // CRC validation happens inside decodeFrame (post-BCH). Raw frame bytes
    // 5-6 are pre-decode and would be misleading to log against it.
    const decoded = decodeFrame(frame);

    dlog('RX-FRAME', {
      valid: decoded.valid,
      type: decoded.header ? `0x${decoded.header.type.toString(16).padStart(2, '0')}` : '?',
      seq: decoded.header?.seqNum ?? -1,
      len: decoded.payload?.length ?? 0,
    });
    if (!decoded.valid) return;

    if (decoded.header!.totalFrames > 0) this.totalFrames = decoded.header!.totalFrames;

    switch (decoded.header!.type) {
      case 0x01: // HEADER
        this.processHeader(decoded.payload);
        break;
      case 0x02: // PAYLOAD
        this.processPayload(decoded.payload, decoded.header!.seqNum);
        break;
      case 0x03: // TAIL
        dlog('RX-FRAME', { tail: true, assembled: this.fileData.length, size: this.fileSize });
        this.processTail();
        break;
    }
  }

  /** Track received payload sequence numbers for diversity-mode dedup */
  private receivedPayloadSeqs = new Set<number>();

  private processHeader(payload: Uint8Array): void {
    // Header payload format: [fileID:4B][totalSize:4B][nameLen:1B][name...]
    const fileID = (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];

    // Duplicate header (diversity mode repetition) — ignore, keep existing state
    if (fileID === this.fileID && this.fileName !== '') {
      dlog('RX-FRAME', { dupHeader: true });
      return;
    }

    const totalSize =
      (payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24)) >>> 0;
    const nameLen = Math.min(payload[8] & 0xff, PAYLOAD_DATA_SIZE - 9);

    let name = '';
    for (let i = 0; i < nameLen; i++) {
      const c = payload[9 + i];
      if (c >= 0x20 && c <= 0x7e) name += String.fromCharCode(c);
    }

    this.fileID = fileID;
    this.fileSize = totalSize;
    this.fileName = name;
    this.fileData = [];
    this.framesReceived = 0;
    this.receivedPayloadSeqs = new Set();
  }

  private processPayload(payload: Uint8Array, seqNum: number): void {
    if (!this.fileName) return;

    // Skip duplicate payload frames (diversity mode repetition)
    if (this.receivedPayloadSeqs.has(seqNum)) {
      dlog('RX-FRAME', { dupPayload: seqNum });
      return;
    }
    this.receivedPayloadSeqs.add(seqNum);

    for (let i = 0; i < payload.length && this.fileData.length < this.fileSize; i++) {
      this.fileData.push(payload[i]);
    }
    this.framesReceived++;
  }

  private processTail(): void {
    if (!this.fileName || this.fileData.length === 0) {
      // Duplicate tail (diversity mode) — already handled, or no data yet
      return;
    }

    // Already completed (duplicate tail from diversity mode)
    if (this.state === RxState.COMPLETE) {
      dlog('RX-FRAME', { dupTail: true });
      return;
    }

    const data = new Uint8Array(this.fileData.slice(0, this.fileSize));
    this.completedFile = {
      fileName: this.fileName,
      data,
      totalBytes: this.fileSize,
    };
    this.state = RxState.COMPLETE;
    this.fileName = '';
    this.fileData = [];
  }

  getDebugSnapshot() {
    const inFrame = this.state === RxState.FRAMES;
    const nf: number[] = []; const en: number[] = []; const ri: number[] = []; const rq: number[] = [];
    for (const r of this.lastRawIQs) {
      nf.push(0);
      const e = Math.hypot(r.i, r.q);
      en.push(e);
      ri.push(r.i);
      rq.push(r.q);
    }
    // Pad to 4 entries for DecoderInfo tuple type
    while (nf.length < 4) { nf.push(0); en.push(0); ri.push(0); rq.push(0); }
    const rif = ri.slice(0,4) as [number,number,number,number];
    const rqf = rq.slice(0,4) as [number,number,number,number];
    const enf = en.slice(0,4) as [number,number,number,number];
    const nff = nf.slice(0,4) as [number,number,number,number];
    const sigToNoise = this.pilotAmplitude > 1e-6 ? 20 * Math.log10(this.pilotAmplitude / 1e-6) : 0;
    return {
      inFrame,
      consecutiveSync: this.preambleFrames,
      bitsCollected: this.dbgFrameCount * 4,
      pilotFreq: this.cfg.pilotFreqHz,
      pilotAmplitude: this.pilotAmplitude,
      signalToNoise: sigToNoise,
      noiseFloor: nff,
      noiseMax: nff,
      energies: enf,
      relI: rif,
      relQ: rqf,
      bitPattern: 0,
      thresholds: nff,
      ratios: nff,
      noiseFrames: 0,
      noiseAvg: 0,
      peakAmp: 0,
      avg: en.reduce((a,b) => a + (isNaN(b) ? 0 : b), 0) / Math.max(en.length, 1),
      rawEnergies: enf,
      strong: inFrame,
      burstThreshold: 0,
      framesSinceStrong: 0,
      framesSinceExit: 0,
      frameSkip: 0,
      pilotAmp: this.pilotAmplitude,
      pilotConfidence: this.state !== RxState.WAITING ? 1 : 0,
      blocksDecoded: 0,
      blocksCrcFailed: 0,
    };
  }
}

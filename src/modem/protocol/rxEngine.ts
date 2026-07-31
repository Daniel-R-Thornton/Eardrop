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
import {
  decodeFrame,
  FRAME_SIZE,
  PAYLOAD_DATA_SIZE,
  RAW_HEADER_SIZE,
  FRAME_TYPE_HEADER,
  FRAME_TYPE_PAYLOAD,
  FRAME_TYPE_TAIL,
  FRAME_TYPE_PROFILE,
} from '../protocol/atomicFrame';
import {
  parseLinkProfile,
  DEFAULT_LINK_PROFILE,
  qamMapToOrders,
  PROFILE_FRAME_REPEATS,
  type LinkProfile,
} from '../protocol/linkProfile';
import { SentinelScanner } from '../receiver/SentinelScanner';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import type { QamOrder } from '../modulation/constellation';
import { ofdmSamples, ofdmToneFrequencies, OFDM_DEFAULTS, OFDM_SYMBOL_MS, OFDM_CP_MS, OFDM_TUNING } from '../types';
import { generateChirp, chirpCorrelate, type ChirpConfig } from './chirp';
import { dlog, dlogFmt } from '../../lib/debug/dlog';

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
  /** Wire bytes as received (still compressed if schemeId !== 0). */
  data: Uint8Array;
  totalBytes: number;
  /** Compression scheme id from the header (0 = raw). Decompressed by the consumer. */
  schemeId: number;
  /** Original (decompressed) size from the header. */
  origSize: number;
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
  /** Counter for data symbols processed after training — diagnostic only */
  public ofdmDataSymbolCounter = 0;
  /** Detection (syncMinFrames) + boundary-alignment slack (1) + training (trainingSymbols) must fit in sync burst */
  private readonly OFDM_TRAINING_SYMBOLS = OFDM_TUNING.trainingSymbols;
  /**
   * Sync symbols to discard before training — see trainingSettleSymbols.
   * Overridable from config so the two sides can be swept together during
   * bring-up; it MUST equal what the TX emits, since the preamble/data boundary
   * is found by counting and nothing else.
   */
  private readonly OFDM_SETTLE_SYMBOLS: number;
  /** Settle windows discarded so far since the current sync. */
  private ofdmSettleSymbols = 0;

  /** OFDM tone count (4 or 8 — multiples of 4 only) */
  private ofdmToneCount = 4;
  /** OFDM demod tone frequencies — used for sync-energy detection too */
  private ofdmToneFreqs: Float32Array = new Float32Array(0);
  /** Chirp detection: template (generated once from config) */
  private chirpTemplate: Float32Array = new Float32Array(0);
  /**
   * Chirp detection: 4:1-decimated template + its energy, hoisted out of the
   * per-attempt correlation path (7c) — both are pure functions of
   * chirpTemplate (itself constant per config), so recomputing them ~40x/sec
   * was pure waste. Rebuilt in initOfdmDemod() alongside chirpTemplate.
   */
  private chirpTemplateDec: Float32Array = new Float32Array(0);
  private chirpTemplateEnergyDec = 0;
  /**
   * Chirp detection: rolling buffer for cross-correlation, as a fixed-capacity
   * ring (7b) — capacity == chirpTemplate.length + sps*2, allocated in
   * initOfdmDemod(). `chirpBufHead`/`chirpBufCount` describe the live window;
   * `chirpBufPush`/`chirpBufAt`/`chirpBufLen`/`chirpBufClear`/`chirpBufTrimToLast`
   * below are the only access points — no consumer indexes chirpBufData
   * directly, so the head/wrap arithmetic stays in one place.
   */
  private chirpBufData: Float32Array = new Float32Array(0);
  private chirpBufHead = 0;
  private chirpBufCount = 0;
  /** Chirp detection: span Hz around pilot */
  private chirpSpanHz = 200;
  /** Chirp correlation throttle — run once per sps samples (not every sample) */
  private chirpRan = false;
  private chirpTick = 0;
  /**
   * Chirp→CP handoff probe throttle (7a) — findOfdmBlockStart is an
   * O(sps × cp × periods) correlation; while `probingChirp` is true it used
   * to run on every incoming sample because `buf` never drains. Counts down
   * from `sps` to 0; the probe runs only when it reaches 0. Reset to 0 the
   * moment a chirp is (re)detected so the FIRST probe after detection still
   * fires as soon as the existing sps*2 settle delay elapses, matching
   * pre-throttle timing exactly.
   */
  private chirpProbeTick = 0;
  /** Set when chirp correlation fires — triggers CP boundary check in WAITING */
  private chirpDetected = false;
  /** Absolute sample count immediately after the detected chirp. */
  private chirpEndSample = -1;
  /** Rolling buffer of recent samples (2 OFDM symbols) for boundary search */
  private ofdmAlignBuf: number[] = [];
  /** Samples still to discard so the window grid lands on a symbol boundary */
  private ofdmSkip = 0;
  /** EMA of waiting-state tone energy — adapts the sync threshold to mic gain */
  // INVARIANT this seed must satisfy: freeze ABOVE typical ambient room noise,
  // detect BELOW the training signal. (freeze fires at >5x this seed — see
  // the freeze branch below). Typical real-room ambient noise measures
  // ~0.2-0.3 in this same total-tone-energy metric (see the old comment this
  // replaces, referencing real acoustic testing).
  //
  // TX level flattening (see OFDMQPSKModulator's qamScale doc) dropped the
  // training burst from a per-symbol peak-normed ~0.95 (total tone energy
  // e~0.4+) to one fixed, worst-case-safe scale that's quieter but never
  // clips: clean training total-tone-energy is now ~0.267-0.299 regardless
  // of tone count (8/16/32) — a ~1.5x (-3.7 dB) signal drop, not the ~3.5x
  // this seed was first (wrongly) dropped by. An 0.02 seed freezes at
  // 5*0.02=0.10, which is BELOW typical ambient noise (0.2-0.3) — any real
  // room's waiting-state energy takes the freeze branch on window 1, the EMA
  // pins at the seed forever (adaptation to mic gain is dead), effThr
  // collapses to the fixed floor, ambient noise exceeds it, sync accumulates
  // on noise, the CP probe rejects it, the EMA gets reseeded, and it loops —
  // exactly the false-lock/deafness mode this seed exists to prevent.
  //
  // Seeding at 0.04 instead: freeze sits at 5*0.04=0.20 (below ambient
  // 0.2-0.3, so ambient can still slow-rise the EMA instead of pinning it),
  // and the new signal (0.267-0.299) clears that freeze threshold with a
  // 1.3-1.5x margin so a clean burst still latches. Swept 0.02/0.03/0.04/
  // 0.05/0.07 against the synthetic acoustic-path suite: 0.02-0.04 all score
  // 283/3, 0.05+ score 282/4 — 0.04 is the largest seed that still passes,
  // i.e. the one that sits furthest from the now-thinner ambient-noise
  // margin while remaining in the passing band. Asymmetric update:
  //   - Fast decay (α=0.20) when energy drops below ema
  //   - Slow rise (α=0.05) when ambient noise increases up to 5× ema
  //   - Freeze at >5× ema (sync burst, typically 10-30× noise)
  //
  // Knock-on effect on `ofdmSyncThreshold` (below): with the OLD seed 0.07,
  // 3*ema=0.21 always dominated the fixed 0.06 floor in `effThr = max(0.06,
  // 3*ema)`, so 0.06 was dead code. At the (wrong) 0.02 seed the two became
  // equal (3*0.02=0.06), so the EFFECTIVE minimum threshold silently fell
  // from 0.21 to 0.06 — a ~10.9 dB sensitivity increase that (not the TX
  // level change) is why a naive reseed made the acoustic-path test start
  // passing. At 0.04, 3*ema=0.12 is binding again and the 0.06 floor is
  // dormant (as designed) — do not "clean up" that constant, it is a real
  // safety floor for degenerate low-EMA states, just not the normal path.
  //
  // CONCERN: even at 0.04 the training burst's absolute level (~0.27-0.30)
  // is closer to typical real-room ambient noise (~0.2-0.3) than the old
  // ~0.40 was — the margin is thinner than before, just not inverted.
  // Flagged for real-hardware validation (see task-8-report.md Concern 1).
  private ofdmNoiseEma = 0.04;
  private readonly OFDM_EMA_SEED = 0.04;
  /**
   * Windows processed since the last VALID (CRC-passing) decoded frame —
   * sliding sync-loss watchdog (3b). Reset on every valid frame in
   * processFrame(), NOT gated by an "any frame ever seen" latch — a single
   * garbage/false-lock frame must not permanently disarm it (see below).
   */
  private ofdmWindowsSinceDetect = 0;
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
  /** Phase 6 compression: scheme id carried in the header (0 = raw). */
  private fileSchemeId = 0;
  /** Phase 6 compression: original (pre-compression) size carried in the header. */
  private fileOrigSize = 0;
  /**
   * Wire-byte assembly buffer — preallocated to fileSize on header receipt
   * and written seq-placed (see processPayload) rather than append-in-
   * arrival-order, so a lost/reordered payload frame can't silently shift
   * later bytes into the wrong offset (see receivedPayloadSeqs / 3a).
   */
  private fileData: Uint8Array = new Uint8Array(0);
  private totalFrames = 0;
  private framesReceived = 0;

  // Frame scanner
  private scanner: SentinelScanner;

  // Completed file
  private completedFile: ReceivedFile | null = null;
  /**
   * Monotonic counter incremented each time a file completes (processTail
   * sets completedFile). completedFile itself stays retrievable via getFile()
   * until the next header arrives, so consumers that must not re-deliver the
   * same completed file gate on THIS counter (identity), not on getFile()
   * returning non-null.
   */
  private completionCount = 0;

  /**
   * Phase 4: link profile learned from a decoded PROFILE (0x04) frame.
   * Starts at (and resets to) the base default — all-QPSK, RS t=6, 5ms CP —
   * on every new sync detection and on watchdog reset, so a receiver that
   * never sees a profile frame (legacy TX, or a lost/corrupt profile) stays
   * on exactly today's decoding assumptions.
   */
  private linkProfile: LinkProfile = DEFAULT_LINK_PROFILE(4);

  /**
   * Phase 3 deviation from the plan (documented here — the single place RX
   * switches rate): the plan says "header at base rate," but RX only
   * discovers frame boundaries AFTER assembling bytes, so it cannot switch
   * QAM order per-frame-type mid-stream. Instead, the qamMap applies to
   * EVERYTHING AFTER the profile frame (header + data + tail); RX switches
   * demod tone orders ONCE, right here, immediately after a PROFILE frame
   * parses successfully (see processFrame's FRAME_TYPE_PROFILE case). Reset
   * to all-QPSK happens at every point linkProfile itself resets (new sync,
   * chirp handoff, watchdog) — see resetLinkProfile().
   */
  private toneOrders: QamOrder[] = new Array(4).fill(2) as QamOrder[];
  private allQpsk = true;
  /** Generic (QAM) bit accumulator for the RX bit-serializer (see feedSample). */
  private qamBitAcc = 0;
  private qamBitCount = 0;
  /**
   * Every atomic frame is a fixed FRAME_SIZE bytes, so — for the CONSTANT
   * toneOrders in force between one profile switch and the next — every
   * frame spans the same number of OFDM symbols, `ceil(FRAME_SIZE*8 /
   * bitsPerSymbol)`, with TX zero-padding the last symbol to fill it (see
   * OFDMEngine.modulateFrameGeneric). RX must discard that same padding
   * rather than let it bleed into the next frame's byte alignment — this
   * counter tracks symbols-into-the-current-frame so the bit accumulator can
   * be reset at each frame boundary (computed once at the profile switch;
   * see processFrame's FRAME_TYPE_PROFILE case).
   */
  private qamSymbolsPerFrame = 0;
  private qamSymbolCounter = 0;
  /**
   * Count of valid PROFILE-frame decodes seen since the last reset. TX sends
   * PROFILE_FRAME_REPEATS identical copies, ALL at the base rate, before
   * switching its own modulator — RX must wait for the same count before
   * switching its demod, or it would misinterpret a later base-rate repeat
   * as generic-rate content (see FRAME_TYPE_PROFILE handling in processFrame).
   */
  private profileFramesSeen = 0;
  /**
   * 3e: profile awaiting commit after its FIRST valid decode — see the long
   * comment at the FRAME_TYPE_PROFILE case. Non-null while a switch is
   * armed but not yet applied; the countdown below decides when it fires.
   */
  private profileSwitchPending: LinkProfile | null = null;
  /**
   * Windows still to pass before the pending profile switch is applied —
   * one base-rate profile-frame's worth, so a still-incoming (or garbled)
   * second copy's audio is fully behind us before the demod's tone orders
   * change. Cancelled early (see applyProfileSwitch) if the second copy
   * decodes validly first, matching the pre-3e timing exactly.
   */
  private profileSwitchCountdown = 0;
  /** True once the tone-order switch has been applied for this sync (dedup — see 3e). */
  private profileSwitchApplied = false;
  /**
   * Countdown of QAM reference symbols (see OFDM_TUNING.qamRefSymbols) still
   * to consume right after a non-all-QPSK profile switch. While > 0, each
   * OFDM data window is handed to ofdmDemod.calibrateQamRef() instead of
   * having its bits fed to the scanner (see feedSample). Set at the profile
   * switch (FRAME_TYPE_PROFILE handling below); reset to 0 wherever
   * resetLinkProfile() runs, so an all-QPSK stream never sees it.
   */
  private qamRefPending = 0;
  /**
   * Countdown of TX warm-up symbols (see OFDM_TUNING.qamWarmupSymbols) to
   * DISCARD after the reference symbols, before the header frame. Their
   * content is expendable audio that absorbs the post-ref received-gain
   * transient (measured ~2.4 dB over ~20 symbols) so the header arrives at
   * settled gain; decoding them would only feed garbage bits to the
   * scanner. Set alongside qamRefPending; counted down after it drains.
   */
  private qamWarmupPending = 0;

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
    const settleOverride = (cfg as any).trainingSettleSymbols;
    this.OFDM_SETTLE_SYMBOLS =
      typeof settleOverride === 'number' && Number.isFinite(settleOverride)
        ? Math.max(0, Math.round(settleOverride))
        : OFDM_TUNING.trainingSettleSymbols;

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

    // Phase 4: base link profile, sized to the actual (OFDM) tone count.
    this.resetLinkProfile();

    this.scanner.onFrame = (frame: Uint8Array) => {
      dlog('RX', { scanFrame: frame.length });
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
        const alignCap = 4 * this.sps;
        this.ofdmAlignBuf.push(sample);
        if (this.ofdmAlignBuf.length > alignCap) this.ofdmAlignBuf.shift();
      }
      if (this.ofdmSkip > 0) {
        this.ofdmSkip--;
        return;
      }
    }

    // ── Buffer samples and process by state ──
    this.buf.push(sample);

    // Chirp detector (OFDM only): accumulate every sample for cross-correlation.
    // Only active in WAITING state — once we enter FRAMES, the chirp is done.
    if (this.useOFDM && this.chirpTemplate.length > 0 && this.state === RxState.WAITING) {
      // 7b: fixed-capacity ring push — no per-sample memmove. Capacity ==
      // chirpTemplate.length + sps*2, allocated in initOfdmDemod(); pushing
      // past capacity silently overwrites the oldest sample, same as the old
      // push()-then-shift()-when-over-cap.
      this.chirpBufPush(sample);
      // Run correlation when buffer is large enough; retry every sps samples
      // so the chirp can be detected even if it arrives with acoustic delay.
      this.chirpTick++;
      if (this.chirpBufLen() >= this.chirpTemplate.length + this.sps
          && this.chirpTick >= this.sps && !this.chirpRan) {
        this.chirpTick = 0;
        this.chirpRan = true;
        // Decimate 4:1 for performance. Template side (tplDec/tplEnergy) is
        // hoisted (7c, see initOfdmDemod) — only the live signal needs
        // decimating here.
        const ds = 4;
        const bufLen = this.chirpBufLen();
        const sigDec = new Float32Array(Math.ceil(bufLen / ds));
        for (let i = 0; i < sigDec.length; i++) sigDec[i] = this.chirpBufAt(i * ds);
        const tplDec = this.chirpTemplateDec;
        const { peakValue, peakIndex } = chirpCorrelate(sigDec, tplDec);
        // Normalised threshold: correlation / (template_len × signal_rms).
        const tplEnergy = this.chirpTemplateEnergyDec;
        const sigRms = Math.sqrt(sigDec.reduce((s, v) => s + v * v, 0) / sigDec.length);
        const normScore = sigRms > 0 && tplEnergy > 0
          ? peakValue / (tplDec.length * sigRms)
          : 0;
        if (normScore > 0.15 && peakIndex >= 0) {
          const chirpEndInBuffer = Math.min(
            bufLen,
            peakIndex * ds + this.chirpTemplate.length,
          );
          const samplesAfterChirp = bufLen - chirpEndInBuffer;
          this.chirpEndSample = this.samplesSeen - samplesAfterChirp;
          dlog('OFDM-SYNC', { chirp: true, norm: normScore, peak: peakValue, idx: peakIndex });
          // Flag chirp detected — let the existing CP correlation path
          // (running on ofdmAlignBuf which fills with training OFDM symbols)
          // handle boundary alignment. This reuses the proven ±1-sample
          // CP correlation instead of custom buffer slicing.
          this.chirpDetected = true;
          this.chirpBufClear();
          this.chirpTick = 0;
          this.chirpRan = false;
          // 7a: prompt first probe — see chirpProbeTick's doc.
          this.chirpProbeTick = 0;
          // Suppress energy-based sync: chirp wins, no dual detection
          this.ofdmSyncFrames = 0;
          this.ofdmDemod!.resetTraining();
        } else {
          // Score too low — reset and retry on fresh data.
          dlog('OFDM-SYNC', { chirpMiss: true, norm: normScore, peak: peakValue });
          this.chirpRan = false;
          this.chirpTick = 0;
          // Drop old data, giving new samples a chance (was chirpBuf.slice(-len)).
          this.chirpBufTrimToLast(this.chirpTemplate.length);
        }
      }
    }

    if (this.buf.length < this.sps) return;
    // During active chirp probing we must NOT drain this.buf — probe failures
    // fall through without returning and these windows would be discarded
    // anyway (WAITING doesn't decode frames yet).  Keep this.buf intact so
    // enough samples survive for training + payload after handoff.
    const probingChirp = this.state === RxState.WAITING
      && this.chirpDetected
      && this.useOFDM
      && this.chirpEndSample >= 0
      && (this.samplesSeen - this.chirpEndSample) >= this.sps * 2;
    const window = this.buf.slice(0, this.sps);
    if (!probingChirp) {
      this.buf.splice(0, this.sps);
    }
    // 7a: while actively probing for the chirp→CP handoff boundary, this
    // window's per-tone IQ is dead on arrival — the chirp-handoff branch
    // below only reads chirpEndSample/ofdmAlignBuf, the energy-sync branch
    // is gated off by chirpDetected, and the warble branch recomputes its
    // own toneIQ() over `window` directly. Skip the 4x toneIQ() call (each a
    // 128-sample correlation) entirely on this path; lastRawIQs just holds
    // its last real value (debug-snapshot only, not read on this path).
    let rawIQs: Array<{ i: number; q: number }>;
    let totalE: number;
    if (probingChirp) {
      rawIQs = this.lastRawIQs;
      totalE = 0;
    } else {
      rawIQs = this.toneFreqs.map((f) => toneIQ(window, f, this.cfg.sampleRate));
      this.lastRawIQs = rawIQs; // Store for debug snapshot
      totalE = rawIQs.reduce((a, r) => a + Math.hypot(r.i, r.q), 0);
    }

    // ── WAITING: detect sync (OFDM or warble) ──
    if (this.state === RxState.WAITING) {
      // ── Chirp → CP handoff: chirp correlation fired; training OFDM
      //    symbols are already accumulating in ofdmAlignBuf. Run the
      //    proven CP boundary check (same as energy-sync path).
      const samplesAfterChirp = this.chirpEndSample >= 0
        ? this.samplesSeen - this.chirpEndSample
        : 0;
      if (this.chirpDetected && this.useOFDM && samplesAfterChirp >= this.sps * 2) {
        // 7a: throttle the O(sps × cp × periods) boundary probe to once per
        // sps samples — see chirpProbeTick's doc. chirpProbeTick starts at 0
        // so the FIRST probe after detection still fires the moment this
        // block is first reachable (i.e. right after the existing sps*2
        // settle delay above), not delayed by a further full sps wait.
        if (this.chirpProbeTick > 0) {
          this.chirpProbeTick--;
        } else {
          this.chirpProbeTick = this.sps;
          const trainingSamples = Math.min(samplesAfterChirp, this.ofdmAlignBuf.length);
          const trainingStart = this.ofdmAlignBuf.length - trainingSamples;
          const trainingTail = this.ofdmAlignBuf.slice(trainingStart);
          const probe = this.findOfdmBlockStart(trainingTail);
          if (probe.offset >= 0 && probe.score >= OFDM_TUNING.cpCorrelationMinScore && probe.sharpness >= OFDM_TUNING.cpCorrelationMinSharpness) {
            // 3f: capture pre-clear values for the diagnostic log below — both
            // ofdmAlignBuf and chirpEndSample get cleared/reset in this same
            // block, so logging them afterward (as before) always printed 0/-1.
            const chirpEndSampleAtHandoff = this.chirpEndSample;
            const ofdmAlignBufLenAtHandoff = this.ofdmAlignBuf.length;
            this.chirpDetected = false;
            this.chirpEndSample = -1;
            // CP correlation reports offsets modulo one symbol. A peak near the
            // end (e.g. sps-1) is the equivalent one-sample-early boundary, not
            // a reason to discard almost a full training symbol. Keep that
            // signed offset so all configured training symbols reach the demod.
            const signedBoundary = probe.offset > this.sps / 2
              ? probe.offset - this.sps
              : probe.offset;
            const alignedStart = Math.max(0, trainingStart + signedBoundary);
            this.buf = this.ofdmAlignBuf.slice(alignedStart);
            this.ofdmAlignBuf = [];
            this.ofdmSyncFrames = 0;
            this.state = RxState.FRAMES;
            this.ofdmWindowsSinceDetect = 0;
            this.ofdmTrainingSymbols = 0;
            this.ofdmSettleSymbols = 0;
            this.ofdmDemod!.resetTraining();
            // 3c: same file-assembly + dedup resets the energy-sync path does
            // (below) — without these, a retry of the SAME fileID right after
            // a chirp-handoff resync was silently swallowed by processHeader's
            // dup-header check (fileID===this.fileID && fileName!=='').
            this.fileData = new Uint8Array(0);
            this.fileID = 0;
            this.fileName = '';
            this.fileSize = 0;
            this.totalFrames = 0;
            this.framesReceived = 0;
            this.receivedPayloadSeqs = new Set();
            // Phase 4: new sync detected — reset to the base link profile.
            this.resetLinkProfile();
            dlog('OFDM-SYNC', {
              chirpHandoff: true,
              boundary: signedBoundary,
              trainingSamples,
              score: probe.score,
              bufLenBeforeReplace: ofdmAlignBufLenAtHandoff - alignedStart,
              samplesSeenAtHandoff: this.samplesSeen,
              chirpEndSample: chirpEndSampleAtHandoff,
              ofdmSkipValue: this.ofdmSkip,
            });
            return;
          } else {
            // Probe failed - log for diagnostics
            dlog('OFDM-SYNC', { chirpProbeFail: true, score: probe.score, sharpness: probe.sharpness, offset: probe.offset, bufLen: this.ofdmAlignBuf.length });
          }
        }
        // Safety valve: if the chirp probe stays stuck for many symbols, the
        // detected chirp is probably stale or the buffer is corrupt. Fall
        // back to energy-based sync rather than re-probing forever. This
        // must run every sample (NOT gated by chirpProbeTick above) — only
        // the expensive probe itself is throttled; samplesAfterChirp keeps
        // incrementing every sample regardless, so the timeout has to be
        // checked at the same cadence or it can fire up to sps-1 samples
        // late.
        if (samplesAfterChirp > this.sps * 16) {
          dlog('OFDM-SYNC', { chirpProbeTimeout: true, samplesAfterChirp }, { level: 'warn' });
          this.chirpDetected = false;
          this.chirpEndSample = -1;
        }
      }

      // OFDM mode: detect energy at the tone frequencies (not just pilot).
      // The sync burst has all 4 tones at QPSK 0°, so total tone energy is high.
      if (this.useOFDM && this.ofdmDemod && !this.chirpDetected) {
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
        // Asymmetric noise-floor tracking:
        //   - Fast decay when energy drops (α=0.20)
        //   - Slow rise when ambient noise increases (α=0.05)
        //   - Freeze when energy jumps >5× (sync burst — don't pollute floor).
        //     5× (not 2×) so sustained noise above the seed can still adapt
        //     the EMA upward; sync bursts are typically 10-30× noise.
        if (totalE < this.ofdmNoiseEma) {
          this.ofdmNoiseEma = this.ofdmNoiseEma * 0.8 + totalE * 0.2;
        } else if (totalE < 5 * this.ofdmNoiseEma) {
          this.ofdmNoiseEma = this.ofdmNoiseEma * 0.95 + totalE * 0.05;
        }
        const effThr = Math.max(this.ofdmSyncThreshold, 3 * this.ofdmNoiseEma);
        // Heartbeat while waiting: 1 line per 25 windows (~2/s)
        dlog('OFDM-SYNC',
          { e: dlogFmt(totalE), thr: dlogFmt(effThr), sync: this.ofdmSyncFrames },
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
          if (probe.score < OFDM_TUNING.cpCorrelationMinScore || probe.sharpness < OFDM_TUNING.cpCorrelationMinSharpness) {
            dlog('OFDM-SYNC',
              { reject: true, e: dlogFmt(totalE), score: dlogFmt(probe.score), sharp: dlogFmt(probe.sharpness) },
              { level: 'warn' },
            );
            this.ofdmSyncFrames = 0;
            this.ofdmNoiseEma = this.OFDM_EMA_SEED;
            return;
          }

          // Signal detected! Enter FRAMES state.
          dlog('OFDM-SYNC', { detected: true, e: dlogFmt(totalE) });
          this.ofdmWindowsSinceDetect = 0;
          this.state = RxState.FRAMES;
          this.fileData = new Uint8Array(0);
          this.framesReceived = 0;
          this.receivedPayloadSeqs = new Set();
          this.fileID = 0;
          this.fileName = '';
          this.fileSize = 0;
          this.totalFrames = 0;
          this.ofdmSyncFrames = 0;
          this.ofdmTrainingSymbols = 0;
          this.ofdmSettleSymbols = 0;
          this.ofdmDemod?.resetTraining();
          // Phase 4: new sync detected — reset to the base link profile.
          this.resetLinkProfile();

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
            dlog('OFDM-SYNC',
              { boundary, skip, score: dlogFmt(score) },
              { level: score < 0.5 ? 'warn' : 'info' },
            );
          } else {
            dlog('OFDM-SYNC', { aligned: false, buf: this.ofdmAlignBuf.length }, { level: 'warn' });
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
          this.fileData = new Uint8Array(0);
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
      // 3b: this now fires purely on "no VALID frame in N windows" — it used
      // to be permanently disarmed by a single garbage/false-lock frame (any
      // scanner frame, even one that fails CRC, used to set ofdmFrameSeen
      // and never clear it). ofdmWindowsSinceDetect is reset to 0 on every
      // CRC-valid decode in processFrame(), which is the only thing that
      // should keep this watchdog quiet.
      this.ofdmWindowsSinceDetect++;
      if (this.ofdmWindowsSinceDetect > this.OFDM_WATCHDOG_WINDOWS) {
        dlog('OFDM-SYNC', { watchdogReset: true, windows: this.ofdmWindowsSinceDetect }, { level: 'warn' });
        this.state = RxState.WAITING;
        this.ofdmSyncFrames = 0;
        this.ofdmNoiseEma = this.OFDM_EMA_SEED;
        this.ofdmTrainingSymbols = 0;
        this.ofdmSettleSymbols = 0;
        this.ofdmDemod.discardMER();
        this.ofdmDemod.resetTraining();
        // Phase 4: watchdog reset — back to the base link profile.
        this.resetLinkProfile();
        this.buf = [];
        this.ofdmAlignBuf = [];
        return;
      }

      // Settling period: discard the first N sync symbols outright so channel
      // estimates are taken with the transmitting chain in the same gain state
      // the data will see, not the compressed one the chirp leaves behind (see
      // OFDM_TUNING.trainingSettleSymbols). TX emits these ahead of the
      // training symbols, so skipping them here consumes real signal, not
      // silence, and the count must match the TX's exactly.
      if (this.ofdmSettleSymbols < this.OFDM_SETTLE_SYMBOLS) {
        this.ofdmSettleSymbols++;
        if (this.ofdmSettleSymbols >= this.OFDM_SETTLE_SYMBOLS) {
          dlog('OFDM-TRAIN', { settled: this.ofdmSettleSymbols });
        }
        return; // Not training yet, and definitely not data.
      }

      // OFDM training phase: use first N symbols of sync burst to train channel estimates
      if (this.ofdmTrainingSymbols < this.OFDM_TRAINING_SYMBOLS) {
        this.ofdmDemod.trainOnSyncSymbol(window);
        this.ofdmTrainingSymbols++;
        if (this.ofdmTrainingSymbols >= this.OFDM_TRAINING_SYMBOLS) {
          dlog('OFDM-TRAIN', { 
            done: true, 
            symbols: this.ofdmTrainingSymbols,
            bufLenRemaining: this.buf.length,
            samplesSeen: this.samplesSeen,
          });
        }
        return; // Don't process bits during training
      }

      // Log transition from training → data (once)
      if (this.ofdmDataSymbolCounter === 0) {
        dlog('OFDM-DEMOD', { enteringDataPhase: true, bufLenAtEntry: this.buf.length, samplesSeen: this.samplesSeen }, { level: 'info' });
      }

      // Count how many data symbols we're processing — helps debug why only
      // one symbol was decoded before buffer ran dry.
      this.ofdmDataSymbolCounter = (this.ofdmDataSymbolCounter ?? 0) + 1;

      // 3e: advance the armed-but-not-yet-committed profile switch. Waits
      // exactly one base-rate profile-frame's worth of windows (reserving
      // the slot the second copy would occupy, present or not) before
      // committing — see applyProfileSwitch's caller in processFrame for
      // why this can't just switch immediately on the first valid decode.
      if (this.profileSwitchPending && !this.profileSwitchApplied) {
        if (this.profileSwitchCountdown > 0) {
          this.profileSwitchCountdown--;
        } else {
          const pending = this.profileSwitchPending;
          this.profileSwitchPending = null;
          this.applyProfileSwitch(pending);
        }
      }

      // OFDM demodulation — FFT + per-tone equalization + slicing.
      const result = this.ofdmDemod.demodulate(window);

      // QAM reference symbols (see qamRefPending's doc): consume them for
      // calibration instead of feeding their (meaningless-as-data) bits to
      // the scanner. demodulate() above still ran on this window — this
      // just re-derives the raw tone IQ separately (analyze() is pure).
      // Ref symbols come FIRST, then the warm-up (see txEngine: the warm-up
      // absorbs the post-ref gain transient, so it sits between the refs and
      // the header frame). Consume refs for calibration, then discard the
      // warm-up entirely (no scan, no calibration).
      if (this.qamRefPending > 0) {
        this.qamRefPending--;
        this.ofdmDemod.calibrateQamRef(window);
        return;
      }

      if (this.qamWarmupPending > 0) {
        this.qamWarmupPending--;
        return;
      }

      if (this.allQpsk) {
        // ── Legacy all-QPSK path — UNCHANGED, byte-identical to the pre-QAM
        // receiver. Tones are grouped in 4-tone blocks; each block carries
        // one byte (b0 lane = upper nibble, b1 lane = lower nibble — matches
        // the BPSK frame-pair format consumed below). 8 tones → 2 bytes/symbol. ──
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
        // ── Generic per-tone bit-serializer (QAM path) — the exact inverse
        // of OFDMEngine.modulateFrameGeneric: result.bits already carries
        // toneOrders[t] bits per tone, tone-major, MSB-first (see
        // OFDMQPSKDemodulator's QAM branch). Accumulate into a byte buffer
        // and feed the scanner directly — bypassing the legacy bchBuf/
        // frame-pair bridge entirely, since it only makes sense for the
        // fixed 2-bits/tone QPSK layout.
        for (let bi = 0; bi < result.bits.length; bi++) {
          this.qamBitAcc = (this.qamBitAcc << 1) | result.bits[bi];
          this.qamBitCount++;
          if (this.qamBitCount === 8) {
            this.scanner.feedByte(this.qamBitAcc & 0xff);
            this.qamBitAcc = 0;
            this.qamBitCount = 0;
          }
        }
        // Frame-boundary reset — discard this frame's tail zero-padding
        // before the next frame's real bytes start (see qamSymbolsPerFrame's
        // doc). qamSymbolsPerFrame is 0 until the first profile switch sets
        // it, so this is a no-op before that.
        if (this.qamSymbolsPerFrame > 0) {
          this.qamSymbolCounter++;
          if (this.qamSymbolCounter >= this.qamSymbolsPerFrame) {
            this.qamSymbolCounter = 0;
            this.qamBitAcc = 0;
            this.qamBitCount = 0;
          }
        }
        for (let t = 0; t < TONE_COUNT && t < result.toneIQ.length; t++) {
          rawIQs[t] = result.toneIQ[t];
        }
        this.pilotAmplitude = result.pilotAmplitude;
        return; // bytes already fed directly — skip the legacy debug/bchBuf machinery below.
      }
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
        `[RX] Frame ${this.dbgFrameCount}: ${this.receivedByteCount()}B assembled (${this.framesReceived} payload frames)`,
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

  /**
   * Reset to the base link profile — all-QPSK, RS t=6, 5ms CP — and the
   * matching demod tone orders + generic bit accumulator. Called on every
   * new sync detection, chirp handoff, and watchdog reset, plus RxEngine's
   * own reset(), so a receiver that hasn't (yet, or ever) seen a valid
   * PROFILE frame always decodes assuming exactly today's modulation.
   */
  private resetLinkProfile(): void {
    const oldToneCount = this.ofdmToneCount;
    this.linkProfile = DEFAULT_LINK_PROFILE(this.ofdmToneCount);
    this.toneOrders = new Array(this.ofdmToneCount).fill(2) as QamOrder[];
    this.allQpsk = true;
    // Don't call setToneOrders here — let the PROFILE frame do it so we
    // don't waste training symbols re-syncing after an unnecessary switch.
    this.qamBitAcc = 0;
    this.qamBitCount = 0;
    this.qamSymbolsPerFrame = 0;
    this.qamSymbolCounter = 0;
    this.profileFramesSeen = 0;
    this.qamRefPending = 0;
    this.qamWarmupPending = 0;
    this.profileSwitchPending = null;
    this.profileSwitchCountdown = 0;
    this.profileSwitchApplied = false;
    // If tone count changed during reset, rebuild the demodulator to match.
    if (oldToneCount !== this.ofdmToneCount) {
      dlog('RX-OFDM', { toneCountChange: true, from: oldToneCount, to: this.ofdmToneCount }, { level: 'info' });
      this.initOfdmDemod();
    }
  }

  /**
   * Windows one atomic frame spans at the CURRENT (base/legacy) rate — i.e.
   * the wire-time of one PROFILE copy, since profile frames are always sent
   * at the base rate. Used by the 3e switch-countdown to know how long a
   * (possibly lost/garbled) second copy would occupy.
   */
  private baseRateWindowsPerFrame(): number {
    const blockCount = Math.max(1, Math.floor(this.ofdmToneCount / 4));
    return Math.ceil(FRAME_SIZE / blockCount);
  }

  /**
   * Commit a profile's tone-order switch — the single point where RX
   * changes how it demodulates header/data/tail (see the FRAME_TYPE_PROFILE
   * case and the 3e countdown in feedSample for WHEN this is called).
   */
  private applyProfileSwitch(profile: LinkProfile): void {
    this.toneOrders = qamMapToOrders(profile.qamMap);
    this.allQpsk = this.toneOrders.every((o) => o === 2);
    this.ofdmDemod?.setToneOrders(this.toneOrders);
    // QAM reference symbols (see OFDM_TUNING.qamRefSymbols doc): TX only
    // inserts these when some tone is above QPSK, so only wait for them in
    // that case — an all-QPSK stream is unaffected.
    this.qamRefPending = this.allQpsk ? 0 : OFDM_TUNING.qamRefSymbols;
    this.qamWarmupPending = this.allQpsk ? 0 : OFDM_TUNING.qamWarmupSymbols;
    dlog('RX-PROFILE', {
      t: profile.toneCount,
      eccT: profile.eccT,
      qam: profile.qamMap.join(','),
      ord: this.toneOrders.join(','),
    });
    // Every subsequent frame (header/data/tail) is FRAME_SIZE bytes at this
    // same (now-fixed) rate, so it spans a constant symbol count — reset
    // the generic bit-serializer's frame-boundary tracking (see
    // qamSymbolsPerFrame's doc) so tail zero-padding never bleeds into the
    // next frame's byte alignment.
    if (this.allQpsk) {
      this.qamSymbolsPerFrame = 0;
    } else {
      const bitsPerSymbol = this.toneOrders.reduce((a, b) => a + b, 0);
      this.qamSymbolsPerFrame = Math.ceil((FRAME_SIZE * 8) / bitsPerSymbol);
    }
    this.qamSymbolCounter = 0;
    this.qamBitAcc = 0;
    this.qamBitCount = 0;
    this.profileSwitchApplied = true;
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
      // 3a: derived from the received-seq set, not fileData.length — the
      // buffer is now preallocated to fileSize up front (see processHeader).
      bytesAssembled: this.receivedByteCount(),
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
    const demodToneFreqs = ofdmToneFrequencies({ toneCount: ofdmToneCount, pilotFreqHz: this.cfg.pilotFreqHz, startHz: this.cfg.toneStartHz });
    this.ofdmToneFreqs = demodToneFreqs;
    // deCoheredSyncBurst: OFDMEngine de-coheres the sync/training burst, so the
    // demodulator must divide the known per-tone phase back out. TX and RX must
    // agree exactly — see OFDMQPSKDemodulatorConfig.deCoheredSyncBurst.
    this.ofdmDemod = new OFDMQPSKDemodulator({
      deCoheredSyncBurst: true,
      sampleRate: this.cfg.sampleRate,
      toneFrequencies: demodToneFreqs,
      pilotFreqHz: this.cfg.pilotFreqHz,
    });
    // Pre-compute chirp template for sync detection
    // MUST match what TxEngine transmits: OFDM_TUNING.chirpSymbols, not
    // syncBurstSymbols. Those were the same value until the chirp length was
    // decoupled from the sync-burst pool; reading the wrong one here produces a
    // template of the wrong duration, the normalized correlation collapses, and
    // nothing syncs at all.
    const chirpDurationSec = (OFDM_TUNING.chirpSymbols * symSamples) / this.cfg.sampleRate;
    const halfSpan = this.chirpSpanHz / 2;
    const chirpCfg: ChirpConfig = {
      // MUST match OFDMEngine.generateChirpBurst: centred on
      // OFDM_TUNING.chirpCenterHz, not on the pilot. Deriving it from the pilot
      // here would make the template the wrong shape the moment the pilot moves.
      fStart: OFDM_TUNING.chirpCenterHz - halfSpan,
      fEnd: OFDM_TUNING.chirpCenterHz + halfSpan,
      durationSec: chirpDurationSec,
      sampleRate: this.cfg.sampleRate,
    };
    this.chirpTemplate = generateChirp(chirpCfg);
    // 7c: hoist the decimated (4:1) template + its energy — both constant
    // for this config — out of the per-attempt correlation path below.
    const ds = 4;
    const tplDec = new Float32Array(Math.ceil(this.chirpTemplate.length / ds));
    for (let i = 0; i < tplDec.length; i++) tplDec[i] = this.chirpTemplate[i * ds];
    this.chirpTemplateDec = tplDec;
    this.chirpTemplateEnergyDec = tplDec.reduce((s, v) => s + v * v, 0);
    // 7b: (re)allocate the chirpBuf ring at its fixed capacity for this
    // config and reset it — mirrors the old `this.chirpBuf = []` a fresh
    // demod init implied.
    this.chirpBufData = new Float32Array(this.chirpTemplate.length + this.sps * 2);
    this.chirpBufClear();
    return demodToneFreqs;
  }

  // ─── chirpBuf ring-buffer access (7b) ────────────────
  // Fixed-capacity FIFO over chirpBufData: writes always land at
  // (head+count) % cap while count < cap; once full, the oldest slot
  // (at head) is overwritten and head advances — equivalent to the old
  // push()-then-shift()-when-over-cap, without ever memmoving the array.

  private chirpBufLen(): number {
    return this.chirpBufCount;
  }

  private chirpBufPush(sample: number): void {
    const cap = this.chirpBufData.length;
    if (cap === 0) return;
    if (this.chirpBufCount < cap) {
      this.chirpBufData[(this.chirpBufHead + this.chirpBufCount) % cap] = sample;
      this.chirpBufCount++;
    } else {
      this.chirpBufData[this.chirpBufHead] = sample;
      this.chirpBufHead = (this.chirpBufHead + 1) % cap;
    }
  }

  /** Read the element at logical index `idx` (0 = oldest, count-1 = newest). */
  private chirpBufAt(idx: number): number {
    const cap = this.chirpBufData.length;
    if (cap === 0 || idx < 0 || idx >= this.chirpBufCount) return 0;
    return this.chirpBufData[(this.chirpBufHead + idx) % cap];
  }

  private chirpBufClear(): void {
    this.chirpBufHead = 0;
    this.chirpBufCount = 0;
  }

  /** Equivalent of `chirpBuf.slice(-n)` — keep only the most recent n elements. */
  private chirpBufTrimToLast(n: number): void {
    const cap = this.chirpBufData.length;
    const keep = Math.min(this.chirpBufCount, Math.max(0, n));
    if (cap === 0) {
      this.chirpBufCount = keep;
      return;
    }
    this.chirpBufHead = (this.chirpBufHead + (this.chirpBufCount - keep)) % cap;
    this.chirpBufCount = keep;
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

  /** Monotonic count of files completed by this engine instance. See completionCount. */
  getCompletionCount(): number {
    return this.completionCount;
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
    this.fileData = new Uint8Array(0);
    this.framesReceived = 0;
    this.receivedPayloadSeqs = new Set();
    this.fileName = '';
    this.fileSize = 0;
    this.totalFrames = 0;
    this.completedFile = null;
    this.ofdmSyncFrames = 0;
    this.chirpRan = false;
    this.chirpTick = 0;
    this.chirpDetected = false;
    this.chirpEndSample = -1;
    this.chirpProbeTick = 0;
    // chirpBuf ring is reset by initOfdmDemod() above (useOFDM path); for
    // non-OFDM configs there's no ring to clear.
    this.chirpBufClear();
    this.scanner.reset();
    // Phase 4: back to the base link profile.
    this.resetLinkProfile();
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

  /** Log a concise failure diagnosis when a frame does not decode. */
  private logFrameFailure(
    decoded: ReturnType<typeof decodeFrame>,
    stagedMerDb: number | null = null,
  ): void {
    const fields: Record<string, unknown> = {
      r: decoded.failureReason,
      t: decoded.header ? `0x${decoded.header.type.toString(16)}` : '?',
      s: decoded.header?.seqNum ?? -1,
    };

    if (decoded.crcMismatch) fields.crc = 1;
    if (decoded.bchErrorCounts.some((e) => e > 0)) {
      fields.bch = decoded.bchErrorCounts.join(',');
    }
    if (decoded.rsBlockErrors.length > 0 && decoded.rsBlockErrors.some((e) => e !== 0)) {
      fields.rs = decoded.rsBlockErrors.join(',');
    }

    if (this.useOFDM && this.ofdmDemod) {
      const mer = this.ofdmDemod.getMER();
      if (mer) fields.mer = dlogFmt(mer.merDb);
      // Staged MER of the frame that just failed. Captured before discardMER()
      // wiped it, and the only signal-quality figure available when nothing
      // decodes — auto-tune hill-climbs on it.
      if (stagedMerDb !== null) fields.smer = dlogFmt(stagedMerDb);
    } else {
      fields.pa = dlogFmt(this.pilotAmplitude);
    }

    dlog('RX-FAIL', fields, { level: 'warn' });
  }

  private processFrame(frame: Uint8Array): void {
    // CRC validation happens inside decodeFrame (post-BCH). Raw frame bytes
    // 5-6 are pre-decode and would be misleading to log against it.
    const decoded = decodeFrame(frame);

    // Read the staged MER before commit/discard clears it — it is the only
    // signal-quality figure a fully-failing config ever produces (diagnostic).
    const stagedMer = this.useOFDM ? (this.ofdmDemod?.getStagedMER() ?? null) : null;

    const frameFields: Record<string, unknown> = {
      ok: decoded.valid,
      t: decoded.header ? `0x${decoded.header.type.toString(16)}` : '?',
      s: decoded.header?.seqNum ?? -1,
    };
    // Per-frame MER and pilot amplitude expose channel drift across a
    // transfer (MER decay with stable pa = timing/EQ drift; both decaying
    // together = gain sag from AEC/compression).
    if (stagedMer) frameFields.mer = dlogFmt(stagedMer.merDb);
    if (this.useOFDM) frameFields.pa = dlogFmt(this.pilotAmplitude);
    dlog('RX-FRAME', frameFields);
    // Gate MER accumulation to windows that belong to a successfully-decoded
    // frame — commit the staged stats on success, throw them away on failure,
    // so the "how much SNR headroom exists" number never includes garbage
    // demodulated during inter-send silence or a corrupt frame.
    if (decoded.valid) {
      this.ofdmDemod?.commitMER();
    } else {
      // Report the per-tone SHAPE before dropping it. A failing config never
      // produces the committed per-tone report (that only runs after a decode),
      // so without this the one question that decides the next fix — is the
      // damage flat across tones or tilted? — has no answer in the log.
      if (this.ofdmDemod?.hasStagedMER()) {
        dlog('OFDM-STMER', {
          db: this.ofdmDemod.getStagedPerToneMER().map((m) => Math.round(m)).join(','),
        });
      }
      this.ofdmDemod?.discardMER();
    }

    if (!decoded.valid) {
      this.logFrameFailure(decoded, stagedMer ? stagedMer.merDb : null);
      return;
    }

    // 3b: sliding sync-loss watchdog — reset on every VALID (CRC-passing)
    // frame, not just "any frame the scanner ever produced" (see the
    // watchdog check above, which used to be permanently disarmed by one
    // garbage/false-lock frame).
    this.ofdmWindowsSinceDetect = 0;

    if (decoded.header!.totalFrames > 0) this.totalFrames = decoded.header!.totalFrames;

    switch (decoded.header!.type) {
      case FRAME_TYPE_HEADER:
        this.processHeader(decoded.payload);
        break;
      case FRAME_TYPE_PAYLOAD:
        this.processPayload(decoded.payload, decoded.header!.seqNum);
        break;
      case FRAME_TYPE_TAIL:
        dlog('RX-FRAME', { tail: true, assembled: this.receivedByteCount(), size: this.fileSize });
        this.processTail();
        break;
      case FRAME_TYPE_PROFILE: {
        // Phase 4: parse+store only — NOT fed to file assembly. Always
        // handled regardless of the TX-side emit flag: a new RX may receive
        // a profile-bearing stream from any sender. crc/ver mismatch is
        // silently ignored (stay on current/default profile).
        const profile = parseLinkProfile(decoded.payload);
        if (!profile) {
          dlog('RX-PROFILE', { invalid: true }, { level: 'warn' });
          break;
        }
        if (profile.toneCount !== this.ofdmToneCount) {
          dlog('RX-PROFILE', { 
            tcMismatch: true, 
            got: profile.toneCount, 
            want: this.ofdmToneCount,
            eccT: profile.eccT,
            qamMap: profile.qamMap.slice(0, 8).join(','),
          }, { level: 'warn' });
          // Receiver was initialized with a different tone count than what
          // the TX actually uses. Adapt dynamically: rebuild the demodulator
          // to match the announced tone count, then fall through to process
          // the profile at the correct rate.
          dlog('RX-OFDM', { adaptingToneCount: true, newCount: profile.toneCount }, { level: 'info' });
          this.ofdmToneCount = profile.toneCount;
          this.ofdmToneFreqs = ofdmToneFrequencies({ toneCount: profile.toneCount, pilotFreqHz: this.cfg.pilotFreqHz, startHz: this.cfg.toneStartHz });
          // deCoheredSyncBurst: OFDMEngine de-coheres the sync/training burst, so the
    // demodulator must divide the known per-tone phase back out. TX and RX must
    // agree exactly — see OFDMQPSKDemodulatorConfig.deCoheredSyncBurst.
    this.ofdmDemod = new OFDMQPSKDemodulator({
      deCoheredSyncBurst: true,
            sampleRate: this.cfg.sampleRate,
            toneFrequencies: this.ofdmToneFreqs,
            pilotFreqHz: this.cfg.pilotFreqHz,
          });
          // Reset training so fresh symbols can be accumulated.
          this.ofdmDemod.resetTraining();
          this.ofdmTrainingSymbols = 0;
          this.ofdmSettleSymbols = 0;
          // Re-initialize link profile for the new tone count.
          this.linkProfile = DEFAULT_LINK_PROFILE(profile.toneCount);
          this.toneOrders = new Array(profile.toneCount).fill(2) as QamOrder[];
          this.allQpsk = true;
          // FALL THROUGH — process the profile below with matching tone count.
        }
        this.linkProfile = profile;
        this.profileFramesSeen++;
        // 3e: TX always sends PROFILE_FRAME_REPEATS identical copies, ALL at
        // the base rate, before switching its own modulator. Requiring BOTH
        // to decode (the old `profileFramesSeen >= PROFILE_FRAME_REPEATS`
        // gate) meant one lost/garbled copy left RX on the default profile
        // forever — misdemodulating the entire rest of the transfer. A
        // profile frame is CRC-protected, so a single valid decode is
        // trustworthy on its own; but switching the demod's tone orders
        // right away would be WRONG whenever the second copy's audio is
        // still physically incoming (still base-rate on the wire) — RX
        // would slice it with the new (mismatched) order and desync the
        // generic bit-serializer's frame-boundary tracking for everything
        // after it. So: arm the switch on the FIRST valid decode, but only
        // *commit* it once we've either (a) seen the natural second decode
        // (today's exact timing — the common, lossless case), or (b) let
        // exactly one more base-rate profile-frame's worth of OFDM windows
        // elapse without one (see the countdown in feedSample) — i.e. the
        // point where the second copy's audio, present or not, is behind
        // us. See applyProfileSwitch() / profileSwitchCountdown.
        if (!this.profileSwitchApplied) {
          if (this.profileFramesSeen <= 1) {
            this.profileSwitchPending = profile;
            this.profileSwitchCountdown = this.baseRateWindowsPerFrame();
            dlog('RX-PROFILE', { armed: true, countdownWindows: this.profileSwitchCountdown });
          } else {
            // Natural second copy decoded — switch now (unchanged timing).
            this.profileSwitchPending = null;
            this.applyProfileSwitch(profile);
          }
        } else {
          dlog('RX-PROFILE', { alreadySwitched: true });
        }
        break;
      }
      default:
        // Unknown/future frame type — legacy-compatible silent drop.
        break;
    }
  }

  /** Phase 4: current link profile (defaults until a valid PROFILE frame is seen). */
  getLinkProfile(): LinkProfile {
    return this.linkProfile;
  }

  /** Track received payload sequence numbers for diversity-mode dedup */
  private receivedPayloadSeqs = new Set<number>();

  private processHeader(payload: Uint8Array): void {
    // Header payload format:
    // [fileID:4B][totalSize:4B][nameLen:1B][name...][schemeId:1B][origSize:4B LE][padding...]
    // The trailing [schemeId][origSize] (Phase 6 compression) live in what
    // used to be the zero-pad region — a legacy RX simply never reads that
    // far, so this is backward compatible.
    const fileID = (payload[0] << 24) | (payload[1] << 16) | (payload[2] << 8) | payload[3];

    // Duplicate header (diversity mode repetition) — ignore, keep existing state
    if (fileID === this.fileID && this.fileName !== '') {
      dlog('RX-FRAME', { dupHeader: true });
      return;
    }

    const totalSize =
      (payload[4] | (payload[5] << 8) | (payload[6] << 16) | (payload[7] << 24)) >>> 0;
    const nameLen = Math.min(payload[8] & 0xff, PAYLOAD_DATA_SIZE - 9 - 5);

    let name = '';
    for (let i = 0; i < nameLen; i++) {
      const c = payload[9 + i];
      if (c >= 0x20 && c <= 0x7e) name += String.fromCharCode(c);
    }

    // [schemeId:1][origSize:4 LE] appended right after the name. Treat an
    // absent/short/zero region as raw (schemeId 0) — this is what a stream
    // produced before Phase 6 (or a truncated/corrupt header) looks like.
    const schemeOff = 9 + nameLen;
    let schemeId = 0;
    let origSize = totalSize;
    if (schemeOff + 5 <= payload.length) {
      const sid = payload[schemeOff] & 0xff;
      const os =
        (payload[schemeOff + 1] |
          (payload[schemeOff + 2] << 8) |
          (payload[schemeOff + 3] << 16) |
          (payload[schemeOff + 4] << 24)) >>>
        0;
      if (sid !== 0 && os > 0) {
        schemeId = sid;
        origSize = os;
      }
    }

    this.fileID = fileID;
    this.fileSize = totalSize;
    this.fileName = name;
    this.fileSchemeId = schemeId;
    this.fileOrigSize = origSize;
    // 3a: preallocate the exact wire size — payload frames write seq-placed
    // (see processPayload), so a lost frame can never shift later bytes.
    this.fileData = new Uint8Array(totalSize);
    this.receivedPayloadSeqs = new Set();
    this.framesReceived = 1; // header frame counts toward progress
    dlog('RX-COMP', { scheme: schemeId, wire: totalSize, orig: origSize });
  }

  /** Number of DATA frames expected between header and tail (0 if unknown/degenerate). */
  private expectedDataFrameCount(): number {
    return Math.max(0, this.totalFrames - 2);
  }

  /** Bytes actually placed so far, derived from the received-seq set (not fileData.length — see 3a). */
  private receivedByteCount(): number {
    let bytes = 0;
    for (const seq of this.receivedPayloadSeqs) {
      const offset = (seq - 1) * PAYLOAD_DATA_SIZE;
      if (offset >= this.fileSize) continue;
      bytes += Math.min(PAYLOAD_DATA_SIZE, this.fileSize - offset);
    }
    return bytes;
  }

  private processPayload(payload: Uint8Array, seqNum: number): void {
    if (!this.fileName) return;

    // Skip duplicate payload frames (diversity mode repetition)
    if (this.receivedPayloadSeqs.has(seqNum)) {
      dlog('RX-FRAME', { dupPayload: seqNum });
      return;
    }
    this.receivedPayloadSeqs.add(seqNum);

    // 3a: seq-placed write — offset is derived from the wire seq number
    // (payload seq 1 == first data frame; see txEngine's frameSegments),
    // NOT from arrival order, so a dropped frame can't shift later bytes.
    const offset = (seqNum - 1) * PAYLOAD_DATA_SIZE;
    if (offset < 0 || offset >= this.fileSize) {
      dlog('RX-FRAME', { badPayloadSeq: seqNum, offset }, { level: 'warn' });
      this.framesReceived++;
      return;
    }
    const writeLen = Math.min(payload.length, this.fileSize - offset);
    this.fileData.set(payload.subarray(0, writeLen), offset);
    this.framesReceived++;
  }

  private processTail(): void {
    if (!this.fileName || this.fileSize === 0) {
      // Duplicate tail (diversity mode) — already handled, or no data yet
      return;
    }

    // Already completed (duplicate tail from diversity mode)
    if (this.state === RxState.COMPLETE) {
      dlog('RX-FRAME', { dupTail: true });
      return;
    }

    // 3a: only deliver if every expected payload seq actually arrived —
    // otherwise a lost frame would silently leave its byte range zeroed
    // (preallocated Uint8Array) and produce a corrupt-but-"COMPLETE" file.
    const expected = this.expectedDataFrameCount();
    const missing: number[] = [];
    for (let seq = 1; seq <= expected; seq++) {
      if (!this.receivedPayloadSeqs.has(seq)) missing.push(seq);
    }
    if (missing.length > 0) {
      dlog(
        'RX-FAIL',
        { incompleteTail: true, missing: missing.join(','), received: this.receivedPayloadSeqs.size, expected },
        { level: 'warn' },
      );
      return;
    }

    const wireData = this.fileData;

    // Decompression is deferred to the consumer (ModemService), because gzip
    // uses the async CompressionStream API. Hand up the wire bytes + scheme.
    this.completedFile = {
      fileName: this.fileName,
      data: wireData,
      totalBytes: this.fileSize,
      schemeId: this.fileSchemeId,
      origSize: this.fileOrigSize || this.fileSize,
    };
    this.completionCount++;
    this.framesReceived++;
    this.fileName = '';
    this.fileData = new Uint8Array(0);
    // 3d: return to WAITING so the next transmission's chirp/energy
    // detection can run (COMPLETE previously stuck the engine forever) —
    // OFDM only, mirroring the watchdog reset's resets EXCEPT
    // resetLinkProfile(): getLinkProfile() must keep reporting the
    // just-finished transfer's profile (same "retain until the next thing
    // arrives" contract as completedFile/getFile()) — the next sync
    // detection (chirp handoff / energy path) already resets it once a new
    // transmission actually starts. The fragile BPSK path is left exactly
    // as it was (state = COMPLETE).
    if (this.useOFDM && this.ofdmDemod) {
      this.state = RxState.WAITING;
      this.ofdmSyncFrames = 0;
      this.ofdmNoiseEma = this.OFDM_EMA_SEED;
      this.ofdmTrainingSymbols = 0;
      // Must re-arm alongside ofdmTrainingSymbols, or the NEXT transmission in
      // the same session skips its settle period entirely (the counter is
      // already at its limit) and trains straight off the chirp again — the
      // exact failure the settle period exists to prevent, reappearing only on
      // the second and subsequent transfers.
      this.ofdmSettleSymbols = 0;
      this.ofdmDemod.discardMER();
      this.ofdmDemod.resetTraining();
      this.buf = [];
      this.ofdmAlignBuf = [];
    } else {
      this.state = RxState.COMPLETE;
    }
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

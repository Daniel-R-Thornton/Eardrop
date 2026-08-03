/**
 * ModemService — all modem-worker logic as a plain class so vitest can
 * drive it without a Worker. The worker file is a thin shim around this.
 */
import { RxEngine } from '../modem/protocol/rxEngine';
import { HandshakeReceiver } from '../modem/protocol/handshakeReceiver';
import { TxEngine } from '../modem/protocol/txEngine';
import { captureTransmit } from '../modem/protocol/txCapture';
import { toneIQ } from '../modem/pilot';
import { DEFAULT_CONFIG, ofdmToneFrequencies, type ModemConfig } from '../modem/types';
import { compressBest, decompressScheme } from '../modem/compression';
import { dlog } from '../lib/debug/dlog';
import type { ModemCommand, ModemEvent, ModemTelemetry } from './modemSchema';
import { chirpCorrelate } from '../modem/protocol/chirp';
import {
  probeChirpTemplate,
  probeBurstSamplesAfterChirp,
  decodeProbeId,
  measureProbeSweep,
  buildProbeBurst,
} from '../modem/protocol/probeBurst';
import { encodeControlMessage, ControlType, type ControlMessage } from '../modem/protocol/controlFrame';

const RING_SECONDS = 10;
const SPECTRUM_BINS = 64;

/** RMS (root-mean-square) of a sample buffer. */
export function rmsOf(samples: ArrayLike<number>): number {
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sumSq / samples.length) : 0;
}

/**
 * Air-check noise floor: a slow EMA of QUIET-period RMS, used to tell an
 * ordinary busy channel apart from silence for chatter-mode carrier sense
 * (see modemService.ts's 'airCheck' command). Seeded unconditionally on the
 * first chunk it ever sees; after that, a chunk only teaches it anything
 * when the chunk itself reads as quiet (< 3x the current floor) — a loud
 * chunk (someone transmitting) must never drag the floor up to match it,
 * or the gate could never trip busy again.
 */
/** How much slower the noise floor rises than it falls. Slow enough that a
 *  real transmission doesn't drag the floor up behind it (which would make
 *  the air read clear mid-burst), fast enough to escape a bad seed within a
 *  couple of seconds of audio. */
const RISE_RATIO = 0.1;

export class AirNoiseTracker {
  private floor = 0;
  private seeded = false;

  constructor(private readonly alpha = 0.05) {}

  update(chunkRms: number): void {
    if (!this.seeded) {
      this.floor = chunkRms;
      this.seeded = true;
      return;
    }
    // Asymmetric, and — critically — never frozen. Updating only while quiet
    // (the original rule) latches permanently if the seed lands too low: the
    // very first chunk after a mic starts is often near-silence, every later
    // chunk then reads above 3x that floor, so the floor can never rise and
    // the air is reported busy forever. A join then burns its full
    // carrier-sense cap before every single announce. Tracking down fast and
    // up slowly keeps a genuine transmission from inflating the floor while
    // still guaranteeing recovery from a bad seed.
    const alpha = chunkRms < this.floor ? this.alpha : this.alpha * RISE_RATIO;
    this.floor = this.floor * (1 - alpha) + chunkRms * alpha;
  }

  isBusy(rms: number): boolean {
    return rms > 3 * this.floor;
  }

  get noiseFloor(): number {
    return this.floor;
  }
}

/**
 * ProbeDetector — passive listener for chatter-room probe bursts (see
 * probeBurst.ts): a down-chirp anchor (reverse direction from the modem's
 * own up-chirp sync burst, specifically so ordinary data traffic can never
 * false-trigger this), followed by a coarse channel sweep and a 12-bit
 * pulse-keyed device ID.
 *
 * Runs a normalized cross-correlation of a rolling 0.5 s buffer against the
 * down-chirp template every `scanHop` (4096) samples. At full rate that's
 * O(ring ~24k x template 7200) ~= 170M multiplies per hop — too much for a
 * cadence this runs at for the chatter session's entire life — so, exactly
 * like RxEngine's own chirp detector (rxEngine.ts, the `chirpCorrelate`
 * call under `feedSample`), both sides are 4:1 decimated (stride-sampled,
 * not filtered) before correlating: ~10M multiplies per hop, with the peak
 * index scaled back up by the same factor to index the full-rate ring.
 * Once a candidate clears the threshold, buffers the rest of the burst
 * (`probeBurstSamplesAfterChirp` more samples from the chirp start) and
 * decodes it; a CRC failure (`decodeProbeId` returning null) is treated as a
 * false trigger and silently discarded, matching the module's design intent
 * ("no false triggers to worry about — the CRC catches them").
 */
export class ProbeDetector {
  private readonly template: Float32Array;
  /** Template decimated by `DECIMATION` — built once, correlated every hop. */
  private readonly templateDec: Float32Array;
  private readonly ringCap: number;
  private readonly scanHop = 4096;
  /** Stride for the scan-time correlation — see the class doc. */
  private static readonly DECIMATION = 4;

  private ring: number[] = [];
  private samplesSinceScan = 0;

  /** Non-null while buffering the rest of a burst after a chirp candidate. */
  private pending: { buf: number[]; need: number } | null = null;

  constructor(
    private readonly ownDeviceId: number,
    private readonly sampleRate: number,
    private readonly onProbe: (deviceId: number, grid: number[]) => void,
  ) {
    this.template = probeChirpTemplate(sampleRate);
    this.ringCap = Math.round(sampleRate * 0.5);
    const ds = ProbeDetector.DECIMATION;
    const decLen = Math.ceil(this.template.length / ds);
    const templateDec = new Float32Array(decLen);
    for (let i = 0; i < decLen; i++) templateDec[i] = this.template[i * ds];
    this.templateDec = templateDec;
  }

  feedChunk(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) this.feedSample(chunk[i]);
  }

  private feedSample(sample: number): void {
    if (this.pending) {
      this.pending.buf.push(sample);
      if (this.pending.buf.length >= this.pending.need) this.finishCapture();
      return;
    }

    this.ring.push(sample);
    this.samplesSinceScan++;
    if (this.samplesSinceScan < this.scanHop) return;
    this.samplesSinceScan = 0;

    if (this.ring.length >= this.template.length) {
      const ds = ProbeDetector.DECIMATION;
      const ringDec = new Float32Array(Math.ceil(this.ring.length / ds));
      for (let i = 0; i < ringDec.length; i++) ringDec[i] = this.ring[i * ds];
      const { peakValue, peakIndex } = chirpCorrelate(ringDec, this.templateDec);
      const rms = rmsOf(ringDec);
      const norm = rms > 0 ? peakValue / (this.templateDec.length * rms) : 0;
      if (norm > 0.25 && peakIndex >= 0) {
        const anchor = peakIndex * ds; // back to a full-rate ring index
        const need = probeBurstSamplesAfterChirp(this.sampleRate);
        this.pending = { buf: this.ring.slice(anchor), need };
        this.ring = [];
        if (this.pending.buf.length >= need) {
          this.finishCapture();
          return;
        }
      }
    }

    if (this.ring.length > this.ringCap) {
      this.ring = this.ring.slice(this.ring.length - this.ringCap);
    }
  }

  private finishCapture(): void {
    const samples = new Float32Array(this.pending!.buf);
    this.pending = null;
    const deviceId = decodeProbeId(samples, 0, this.sampleRate);
    if (deviceId === null || deviceId === this.ownDeviceId) return; // CRC fail or our own probe
    const grid = measureProbeSweep(samples, 0, this.sampleRate);
    if (!grid) return;
    this.onProbe(deviceId, grid);
  }
}

export class ModemService {
  private emit: (ev: ModemEvent, transfer?: Transferable[]) => void;
  private config:
    | (ModemConfig & {
        useOFDM?: boolean;
        emitLinkProfile?: boolean;
        bandHandshake?: boolean;
        qamMap?: number[];
        toneGains?: number[];
        trainingSettleSymbols?: number;
      })
    | null = null;
  private rx: RxEngine | HandshakeReceiver | null = null;
  /**
   * Completion count (RxEngine.getCompletionCount()) already delivered to the
   * consumer. Gating on this identity — rather than a one-shot "fileSent"
   * boolean — lets a single configured session deliver MULTIPLE files: after
   * RxEngine returns to WAITING post-tail, getFile() keeps returning the same
   * completedFile until the next header arrives, so a boolean latch would
   * either never re-arm or re-deliver the same file. Comparing against the
   * monotonic counter means "new completion" is unambiguous.
   */
  private lastDeliveredCompletion = 0;

  // Active streaming-encode generator + its request id (one at a time).
  private stream: { id: number; gen: Generator<Float32Array> } | null = null;

  /** Chunk size for streaming encode ≈ 0.5 s of audio at the configured rate. */
  private streamChunkSamples(): number {
    const sr = this.config?.sampleRate ?? DEFAULT_CONFIG.sampleRate;
    return Math.max(1, Math.floor(sr * 0.5));
  }

  // Rolling ring of recent samples (Float32, telemetry + dumpBuffer)
  private ring: Float32Array = new Float32Array(0);
  private ringLen = 0; // valid samples (<= ring.length)

  // ─── Chatter room (see chatterWorker.test.ts) ───
  /** Fixed-band control-message listener, live only between chatterStart/Stop. */
  private chatterRx: RxEngine | null = null;
  /** Probe-burst listener, fed the same samples as chatterRx. */
  private probeDetector: ProbeDetector | null = null;
  /** Air-check carrier-sense noise floor — tracked continuously (see feedChunk). */
  private airNoise = new AirNoiseTracker();
  /** While true, feedChunk skips ALL demodulation (own-playback echo guard). */
  private rxMuted = false;

  constructor(emit: (ev: ModemEvent, transfer?: Transferable[]) => void) {
    this.emit = emit;
  }

  /**
   * Build the receiver the current config asks for: a HandshakeReceiver
   * (card listener + fresh target engine, see handshakeReceiver.ts) when the
   * band handshake is on, a plain RxEngine otherwise.
   */
  private makeRx(): RxEngine | HandshakeReceiver {
    const cfg = this.config as ConstructorParameters<typeof RxEngine>[0];
    return this.config?.useOFDM && this.config?.bandHandshake
      ? new HandshakeReceiver(cfg)
      : new RxEngine(cfg);
  }

  handle(cmd: ModemCommand): void {
    switch (cmd.type) {
      case 'configure': {
        this.config = cmd.config;
        this.ring = new Float32Array(cmd.config.sampleRate * RING_SECONDS);
        this.ringLen = 0;
        // Listening restarts pick up the new config
        if (this.rx) {
          this.rx = this.makeRx();
          this.lastDeliveredCompletion = 0;
        }
        this.emit({ type: 'configured' });
        break;
      }
      case 'startRx': {
        if (!this.config) { this.emit({ type: 'error', error: 'startRx before configure' }); return; }
        this.rx = this.makeRx();
        this.lastDeliveredCompletion = 0;
        this.emit({ type: 'rxStarted' });
        break;
      }
      case 'stopRx': {
        this.rx = null;
        this.emit({ type: 'rxStopped' });
        break;
      }
      case 'feedChunk': {
        const chunk = new Float32Array(cmd.samples);
        this.pushRing(chunk);
        // Skip the noise floor while muted. Muted means WE are playing, and
        // our own burst leaking back through the mic is not the channel's
        // noise: feeding it in drags the floor up toward our own transmit
        // level, after which a peer's genuinely loud reply no longer reads as
        // busy. (This was harmless while the floor could only fall, but the
        // floor now rises too, so self-noise would be absorbed into it.)
        if (this.rxMuted) break;
        this.airNoise.update(rmsOf(chunk));
        // Guard against RxEngine exceptions that would silently kill
        // the worker. Log and continue — the caller's watchdog will
        // notice the gap if processing taps out.
        try {
          this.rx?.feedChunk(chunk);
        } catch (err) {
          console.error('[MODEM] RxEngine.feedChunk exception:', (err as Error).message, 'len:', chunk.length);
        }
        try {
          this.chatterRx?.feedChunk(chunk);
        } catch (err) {
          console.error('[MODEM] chatter RxEngine.feedChunk exception:', (err as Error).message, 'len:', chunk.length);
        }
        this.probeDetector?.feedChunk(chunk);
        break;
      }
      case 'encodeFile': {
        void this.encodeFileAsync(cmd);
        break;
      }
      case 'encodeStreamStart': {
        void this.encodeStreamStartAsync(cmd);
        break;
      }
      case 'encodeStreamPull': {
        if (!this.stream || this.stream.id !== cmd.id) {
          // Stale pull (cancelled or already ended) — ignore.
          return;
        }
        try {
          const next = this.stream.gen.next();
          if (next.done) {
            this.stream = null;
            this.emit({ type: 'streamEnd', id: cmd.id });
          } else {
            // Copy out of the generator's internal buffer so it is safe to transfer.
            const chunk = next.value.slice();
            this.emit(
              { type: 'streamChunk', id: cmd.id, samples: chunk.buffer as ArrayBuffer },
              [chunk.buffer as ArrayBuffer],
            );
          }
        } catch (err) {
          this.stream = null;
          this.emit({ type: 'error', id: cmd.id, error: (err as Error).message });
        }
        break;
      }
      case 'encodeStreamCancel': {
        if (this.stream && this.stream.id === cmd.id) this.stream = null;
        break;
      }
      case 'demoEncode': {
        if (!this.config) { this.emit({ type: 'error', id: cmd.id, error: 'demoEncode before configure' }); return; }
        try {
          const run = captureTransmit(this.config as any, cmd.fileName, new Uint8Array(cmd.data));
          this.emit({ type: 'demoEncoded', id: cmd.id, run });
        } catch (err) {
          this.emit({ type: 'error', id: cmd.id, error: (err as Error).message });
        }
        break;
      }
      case 'dumpBuffer': {
        const sr = this.config?.sampleRate ?? DEFAULT_CONFIG.sampleRate;
        const want = Math.min(Math.floor(cmd.seconds * sr), this.ringLen);
        const out = this.ring.slice(this.ringLen - want, this.ringLen);
        let peak = 0; let sumSq = 0;
        for (let i = 0; i < out.length; i++) {
          const v = Math.abs(out[i]);
          if (v > peak) peak = v;
          sumSq += v * v;
        }
        const rms = out.length ? Math.sqrt(sumSq / out.length) : 0;
        this.emit({ type: 'bufferDump', id: cmd.id, samples: out.buffer as ArrayBuffer, rms, peak }, [out.buffer as ArrayBuffer]);
        break;
      }
      case 'flush': {
        // Every feedChunk posted before this command has already run (single
        // message queue), so poll for a completed file now instead of making
        // the caller wait for the next 20 Hz tick — or for a timeout when the
        // decode failed and no file will ever arrive.
        const fileReady = this.pollAndDeliverFile();
        this.emit({ type: 'flushed', id: cmd.id, fileReady });
        break;
      }
      case 'setVerboseLogging': {
        RxEngine.verboseRxLogging = cmd.enabled;
        break;
      }
      case 'chatterStart': {
        if (!this.config) { this.emit({ type: 'error', error: 'chatterStart before configure' }); return; }
        const cfg = { ...this.config, bandHandshake: true } as ConstructorParameters<typeof RxEngine>[0];
        const engine = new RxEngine(cfg);
        engine.onControlMessage = (msg: ControlMessage) => {
          dlog('CHATTER-RX', {
            decoded: ControlType[msg.type] ?? msg.type,
            from: msg.senderId,
            to: msg.targetId,
            bytes: msg.payload.length,
          }, { level: 'warn' });
          const owned = msg.payload.slice();
          this.emit(
            {
              type: 'controlMessage',
              msg: { type: msg.type, senderId: msg.senderId, targetId: msg.targetId, payload: owned.buffer as ArrayBuffer },
            },
            [owned.buffer as ArrayBuffer],
          );
        };
        this.chatterRx = engine;
        this.probeDetector = new ProbeDetector(cmd.deviceId, this.config.sampleRate, (deviceId, grid) => {
          this.emit({ type: 'probeHeard', deviceId, grid });
        });
        break;
      }
      case 'chatterStop': {
        this.chatterRx = null;
        this.probeDetector = null;
        break;
      }
      case 'encodeControl': {
        if (!this.config) { this.emit({ type: 'error', id: cmd.id, error: 'encodeControl before configure' }); return; }
        try {
          const msg: ControlMessage = {
            type: cmd.msg.type as ControlType,
            senderId: cmd.msg.senderId,
            targetId: cmd.msg.targetId,
            payload: new Uint8Array(cmd.msg.payload),
          };
          const wire = encodeControlMessage(msg);
          const tx = new TxEngine({ ...this.config, bandHandshake: true } as ConstructorParameters<typeof TxEngine>[0]);
          const samples = tx.buildHandshakeSegment(wire);
          this.emit(
            { type: 'encoded', id: cmd.id, samples: samples.buffer as ArrayBuffer, sampleRate: this.config.sampleRate },
            [samples.buffer as ArrayBuffer],
          );
        } catch (err) {
          this.emit({ type: 'error', id: cmd.id, error: (err as Error).message });
        }
        break;
      }
      case 'encodeProbe': {
        if (!this.config) { this.emit({ type: 'error', id: cmd.id, error: 'encodeProbe before configure' }); return; }
        const samples = buildProbeBurst(cmd.deviceId, this.config.sampleRate);
        this.emit(
          { type: 'encoded', id: cmd.id, samples: samples.buffer as ArrayBuffer, sampleRate: this.config.sampleRate },
          [samples.buffer as ArrayBuffer],
        );
        break;
      }
      case 'airCheck': {
        const sr = this.config?.sampleRate ?? DEFAULT_CONFIG.sampleRate;
        const want = Math.min(Math.floor(sr * 0.25), this.ringLen);
        const tail = this.ring.subarray(this.ringLen - want, this.ringLen);
        const rms = rmsOf(tail);
        this.emit({ type: 'airStatus', id: cmd.id, busy: this.airNoise.isBusy(rms), rms });
        break;
      }
      case 'setRxMuted': {
        this.rxMuted = cmd.muted;
        break;
      }
    }
  }

  /** One telemetry beat: file poll + display snapshot. Shim calls at ~20 Hz. */
  tick(): void {
    if (!this.rx || !this.config) return;

    this.pollAndDeliverFile();

    this.emit({ type: 'telemetry', telemetry: this.computeTelemetry() });
  }

  /**
   * Poll the RxEngine for a newly-completed file (identified by its
   * monotonic completion counter, not a one-shot boolean — see
   * lastDeliveredCompletion) and deliver it if not already delivered.
   * Returns true if a completed file has been delivered (now or previously)
   * for the current completion count.
   */
  private pollAndDeliverFile(): boolean {
    if (!this.rx) return false;
    const count = this.rx.getCompletionCount();
    if (count > this.lastDeliveredCompletion) {
      const file = this.rx.getFile();
      if (file) {
        this.lastDeliveredCompletion = count;
        void this.deliverCompletedFile(file);
        return true;
      }
      return false;
    }
    return count > 0;
  }

  /** Compress (async gzip) then encode a one-shot file → 'encoded'. */
  private async encodeFileAsync(cmd: Extract<ModemCommand, { type: 'encodeFile' }>): Promise<void> {
    if (!this.config) { this.emit({ type: 'error', id: cmd.id, error: 'encodeFile before configure' }); return; }
    try {
      const tx = new TxEngine(this.config as ConstructorParameters<typeof TxEngine>[0]);
      const rawData = new Uint8Array(cmd.data);
      const { bytes: wireData, scheme: schemeId } = await compressBest(rawData, cmd.fileName);
      dlog('TX-COMP', {
        scheme: schemeId,
        raw: rawData.length,
        wire: wireData.length,
        ratio: rawData.length ? (wireData.length / rawData.length).toFixed(2) : '1.00',
        saved: rawData.length - wireData.length,
      });
      const samples = tx.transmitFile(cmd.fileName, wireData, schemeId, rawData.length);
      this.emit(
        { type: 'encoded', id: cmd.id, samples: samples.buffer as ArrayBuffer, sampleRate: this.config.sampleRate },
        [samples.buffer as ArrayBuffer],
      );
    } catch (err) {
      this.emit({ type: 'error', id: cmd.id, error: (err as Error).message });
    }
  }

  /** Compress (async gzip) then set up the streaming generator → 'streamStart'. */
  private async encodeStreamStartAsync(cmd: Extract<ModemCommand, { type: 'encodeStreamStart' }>): Promise<void> {
    if (!this.config) { this.emit({ type: 'error', id: cmd.id, error: 'encodeStreamStart before configure' }); return; }
    try {
      const tx = new TxEngine(this.config as ConstructorParameters<typeof TxEngine>[0]);
      const rawData = new Uint8Array(cmd.data);
      const { bytes: wireData, scheme: schemeId } = await compressBest(rawData, cmd.fileName);
      dlog('TX-COMP', {
        scheme: schemeId,
        raw: rawData.length,
        wire: wireData.length,
        ratio: rawData.length ? (wireData.length / rawData.length).toFixed(2) : '1.00',
        saved: rawData.length - wireData.length,
      });
      const totalSamples = tx.estimateStreamSamples(wireData.length);
      this.stream = {
        id: cmd.id,
        gen: tx.streamChunks(cmd.fileName, wireData, this.streamChunkSamples(), schemeId, rawData.length),
      };
      this.emit({ type: 'streamStart', id: cmd.id, sampleRate: this.config.sampleRate, totalSamples });
    } catch (err) {
      this.stream = null;
      this.emit({ type: 'error', id: cmd.id, error: (err as Error).message });
    }
  }

  /** Decompress a completed file (async — gzip) and emit fileComplete once. */
  private async deliverCompletedFile(file: {
    fileName: string;
    data: Uint8Array;
    schemeId: number;
    origSize: number;
  }): Promise<void> {
    let out = file.data;
    if (file.schemeId !== 0) {
      try {
        out = await decompressScheme(file.data, file.schemeId);
        dlog('RX-COMP', { scheme: file.schemeId, wire: file.data.length, decompressed: out.length });
      } catch (err) {
        dlog('RX-FRAME', { decompressError: (err as Error).message });
        out = file.data; // fall back to wire bytes rather than corrupting silently
      }
    }
    // Own a transferable copy so the underlying buffer is safe to hand off.
    const owned = out.slice();
    this.emit(
      { type: 'fileComplete', fileName: file.fileName, data: owned.buffer as ArrayBuffer },
      [owned.buffer as ArrayBuffer],
    );
  }

  private pushRing(chunk: Float32Array): void {
    if (this.ring.length === 0) return;
    if (chunk.length >= this.ring.length) {
      this.ring.set(chunk.subarray(chunk.length - this.ring.length));
      this.ringLen = this.ring.length;
      return;
    }
    if (this.ringLen + chunk.length > this.ring.length) {
      const keep = this.ring.length - chunk.length;
      this.ring.copyWithin(0, this.ringLen - keep, this.ringLen);
      this.ringLen = keep;
    }
    this.ring.set(chunk, this.ringLen);
    this.ringLen += chunk.length;
  }

  private computeTelemetry(): ModemTelemetry {
    const sr = this.config!.sampleRate;
    const tailLen = Math.min(this.ringLen, 2048);
    const tail = this.ring.subarray(this.ringLen - tailLen, this.ringLen);

    let peak = 0; let sumSq = 0;
    for (let i = 0; i < tail.length; i++) {
      const v = Math.abs(tail[i]);
      if (v > peak) peak = v;
      sumSq += v * v;
    }
    const rms = tail.length ? Math.sqrt(sumSq / tail.length) : 0;
    const rmsDb = rms > 0.0001 ? 20 * Math.log10(rms) : -80;

    // 64-bin DFT over the tail
    const spectrumMaxHz = this.config!.useOFDM ? 4000 : 1600;
    const spectrum = new Float32Array(SPECTRUM_BINS);
    const winArr = Array.from(tail.subarray(Math.max(0, tail.length - 256)));
    for (let bin = 0; bin < SPECTRUM_BINS; bin++) {
      const f = (bin / SPECTRUM_BINS) * spectrumMaxHz;
      let si = 0; let co = 0;
      for (let i = 0; i < winArr.length; i++) {
        const ph = (2 * Math.PI * f * i) / sr;
        si += winArr[i] * Math.sin(ph);
        co += winArr[i] * Math.cos(ph);
      }
      spectrum[bin] = winArr.length ? Math.hypot(si, co) / winArr.length : 0;
    }

    const toneFreqs = this.config!.useOFDM
      ? ofdmToneFrequencies({ toneCount: this.config!.toneCount, pilotFreqHz: this.config!.pilotFreqHz, startHz: this.config!.toneStartHz })
      : new Float32Array(0);
    const toneEnergies: number[] = [];
    for (const f of toneFreqs) {
      const iq = toneIQ(winArr, f, sr);
      toneEnergies.push(Math.hypot(iq.i, iq.q));
    }

    const pilot = toneIQ(winArr, this.config!.pilotFreqHz, sr);

    return {
      rms,
      peak,
      rmsDb,
      spectrum,
      spectrumMaxHz,
      toneEnergies,
      pilotAmplitude: Math.hypot(pilot.i, pilot.q),
      progress: this.rx!.getProgress(),
    };
  }
}

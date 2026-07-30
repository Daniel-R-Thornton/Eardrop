/**
 * ModemService — all modem-worker logic as a plain class so vitest can
 * drive it without a Worker. The worker file is a thin shim around this.
 */
import { RxEngine } from '../modem/protocol/rxEngine';
import { TxEngine } from '../modem/protocol/txEngine';
import { captureTransmit } from '../modem/protocol/txCapture';
import { toneIQ } from '../modem/pilot';
import { DEFAULT_CONFIG, ofdmToneFrequencies, type ModemConfig } from '../modem/types';
import { compressBest, decompressScheme } from '../modem/compression';
import { dlog } from '../lib/debug/dlog';
import type { ModemCommand, ModemEvent, ModemTelemetry } from './modemSchema';

const RING_SECONDS = 10;
const SPECTRUM_BINS = 64;

export class ModemService {
  private emit: (ev: ModemEvent, transfer?: Transferable[]) => void;
  private config:
    | (ModemConfig & { useOFDM?: boolean; emitLinkProfile?: boolean; qamMap?: number[] })
    | null = null;
  private rx: RxEngine | null = null;
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

  constructor(emit: (ev: ModemEvent, transfer?: Transferable[]) => void) {
    this.emit = emit;
  }

  handle(cmd: ModemCommand): void {
    switch (cmd.type) {
      case 'configure': {
        this.config = cmd.config;
        this.ring = new Float32Array(cmd.config.sampleRate * RING_SECONDS);
        this.ringLen = 0;
        // Listening restarts pick up the new config
        if (this.rx) {
          this.rx = new RxEngine(this.config as ConstructorParameters<typeof RxEngine>[0]);
          this.lastDeliveredCompletion = 0;
        }
        this.emit({ type: 'configured' });
        break;
      }
      case 'startRx': {
        if (!this.config) { this.emit({ type: 'error', error: 'startRx before configure' }); return; }
        this.rx = new RxEngine(this.config as ConstructorParameters<typeof RxEngine>[0]);
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
        // Guard against RxEngine exceptions that would silently kill
        // the worker. Log and continue — the caller's watchdog will
        // notice the gap if processing taps out.
        try {
          this.rx?.feedChunk(chunk);
        } catch (err) {
          console.error('[MODEM] RxEngine.feedChunk exception:', (err as Error).message, 'len:', chunk.length);
        }
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
      ? ofdmToneFrequencies({ toneCount: this.config!.toneCount, pilotFreqHz: this.config!.pilotFreqHz })
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

/**
 * ModemController — the only main-thread code that talks to the modem
 * worker. Owns worker + recorder lifecycle; playback stays with the
 * caller-supplied AudioPlayer (output device selection is a UI concern).
 */
import { AudioRecorder } from '../../audio/recorder';
import type { ModemCommand, ModemEvent } from '../../workers/modemSchema';
import type { buildModemConfig } from './buildModemConfig';

type Handler<T extends ModemEvent['type']> = (ev: Extract<ModemEvent, { type: T }>) => void;

export class ModemController {
  private worker: Worker;
  private recorder: AudioRecorder | null = null;
  private audioCtx: AudioContext;
  private handlers = new Map<string, Set<(ev: ModemEvent) => void>>();
  private nextId = 1;
  private pending = new Map<number, (ev: ModemEvent) => void>();

  constructor(audioCtx: AudioContext) {
    this.audioCtx = audioCtx;
    this.worker = new Worker(new URL('../../workers/modem.worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (e: MessageEvent<ModemEvent>) => {
      const ev = e.data;
      const {id} = (ev as { id?: number });
      if (id !== undefined && this.pending.has(id)) {
        this.pending.get(id)!(ev);
        this.pending.delete(id);
      }
      this.handlers.get(ev.type)?.forEach((fn) => fn(ev));
    };
  }

  on<T extends ModemEvent['type']>(type: T, fn: Handler<T>): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    const set = this.handlers.get(type)!;
    set.add(fn as (ev: ModemEvent) => void);
    return () => set.delete(fn as (ev: ModemEvent) => void);
  }

  private post(cmd: ModemCommand, transfer?: Transferable[]): void {
    this.worker.postMessage(cmd, { transfer: transfer ?? [] });
  }

  configure(cfg: ReturnType<typeof buildModemConfig>): void {
    this.post({ type: 'configure', config: cfg });
  }

  async startListening(micGain: number, deviceId?: string): Promise<void> {
    this.post({ type: 'startRx' });
    this.recorder = new AudioRecorder(this.audioCtx, micGain);
    await this.recorder.start(
      this.audioCtx.sampleRate,
      (chunk) => {
        // Copy before transfer — the worklet may reuse its buffer
        const owned = new Float32Array(chunk);
        this.post({ type: 'feedChunk', samples: owned.buffer }, [owned.buffer]);
      },
      deviceId,
    );
  }

  setMicGain(gain: number): void {
    this.recorder?.setMicGain(gain);
  }

  stopListening(): void {
    this.recorder?.stop();
    this.recorder = null;
    this.post({ type: 'stopRx' });
  }

  /** Encode in the worker; resolves with samples for the caller to play. */
  encodeFile(fileName: string, data: Uint8Array): Promise<{ samples: Float32Array; sampleRate: number }> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, (ev) => {
        if (ev.type === 'encoded') resolve({ samples: new Float32Array(ev.samples), sampleRate: ev.sampleRate });
        else reject(new Error((ev as { error?: string }).error ?? 'encode failed'));
      });
      const copy = new Uint8Array(data);
      this.post({ type: 'encodeFile', id, fileName, data: copy.buffer }, [copy.buffer]);
    });
  }

  /**
   * Start a streaming encode. Resolves once the worker acknowledges with the
   * sample rate + estimated total samples, and returns a `pull()` that yields
   * the next audio chunk (or null at end) and a `cancel()`. The worker produces
   * exactly one chunk per pull, so the caller controls memory/backpressure.
   * One pull may be in flight at a time.
   */
  async startFileStream(
    fileName: string,
    data: Uint8Array,
  ): Promise<{
    sampleRate: number;
    totalSamples: number;
    pull: () => Promise<Float32Array | null>;
    cancel: () => void;
  }> {
    const id = this.nextId++;
    let ended = false;

    const start = await new Promise<{ sampleRate: number; totalSamples: number }>(
      (resolve, reject) => {
        const offStart = this.on('streamStart', (ev) => {
          if (ev.id !== id) return;
          offStart();
          offErr();
          resolve({ sampleRate: ev.sampleRate, totalSamples: ev.totalSamples });
        });
        const offErr = this.on('error', (ev) => {
          if (ev.id !== id) return;
          offStart();
          offErr();
          reject(new Error(ev.error));
        });
        const copy = new Uint8Array(data);
        this.post({ type: 'encodeStreamStart', id, fileName, data: copy.buffer }, [copy.buffer]);
      },
    );

    const pull = (): Promise<Float32Array | null> =>
      new Promise((resolve, reject) => {
        if (ended) {
          resolve(null);
          return;
        }
        const offChunk = this.on('streamChunk', (ev) => {
          if (ev.id !== id) return;
          offChunk();
          offEnd();
          offErr();
          resolve(new Float32Array(ev.samples));
        });
        const offEnd = this.on('streamEnd', (ev) => {
          if (ev.id !== id) return;
          offChunk();
          offEnd();
          offErr();
          ended = true;
          resolve(null);
        });
        const offErr = this.on('error', (ev) => {
          if (ev.id !== id) return;
          offChunk();
          offEnd();
          offErr();
          reject(new Error(ev.error));
        });
        this.post({ type: 'encodeStreamPull', id });
      });

    const cancel = (): void => {
      if (ended) return;
      ended = true;
      this.post({ type: 'encodeStreamCancel', id });
    };

    return { sampleRate: start.sampleRate, totalSamples: start.totalSamples, pull, cancel };
  }

  demoEncode(fileName: string, data: Uint8Array): Promise<import('../../modem/protocol/captureTypes').Run> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, (ev) => {
        if (ev.type === 'demoEncoded') resolve(ev.run);
        else reject(new Error((ev as { error?: string }).error ?? 'demoEncode failed'));
      });
      const copy = new Uint8Array(data);
      this.post({ type: 'demoEncode', id, fileName, data: copy.buffer }, [copy.buffer]);
    });
  }

  dumpBuffer(seconds: number): Promise<{ samples: Float32Array; rms: number; peak: number }> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, (ev) => {
        if (ev.type === 'bufferDump') {
          resolve({ samples: new Float32Array(ev.samples), rms: ev.rms, peak: ev.peak });
        }
      });
      this.post({ type: 'dumpBuffer', id, seconds });
    });
  }

  /** Feed pre-recorded samples into the receiver pipeline (no mic needed).
   *  Sends startRx automatically so the RxEngine is ready to process. */
  feedSamples(samples: Float32Array): void {
    this.post({ type: 'startRx' });
    // Transfer the entire buffer as one chunk; the worker handles chunking internally.
    const owned = new Float32Array(samples);
    this.worker.postMessage({ type: 'feedChunk', samples: owned.buffer }, [owned.buffer]);
  }
}

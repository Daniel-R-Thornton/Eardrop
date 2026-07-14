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
      const id = (ev as { id?: number }).id;
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

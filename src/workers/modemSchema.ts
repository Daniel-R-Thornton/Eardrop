/**
 * modemSchema.ts — typed protocol for the unified modem worker.
 *
 * Main → Worker: ModemCommand. Worker → Main: ModemEvent.
 * Audio always crosses as transferable Float32Array buffers.
 */
import type { ModemConfig } from '../modem/types';
import type { Run } from '../modem/protocol/captureTypes';
import type { ProbePurpose } from '../modem/protocol/probeBurst';

export interface RxProgress {
  state: number; // RxState enum value
  framesReceived: number;
  totalFrames: number;
  fileName: string;
  fileSize: number;
  bytesAssembled: number;
}

/** Compact display snapshot, emitted at ~20 Hz while listening. */
export interface ModemTelemetry {
  rms: number;
  peak: number;
  rmsDb: number;
  /** 64-bin magnitude spectrum, 0..spectrumMaxHz */
  spectrum: Float32Array;
  spectrumMaxHz: number;
  /** Per-OFDM-tone energy of the most recent window */
  toneEnergies: number[];
  pilotAmplitude: number;
  progress: RxProgress;
}

export type ModemCommand =
  | {
      type: 'configure';
      config: ModemConfig & {
        useOFDM?: boolean;
        emitLinkProfile?: boolean;
        bandHandshake?: boolean;
        qamMap?: number[];
        toneGains?: number[];
        trainingSettleSymbols?: number;
      };
    }
  | { type: 'startRx' }
  | { type: 'stopRx' }
  | { type: 'feedChunk'; samples: ArrayBuffer } // Float32Array buffer, transferred
  | { type: 'encodeFile'; id: number; fileName: string; data: ArrayBuffer }
  | { type: 'encodeStreamStart'; id: number; fileName: string; data: ArrayBuffer }
  | { type: 'encodeStreamPull'; id: number }
  | { type: 'encodeStreamCancel'; id: number }
  | { type: 'demoEncode'; id: number; fileName: string; data: ArrayBuffer }
  | { type: 'dumpBuffer'; id: number; seconds: number }
  // Round-trip barrier: the worker processes commands in order, so a 'flushed'
  // reply proves every previously-posted feedChunk has already been demodulated.
  | { type: 'flush'; id: number }
  | { type: 'setVerboseLogging'; enabled: boolean }
  /** Restrict worker debug output to these tags; null restores everything.
   *  Most modem logging happens in here, so quieting the console for a focused
   *  view has to reach the worker — the main thread cannot filter what it
   *  never sees as individual events. */
  | { type: 'setLogFocus'; tags: string[] | null }
  /** Pause the chatter SCANNERS (probe correlator + control listener) without
   *  tearing chatter mode down. During a transfer they are guaranteed to be
   *  hearing file audio rather than room traffic, and the probe correlator is
   *  the most expensive thing in the worker. */
  | { type: 'chatterScanPaused'; paused: boolean }
  // ─── Chatter room (see chatterWorker.test.ts) ───
  | { type: 'chatterStart'; deviceId: number }
  | { type: 'chatterStop' }
  /** `toneGains`: per-tone pre-emphasis for the handshake band, derived from
   *  what the RECIPIENT reported hearing of us. Omitted for a broadcast or
   *  before any measurement exists, which keeps the band flat. */
  | { type: 'encodeControl'; id: number; msg: { type: number; senderId: number; targetId: number; payload: ArrayBuffer }; toneGains?: number[] }
  | { type: 'encodeProbe'; id: number; deviceId: number; purpose: ProbePurpose }
  | { type: 'airCheck'; id: number }
  | { type: 'setRxMuted'; muted: boolean };

export type ModemEvent =
  | { type: 'ready' }
  | { type: 'configured' }
  | { type: 'rxStarted' }
  | { type: 'rxStopped' }
  | { type: 'telemetry'; telemetry: ModemTelemetry }
  | { type: 'fileComplete'; fileName: string; data: ArrayBuffer }
  | { type: 'encoded'; id: number; samples: ArrayBuffer; sampleRate: number }
  | { type: 'streamStart'; id: number; sampleRate: number; totalSamples: number }
  | { type: 'streamChunk'; id: number; samples: ArrayBuffer }
  | { type: 'streamEnd'; id: number }
  | { type: 'demoEncoded'; id: number; run: Run }
  | { type: 'bufferDump'; id: number; samples: ArrayBuffer; rms: number; peak: number }
  /** Reply to 'flush'. `fileReady` = a completed file was found by this barrier. */
  | { type: 'flushed'; id: number; fileReady: boolean }
  /** Either a formatted console line or the structured event behind it. */
  | { type: 'dlog'; line?: string; rec?: { tag: string; fields: Record<string, unknown> } }
  | {
      type: 'error';
      id?: number;
      error: string;
      /** Error constructor name — a browser allocation failure is a
       *  RangeError on some engines and a bare Error on others, and the
       *  message alone does not say which. */
      errorName?: string;
      /** The command that failed, so a log line points at a cause rather than
       *  just an effect. */
      command?: string;
    }
  // ─── Chatter room (see chatterWorker.test.ts) ───
  | { type: 'probeHeard'; deviceId: number; grid: number[]; purpose: ProbePurpose }
  | { type: 'controlMessage'; msg: { type: number; senderId: number; targetId: number; payload: ArrayBuffer } }
  | { type: 'airStatus'; id: number; busy: boolean; rms: number };

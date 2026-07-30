/**
 * modemSchema.ts — typed protocol for the unified modem worker.
 *
 * Main → Worker: ModemCommand. Worker → Main: ModemEvent.
 * Audio always crosses as transferable Float32Array buffers.
 */
import type { ModemConfig } from '../modem/types';
import type { Run } from '../modem/protocol/captureTypes';

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
  | { type: 'setVerboseLogging'; enabled: boolean };

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
  | { type: 'dlog'; line: string }
  | { type: 'error'; id?: number; error: string };

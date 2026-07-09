/**
 * src/workers/schema.ts — Typed message contracts for worker communication.
 *
 * Encoder worker:
 *   Main → Worker: EncodeRequest
 *   Worker → Main: EncodeResponse | WorkerError
 *
 * Broadcast (decoder) worker:
 *   Main → Worker: BroadcastCommand
 *   Worker → Main: BroadcastEvent
 */

// ─── Encoder Worker ───────────────────────────────────

export interface EncodeRequest {
  type: 'transmitFile';
  id: number;
  fileName: string;
  data: ArrayBuffer;
  config?: import('../modem/types').ModemConfig;
}

export interface EncodeResponse {
  type: 'encoded';
  id: number;
  samples: ArrayBuffer;
  sampleRate: number;
}

// ─── Broadcast (Decoder) Worker ───────────────────────

export type BroadcastCommand =
  | { type: 'startListening'; config?: import('../modem/types').ModemConfig }
  | { type: 'feedSample'; sample: number }
  | { type: 'stopListening' };

export type BroadcastEvent =
  | { type: 'listening' }
  | { type: 'stopped' }
  | { type: 'fileComplete'; fileName: string; data: ArrayBuffer }
  | { type: 'decoderState'; state: number }
  | { type: 'debugByteLog'; bytes: Array<{ byte: number; phase: string; bitOffset: number }> }
  | {
      type: 'debugSentinelScan';
      history: Array<{ bit: number; shiftReg: number; matched: boolean; phase: string }>;
    };

// ─── Shared ───────────────────────────────────────────

export interface WorkerError {
  type: 'error';
  id: number;
  error: string;
}

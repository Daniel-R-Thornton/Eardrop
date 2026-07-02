/**
 * EncoderWorker — offloads modem encoding to a dedicated thread.
 *
 * Messages (main → worker):
 *   { type: 'encode',         id, data: Uint8Array, config? }
 *   { type: 'encodeToOutput', id, data: Uint8Array, outputRate, config? }
 *
 * Messages (worker → main):
 *   { type: 'encoded', id, samples: ArrayBuffer, sampleRate }
 *   { type: 'error',   id, error: string }
 */

import { Encoder } from "../modem/encoder";
import { DEFAULT_CONFIG, type ModemConfig } from "../modem/types";

interface EncodeTask {
  type: "encode";
  id: number;
  data: Uint8Array;
  config?: Partial<ModemConfig>;
}

interface EncodeToOutputTask {
  type: "encodeToOutput";
  id: number;
  data: Uint8Array;
  outputRate: number;
  config?: Partial<ModemConfig>;
}

type Task = EncodeTask | EncodeToOutputTask;

self.onmessage = (e: MessageEvent<Task>) => {
  const msg = e.data;

  try {
    const encoder = new Encoder(msg.config ?? DEFAULT_CONFIG);

    if (msg.type === "encode") {
      const samples = encoder.encode(msg.data);
      const sampleRate = msg.config?.sampleRate ?? DEFAULT_CONFIG.sampleRate;
      self.postMessage(
        {
          type: "encoded",
          id: msg.id,
          samples: samples.buffer as ArrayBuffer,
          sampleRate,
        },
        { transfer: [samples.buffer] },
      );
    } else if (msg.type === "encodeToOutput") {
      const samples = encoder.encodeToOutputRate(msg.data, msg.outputRate);
      self.postMessage(
        {
          type: "encoded",
          id: msg.id,
          samples: samples.buffer as ArrayBuffer,
          sampleRate: msg.outputRate,
        },
        { transfer: [samples.buffer] },
      );
    }
  } catch (err: any) {
    self.postMessage({ type: "error", id: msg.id, error: err.message });
  }
};

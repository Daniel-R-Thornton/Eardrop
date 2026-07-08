/**
 * EncoderWorker — offloads modem encoding to a dedicated thread.
 *
 * Messages (main → worker):
 *   { type: 'encode',         id, data: Uint8Array, config? }
 *   { type: 'transmitFile',   id, fileName: string, data: Uint8Array, config? }
 *
 * Messages (worker → main):
 *   { type: 'encoded', id, samples: ArrayBuffer, sampleRate }
 *   { type: 'error',   id, error: string }
 */

import { TxEngine } from "../modem/txEngine";
import { DEFAULT_CONFIG, type ModemConfig } from "../modem/types";

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  try {
    if (msg.type === "transmitFile") {
      const tx = new TxEngine(msg.config ?? DEFAULT_CONFIG);
      const samples = tx.transmitFile(msg.fileName, new Uint8Array(msg.data));
      const sampleRate = msg.config?.sampleRate ?? DEFAULT_CONFIG.sampleRate;
      self.postMessage(
        { type: "encoded", id: msg.id, samples: samples.buffer, sampleRate },
        { transfer: [samples.buffer] },
      );
    } else {
      self.postMessage({ type: "error", id: msg.id, error: `Unknown type: ${msg.type}` });
    }
  } catch (err: any) {
    self.postMessage({ type: "error", id: msg.id, error: err.message });
  }
};

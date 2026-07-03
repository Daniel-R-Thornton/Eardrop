/**
 * BroadcastWorker — offloads the receive (decoder) pipeline to a dedicated thread.
 */

import { Decoder } from "../modem/decoder";
import { DEFAULT_CONFIG, type ModemConfig } from "../modem/types";
import { debugLogger } from "../modem/debugger";

// Verbose debug flag – set false to silence logs for agentic AI contexts.
const DEBUG = false;
if (!DEBUG) {
  // Override console methods to no-op.
  console.log = function() {};
  console.error = function() {};
}

let decoder: Decoder | null = null;
let stateInterval: ReturnType<typeof setInterval> | null = null;
let rawAccum: number[] = [];
let frameCount = 0;

function hex(bytes: Uint8Array, max = 16): string {
  const slice = bytes.slice(0, max);
  const h = Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return bytes.length > max ? `${h} … (${bytes.length}B)` : h;
}

if (DEBUG) console.log("[RX] worker module loaded");

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (DEBUG) console.log("[RX] message:", msg.type);

  switch (msg.type) {
    case "startListening": {
      if (decoder) return;
      if (DEBUG) console.log("[RX] start listening");
      decoder = new Decoder(msg.config ?? DEFAULT_CONFIG);
      decoder.logging = true;
      decoder.fastSync = msg.fastSync ?? false;
      decoder.reset();
      frameCount = 0;

      decoder.onFrame = (data: Uint8Array) => {
        frameCount++;
        if (DEBUG) console.log(`[RX] frame #${frameCount}: ${data.length}B hex=${hex(data)}`);
        for (const b of data) {
          rawAccum.push(b);
          if (rawAccum.length > 128) rawAccum.shift();
        }
        self.postMessage(
          { type: "frame", data: data.buffer as ArrayBuffer },
          { transfer: [data.buffer] },
        );
      };
      decoder.reset();
      rawAccum = [];

      stateInterval = setInterval(() => {
        if (!decoder) return;
        const log = decoder.debugLog;
        const last = log[log.length - 1];
        const recentLog = log.slice(-3);

        // Periodic console summary every 2s (every 10th tick at 200ms)
        if (frameCount > 0 && frameCount % 10 === 0) {
          const info = last;
          if (info) {
            const nf = info.noiseFloor.map((n: number) => n.toFixed(4)).join(" ");
            const en = info.energies.map((e: number) => e.toFixed(4)).join(" ");
            if (DEBUG) console.log(
              `[RX] frame=${frameCount} sync=${info.consecutiveSync}` +
              ` inFrame=${info.inFrame} bits=${info.bitsCollected}` +
              ` noise=[${nf}] eng=[${en}] strong=${info.strong}`
            );
          }
        }

        // Drain debug events from this worker's debugLogger to ship to main thread
        const debugEvents = debugLogger.drain();

        self.postMessage({
          type: "decoderState",
          bitsCollected: decoder.getProgress(),
          hasData: decoder.hasData(),
          debugInfo: last ?? null,
          recentLog,
          rawBytes: new Uint8Array(rawAccum).buffer as ArrayBuffer,
          debugEvents,
        });
      }, 200);

      self.postMessage({ type: "listening" });
      break;
    }

    case "setExpectedTotal": {
      if (decoder) decoder.setExpectedTotal(msg.count);
      break;
    }

    case "feedSample": {
      if (!decoder) return;
      decoder.feedSample(msg.sample);
      break;
    }

    case "stopListening": {
      if (DEBUG) console.log(`[RX] stop listening — ${rawAccum.length} raw bytes accumulated`);
      if (stateInterval) {
        clearInterval(stateInterval);
        stateInterval = null;
      }
      if (decoder) {
        const remaining = decoder.flush();
        if (remaining.length > 0) {
          if (DEBUG) console.log(`[RX] flush: ${remaining.length}B hex=${hex(remaining)}`);
          for (const b of remaining) {
            rawAccum.push(b);
            if (rawAccum.length > 128) rawAccum.shift();
          }
          self.postMessage(
            { type: "frame", data: remaining.buffer as ArrayBuffer },
            { transfer: [remaining.buffer] },
          );
        }
        decoder = null;
      }
      self.postMessage({ type: "stopped" });
      break;
    }

    case "flush": {
      if (decoder) {
        const remaining = decoder.flush();
        if (remaining.length > 0) {
          if (DEBUG) console.log(`[RX] flush: ${remaining.length}B hex=${hex(remaining)}`);
          for (const b of remaining) {
            rawAccum.push(b);
            if (rawAccum.length > 128) rawAccum.shift();
          }
          self.postMessage(
            { type: "frame", data: remaining.buffer as ArrayBuffer },
            { transfer: [remaining.buffer] },
          );
        }
      }
      break;
    }
  }
};

/**
 * BroadcastWorker — receives audio, feeds RxEngine, emits completed files.
 */

import { RxEngine } from '../modem/protocol/rxEngine';
import { DEFAULT_CONFIG } from '../modem/types';
import { dlog, dlogSetMode } from '../lib/debug/dlog';

const DEBUG = true;
// Worker code version — increment when changing rxEngine sync detection
const WORKER_VERSION = 'v4-eq-align';

// Forward all dlog lines to the main thread so they land in ONE console ring
dlogSetMode('forward', (line) => self.postMessage({ type: 'dlog', line }));
dlog('RX', { worker: WORKER_VERSION });

let rx: RxEngine | null = null;
let stateInterval: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (DEBUG && msg.type !== 'feedSample' && msg.type !== 'startListening' && msg.type !== 'stopListening') {
    dlog('RX', { msg: msg.type });
  }

  switch (msg.type) {
    case 'startListening': {
      if (rx) return;
      dlog('RX', { listening: true });
      rx = new RxEngine(msg.config ?? DEFAULT_CONFIG);

      // Poll for completed file every 200ms
      let fileSent = false;
      stateInterval = setInterval(() => {
        if (!rx) return;
        if (!fileSent) {
          const file = rx.getFile();
          if (file) {
            fileSent = true;
            dlog('RX', { fileComplete: file.fileName, bytes: file.data.length });
            self.postMessage(
              { type: 'fileComplete', fileName: file.fileName, data: file.data.buffer },
              { transfer: [file.data.buffer] },
            );
          }
        }
        self.postMessage({
          type: 'decoderState',
          state: rx.getState(),
        });

        // Debug snapshot for UI diagnostics
        self.postMessage({
          type: 'debugDecoderState',
          snapshot: rx.getDebugSnapshot(),
        });

        // DEBUG: forward byte log
        const byteLog = rx.getDebugByteLog();
        if (byteLog.length > 0) {
          self.postMessage({
            type: 'debugByteLog',
            bytes: byteLog,
          });
        }

        // DEBUG: forward sentinel scan history
        const shiftRegHistory = rx.getShiftRegHistory();
        if (shiftRegHistory.length > 0) {
          self.postMessage({
            type: 'debugSentinelScan',
            history: shiftRegHistory,
          });
        }
      }, 200);

      self.postMessage({ type: 'listening' });
      break;
    }

    case 'feedSample': {
      if (!rx) return;
      rx.feedSample(msg.sample);
      break;
    }

    case 'stopListening': {
      dlog('RX', { listening: false });
      if (stateInterval) {
        clearInterval(stateInterval);
        stateInterval = null;
      }
      rx = null;
      self.postMessage({ type: 'stopped' });
      break;
    }

    case 'setRxVerboseLogging': {
      RxEngine.verboseRxLogging = !!msg.enabled;
      dlog('RX', { verbose: RxEngine.verboseRxLogging });
      break;
    }
  }
};

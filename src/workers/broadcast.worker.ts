/**
 * BroadcastWorker — receives audio, feeds RxEngine, emits completed files.
 */

import { RxEngine } from '../modem/protocol/rxEngine';
import { DEFAULT_CONFIG } from '../modem/types';

const DEBUG = true;

let rx: RxEngine | null = null;
let stateInterval: ReturnType<typeof setInterval> | null = null;

if (DEBUG) console.log('[RX] worker module loaded');

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (DEBUG && msg.type !== 'feedSample') console.log('[RX] message:', msg.type);

  switch (msg.type) {
    case 'startListening': {
      if (rx) return;
      if (DEBUG) console.log('[RX] start listening');
      rx = new RxEngine(msg.config ?? DEFAULT_CONFIG);

      // Poll for completed file every 200ms
      let fileSent = false;
      stateInterval = setInterval(() => {
        if (!rx) return;
        if (!fileSent) {
          const file = rx.getFile();
          if (file) {
            fileSent = true;
            if (DEBUG) console.log(`[RX] file complete: "${file.fileName}" ${file.data.length}B`);
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
      if (DEBUG) console.log('[RX] stop listening');
      if (stateInterval) {
        clearInterval(stateInterval);
        stateInterval = null;
      }
      rx = null;
      self.postMessage({ type: 'stopped' });
      break;
    }
  }
};

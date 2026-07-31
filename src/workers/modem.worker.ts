/**
 * modem.worker.ts — thin shim: ModemService does the work.
 * Telemetry ticks at 50 ms (20 Hz) while RX is active.
 */
import { ModemService } from './modemService';
import type { ModemCommand } from './modemSchema';
import { dlogSetMode } from '../lib/debug/dlog';

// Lines feed the main thread's console ring; records feed the LLM export, which
// aggregates fields and cannot recover them from wrapped console text.
dlogSetMode(
  'forward',
  (line) => self.postMessage({ type: 'dlog', line }),
  (rec) => self.postMessage({ type: 'dlog', rec }),
);

const svc = new ModemService((ev, transfer) => {
  self.postMessage(ev, { transfer: transfer ?? [] });
});

let tickTimer: ReturnType<typeof setInterval> | null = null;

self.onmessage = (e: MessageEvent<ModemCommand>) => {
  const cmd = e.data;
  svc.handle(cmd);
  if (cmd.type === 'startRx' && !tickTimer) {
    tickTimer = setInterval(() => svc.tick(), 50);
  }
  if (cmd.type === 'stopRx' && tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
};

self.postMessage({ type: 'ready' });

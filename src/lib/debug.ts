/**
 * debug.ts — Centralized debug logging with per-category toggles.
 *
 * Usage:
 *   import { dbg } from '../../lib/debug';
 *   dbg.log('tx', 'Generated waveform:', samples.length);
 *   dbg.info('player', 'Playback started');
 *   dbg.warn('recorder', 'Worklet error');
 *   dbg.error('ofdm', 'FFT failed', err);
 *
 * Toggle individual categories in console:
 *   window.debugUI()   // show checkbox panel
 *   window.debug.set('player', false)  // mute player logs
 *   window.debug.all(false)            // mute all
 *   window.debug.all(true)             // unmute all
 */

export type DebugCategory =
  | 'recorder'
  | 'player'
  | 'tx'
  | 'rx'
  | 'ofdm'
  | 'preamble'
  | 'channel'
  | 'app'
  | 'general';

const ALL_CATEGORIES: DebugCategory[] = [
  'recorder',
  'player',
  'tx',
  'rx',
  'ofdm',
  'preamble',
  'channel',
  'app',
  'general',
];

// Default: everything ON
const enabled: Record<DebugCategory, boolean> = Object.fromEntries(
  ALL_CATEGORIES.map((c) => [c, false]),
) as Record<DebugCategory, boolean>;

function shouldLog(category: DebugCategory): boolean {
  return enabled[category] !== false;
}

export const dbg = {
  log(category: DebugCategory, ...args: any[]) {
    if (!shouldLog(category)) return;
    console.log(`[${category.toUpperCase()}]`, ...args);
  },

  info(category: DebugCategory, ...args: any[]) {
    if (!shouldLog(category)) return;
    console.info(`[${category.toUpperCase()}] ℹ️`, ...args);
  },

  warn(category: DebugCategory, ...args: any[]) {
    if (!shouldLog(category)) return;
    console.warn(`[${category.toUpperCase()}] ⚠️`, ...args);
  },

  error(category: DebugCategory, ...args: any[]) {
    if (!shouldLog(category)) return;
    console.error(`[${category.toUpperCase()}] ❌`, ...args);
  },

  /** Low‑volume verbose trace – off unless category explicitly on */
  trace(category: DebugCategory, ...args: any[]) {
    if (!shouldLog(category)) return;
    console.debug(`[${category.toUpperCase()}] 🔍`, ...args);
  },
};

/**
 * Expose debug controls on window so they're available from the console
 * without any UI dependencies.
 */
(window as any).debug = {
  /** Enable or disable one category */
  set(category: DebugCategory, on: boolean) {
    if (ALL_CATEGORIES.includes(category)) {
      enabled[category] = on;
      console.log(`[DEBUG] ${on ? '✅' : '⛔'} ${category} logs ${on ? 'enabled' : 'disabled'}`);
      // Notify the broadcast worker if rx toggled
      if (category === 'rx' && (window as any).eardropWorker) {
        (window as any).eardropWorker.postMessage({ type: 'setRxVerboseLogging', enabled: on });
      }
    } else {
      console.warn(`[DEBUG] Unknown category: ${category}. Available: ${ALL_CATEGORIES.join(', ')}`);
    }
  },

  /** Enable or disable all categories at once */
  all(on: boolean) {
    for (const c of ALL_CATEGORIES) enabled[c] = on;
    console.log(`[DEBUG] ${on ? '✅' : '⛔'} All debug logs ${on ? 'enabled' : 'disabled'}`);
  },

  /** Show current state of all flags */
  status() {
    console.table(Object.entries(enabled).map(([k, v]) => ({ category: k, enabled: v })));
  },

  /** List available categories */
  categories: [...ALL_CATEGORIES],
};

/**
 * Render an inline checkbox panel into the given DOM element.
 * Each checkbox toggles one debug category on/off.
 * The panel auto‑updates its toggle state from the `window.debug` API.
 * @example
 *   import { renderDebugPanel } from './lib/debug';
 *   renderDebugPanel(document.getElementById('debug-panel'));
 */
export function renderDebugPanel(parentEl: HTMLElement): void {
  const container = document.createElement('div');
  container.style.cssText = 'padding:8px; font:12px/1.6 monospace; background:#1a1a2e; color:#ccc; border:1px solid #444; border-radius:4px; max-height:300px; overflow-y:auto;';
  container.innerHTML = '<div style="font-weight:bold; margin-bottom:6px; color:#7ec8e3;">🔍 Debug Logs</div>';

  for (const cat of ALL_CATEGORIES) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex; align-items:center; gap:6px; cursor:pointer; padding:2px 0;';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabled[cat];
    checkbox.addEventListener('change', () => {
      (window as any).debug.set(cat, checkbox.checked);
      // Persist to sessionStorage so the choice survives page reload
      try { sessionStorage.setItem(`dbg_${cat}`, checkbox.checked ? '1' : '0'); } catch {}
    });

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(cat));
    container.appendChild(label);
  }

  // Restore any persisted preferences
  try {
    for (const cat of ALL_CATEGORIES) {
      const stored = sessionStorage.getItem(`dbg_${cat}`);
      if (stored !== null) {
        const on = stored === '1';
        enabled[cat] = on;
        // Update checkbox state after we've created them
        const cb = container.querySelector(`input[type="checkbox"]`) as HTMLInputElement | null;
        // We need to match by category — use a data attribute
      }
    }
  } catch {}

  // Apply persisted state to checkboxes via data-category
  const checkboxes = container.querySelectorAll('input[type="checkbox"]');
  let idx = 0;
  for (const cb of checkboxes) {
    (cb as HTMLInputElement).checked = enabled[ALL_CATEGORIES[idx]];
    (cb as HTMLInputElement).dataset.category = ALL_CATEGORIES[idx];
    idx++;
  }

  parentEl.appendChild(container);
}

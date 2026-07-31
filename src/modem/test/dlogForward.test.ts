/**
 * dlogForward.test.ts — records must cross the worker boundary, not just lines.
 *
 * Most modem logging happens in the worker. It forwards to the main thread for
 * display, and if only the formatted lines cross, the main thread's record buffer
 * stays empty — which makes the LLM export (which aggregates records) report an
 * almost-blank session while the console shows a full one. That failure is silent,
 * so it is pinned here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  dlog,
  dlogInject,
  dlogInjectRecord,
  dlogRecords,
  dlogReset,
  dlogSetMode,
  type DlogRecord,
} from '../../lib/debug/dlog';

describe('dlog forwarding', () => {
  beforeEach(() => {
    dlogReset();
    dlogSetMode('lines');
  });

  it('forwards the structured event alongside the formatted line', () => {
    const lines: string[] = [];
    const recs: DlogRecord[] = [];
    dlogSetMode('forward', (l) => lines.push(l), (r) => recs.push(r));

    dlog('QAMD', { n: 5, g: 0.89, sd: '64,73' });

    expect(lines.length).toBeGreaterThan(0);
    expect(recs).toEqual([{ tag: 'QAMD', fields: { n: 5, g: 0.89, sd: '64,73' } }]);
  });

  it('forwards one record per event even when the line wraps', () => {
    const recs: DlogRecord[] = [];
    dlogSetMode('forward', () => {}, (r) => recs.push(r));

    // Long per-tone payload: several console lines, still one event.
    const tones = Array.from({ length: 40 }, (_u, t) => 6900 + t * 50).join(',');
    dlog('TX-OFDM', { tones });

    expect(recs).toHaveLength(1);
    expect(recs[0].fields.tones).toBe(tones);
  });

  it('injected records land in the receiving context buffer', () => {
    dlogInject('[QAMD] n=5');
    expect(dlogRecords()).toHaveLength(0); // a line alone carries no fields

    dlogInjectRecord({ tag: 'QAMD', fields: { n: 5 } });
    expect(dlogRecords()).toEqual([{ tag: 'QAMD', fields: { n: 5 } }]);
  });
});

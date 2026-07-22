import { describe, it, expect } from 'vitest';
import { ModemService } from '../../workers/modemService';
import { DEFAULT_CONFIG } from '../types';

describe('ModemService demoEncode', () => {
  it('emits a demoEncoded event with a populated Run', () => {
    const events: any[] = [];
    const svc = new ModemService((ev) => events.push(ev));
    svc.handle({ type: 'configure', config: { ...DEFAULT_CONFIG, useOFDM: false } as any });
    const data = new TextEncoder().encode('EARDROP ✓ 2026').buffer;
    svc.handle({ type: 'demoEncode', id: 1, fileName: 'demo.txt', data });
    const ev = events.find((e) => e.type === 'demoEncoded');
    expect(ev).toBeDefined();
    expect(ev.run.frames.length).toBeGreaterThanOrEqual(3);
  });
});

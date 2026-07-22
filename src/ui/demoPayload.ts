/**
 * demoPayload.ts — the in-memory sample the pipeline bench encodes for its demo.
 * No file picker needed; the demo runs against these bytes directly.
 */
export const DEMO_PAYLOAD = {
  name: 'demo.txt',
  bytes: new TextEncoder().encode('EARDROP ✓ 2026'),
};

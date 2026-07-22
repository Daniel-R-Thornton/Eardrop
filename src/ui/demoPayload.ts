/**
 * demoPayload.ts — the in-memory sample the pipeline bench encodes for its demo.
 * No file picker needed; the demo runs against these bytes directly.
 *
 * Kept a few hundred bytes so a run spans several data frames — the frame
 * timeline then has multiple frames to focus/replay through the pipeline.
 */
const DEMO_TEXT = [
  'EARDROP — file transfer over sound.',
  'This message is being carried entirely by audio: no network, no cable,',
  'just a speaker and a microphone. Each frame you see in the pipeline is',
  'framed, CRC-checked, wrapped in error-correcting codes, mapped to symbols,',
  'and modulated onto 32 OFDM tones before it leaves the speaker.',
  'On the way back in it is synced, equalised, demodulated and reassembled.',
  '— transmitted 2026 · ✓',
].join('\n');

export const DEMO_PAYLOAD = {
  name: 'demo.txt',
  bytes: new TextEncoder().encode(DEMO_TEXT),
};

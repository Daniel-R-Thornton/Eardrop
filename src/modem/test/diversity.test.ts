import { describe, it, expect } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { DEFAULT_CONFIG } from '../types';

const TIMEOUT = 30000;

function runDiversityRoundtrip(
  payload: Uint8Array,
  fileName: string,
): { file: ReceivedFile | null; errors: number } {
  const cfg = { ...DEFAULT_CONFIG, diversityMode: true };
  const tx = new TxEngine(cfg);
  const rx = new RxEngine(cfg);
  const audio = tx.transmitFile(fileName, payload);
  for (let i = 0; i < audio.length; i++) rx.feedSample(audio[i]);
  const file = rx.getFile();
  let errors = payload.length;
  if (file && file.data.length > 0) {
    const len = Math.min(file.data.length, payload.length);
    errors = 0;
    for (let i = 0; i < len; i++) {
      if (file.data[i] !== payload[i]) errors++;
    }
  }
  return { file, errors };
}

describe('Diversity Mode (Hail Mary)', () => {
  it(
    'clean 64 bytes',
    () => {
      const payload = new Uint8Array(64);
      for (let i = 0; i < 64; i++) payload[i] = i;
      const r = runDiversityRoundtrip(payload, 'test64.bin');
      expect(r.file).not.toBeNull();
      expect(r.errors).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'all zeros 128 bytes',
    () => {
      const payload = new Uint8Array(128);
      const r = runDiversityRoundtrip(payload, 'zeros.bin');
      expect(r.file).not.toBeNull();
      expect(r.errors).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'all ones 128 bytes',
    () => {
      const payload = new Uint8Array(128);
      payload.fill(0xff);
      const r = runDiversityRoundtrip(payload, 'ones.bin');
      expect(r.file).not.toBeNull();
      expect(r.errors).toBe(0);
    },
    TIMEOUT,
  );
});

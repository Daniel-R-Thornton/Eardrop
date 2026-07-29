import { describe, it, expect } from 'vitest';
import { TxEngine } from '../protocol/txEngine';

/**
 * Correctness anchor for the streaming encode refactor: the streamed chunks,
 * concatenated and then globally peak-normalized, must be byte-identical to the
 * batch transmitFile output. This proves the frameSegments generator (shared by
 * both paths) preserves the exact waveform, and that the only difference between
 * streaming and batch is the global normalize step streaming intentionally omits.
 */

function concat(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((a, b) => a + b.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function peakNormalize(x: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const abs = Math.abs(x[i]);
    if (abs > peak) peak = abs;
  }
  const out = new Float32Array(x);
  if (peak > 1.0) {
    const scale = 1.0 / peak;
    for (let i = 0; i < out.length; i++) out[i] *= scale;
  }
  return out;
}

const SAMPLE_RATE = 48000;

function makeTx() {
  return new TxEngine({ useOFDM: true, sampleRate: SAMPLE_RATE, toneCount: 32 });
}

function randomData(n: number): Uint8Array {
  const d = new Uint8Array(n);
  for (let i = 0; i < n; i++) d[i] = (i * 131 + 17) & 0xff;
  return d;
}

describe('TxEngine.streamChunks', () => {
  for (const [label, size] of [
    ['tiny', 5],
    ['one frame', 160],
    ['multi frame', 1000],
  ] as const) {
    it(`streamed+normalized equals batch transmitFile (${label})`, () => {
      const data = randomData(size);
      const batch = makeTx().transmitFile('f.bin', data);
      const streamed = concat([...makeTx().streamChunks('f.bin', data, 24000)]);
      const streamedNorm = peakNormalize(streamed);

      expect(streamed.length).toBe(batch.length);
      let maxDiff = 0;
      for (let i = 0; i < batch.length; i++) {
        maxDiff = Math.max(maxDiff, Math.abs(batch[i] - streamedNorm[i]));
      }
      // Bit-for-bit up to Float32 rounding of the normalize multiply.
      expect(maxDiff).toBeLessThan(1e-6);
    });
  }

  it('chunk sizes tile exactly with a possibly-short final chunk', () => {
    const data = randomData(500);
    const chunk = 10000;
    const chunks = [...makeTx().streamChunks('f.bin', data, chunk)];
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length - 1; i++) expect(chunks[i].length).toBe(chunk);
    expect(chunks[chunks.length - 1].length).toBeLessThanOrEqual(chunk);
    const total = chunks.reduce((a, b) => a + b.length, 0);
    expect(total).toBe(makeTx().transmitFile('f.bin', data).length);
  });

  it('estimateStreamSamples is within 5% of actual streamed length', () => {
    const data = randomData(2000);
    const actual = concat([...makeTx().streamChunks('f.bin', data, 24000)]).length;
    const est = makeTx().estimateStreamSamples(data.length);
    expect(Math.abs(est - actual) / actual).toBeLessThan(0.05);
  });
});

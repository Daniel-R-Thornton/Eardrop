/**
 * compression.test.ts — Phase 6 compression codec.
 *
 * Covers: binary-safety fuzz (the exact class of bug the old
 * src/modem/debug/dictionary.ts had — literal ESC-range bytes getting
 * corrupted), the never-worse raw fallback, real compression gain on
 * representative payloads, magic-byte/text detection, and an end-to-end
 * check that the wire header carries schemeId+origSize and RxEngine
 * restores the exact original bytes.
 */
import { expect, test, describe } from 'vitest';
import { compress, decompress, detect, SCHEME } from '../compression';
import { ModemService } from '../../workers/modemService';
import type { ModemEvent } from '../../workers/modemSchema';
import { DEFAULT_CONFIG, ofdmSamples } from '../types';

// ─── Deterministic PRNG (mulberry32) — reproducible fuzz runs ───────────
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rng: () => number, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(rng() * 256);
  return out;
}

const SCHEMES = [SCHEME.RAW, SCHEME.TEXT, SCHEME.JSON, SCHEME.LOG];

// ─── Round-trip fuzz — binary safety ────────────────────────────────────

describe('round-trip fuzz (binary safety)', () => {
  for (const scheme of SCHEMES) {
    test(`scheme 0x${scheme.toString(16).padStart(2, '0')}: random data round-trips exactly`, () => {
      const rng = mulberry32(1000 + scheme);
      for (let trial = 0; trial < 50; trial++) {
        const len = 1 + Math.floor(rng() * 500);
        const data = randomBytes(rng, len);
        const { bytes, scheme: usedScheme } = compress(data, scheme);
        const restored = decompress(bytes, usedScheme);
        expect(Array.from(restored)).toEqual(Array.from(data));
      }
    });

    test(`scheme 0x${scheme.toString(16).padStart(2, '0')}: explicit ESC/0x00/0xFF and full byte range round-trip`, () => {
      // The old dictionary.ts corrupted any literal byte that collided with
      // its token range. Explicitly hammer 0x00, 0xFE (ESC), 0xFF, and every
      // byte value 0..255 back to back — this is exactly the class of input
      // that would have broken it.
      const inputs: Uint8Array[] = [
        new Uint8Array([0x00]),
        new Uint8Array([0xfe]),
        new Uint8Array([0xff]),
        new Uint8Array([0x00, 0xfe, 0xff, 0xfe, 0x00, 0xfe, 0xfe, 0xff]),
        Uint8Array.from({ length: 256 }, (_, i) => i), // every byte value once
        Uint8Array.from({ length: 512 }, (_, i) => (i % 256)), // every byte value twice
        new Uint8Array(20).fill(0xfe), // run of nothing but ESC
      ];
      for (const data of inputs) {
        const { bytes, scheme: usedScheme } = compress(data, scheme);
        const restored = decompress(bytes, usedScheme);
        expect(Array.from(restored)).toEqual(Array.from(data));
      }
    });
  }
});

// ─── Raw fallback — never worse than input ──────────────────────────────

describe('raw fallback', () => {
  test('incompressible random data falls back to scheme 0x00 and never grows', () => {
    const rng = mulberry32(42);
    for (const scheme of [SCHEME.TEXT, SCHEME.JSON, SCHEME.LOG]) {
      for (let trial = 0; trial < 10; trial++) {
        const data = randomBytes(rng, 200 + Math.floor(rng() * 300));
        const result = compress(data, scheme);
        expect(result.scheme).toBe(SCHEME.RAW);
        expect(result.bytes.length).toBeLessThanOrEqual(data.length);
        expect(Array.from(result.bytes)).toEqual(Array.from(data));
      }
    }
  });

  test('unknown scheme id falls back to raw on compress and decompress', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const result = compress(data, 0x7f);
    expect(result.scheme).toBe(SCHEME.RAW);
    expect(Array.from(result.bytes)).toEqual(Array.from(data));
    expect(Array.from(decompress(data, 0x7f))).toEqual(Array.from(data));
  });
});

// ─── Real gain on representative payloads ───────────────────────────────

describe('real compression gain', () => {
  test('repetitive prose text compresses smaller under the text scheme', () => {
    const text =
      'The quick brown fox and the lazy dog. This is a test of the text dictionary, ' +
      'and this text has the word "the" and "and" and "with" repeated many times. ' +
      'This is the sort of prose that should compress well with the text dictionary. ' +
      'The cat sat on the mat, and the dog ran to the park with the ball for the boy. ' +
      'They said that this is what they would do when there is time for it, and they '.repeat(4);
    const data = new TextEncoder().encode(text);
    const { bytes, scheme } = compress(data, SCHEME.TEXT);
    expect(scheme).toBe(SCHEME.TEXT);
    expect(bytes.length).toBeLessThan(data.length);
    expect(Array.from(decompress(bytes, scheme))).toEqual(Array.from(data));
  });

  test('sample JSON compresses smaller under the JSON scheme', () => {
    const records = Array.from({ length: 30 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      type: 'widget',
      value: i * 10,
      active: true,
    }));
    const json = JSON.stringify(records);
    const data = new TextEncoder().encode(json);
    const { bytes, scheme } = compress(data, SCHEME.JSON);
    expect(scheme).toBe(SCHEME.JSON);
    expect(bytes.length).toBeLessThan(data.length);
    expect(Array.from(decompress(bytes, scheme))).toEqual(Array.from(data));
  });
});

// ─── detect() ────────────────────────────────────────────────────────────

describe('detect()', () => {
  test('JPEG magic bytes -> raw', () => {
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(detect('photo.jpg', data)).toBe(SCHEME.RAW);
  });

  test('PNG magic bytes -> raw', () => {
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(detect('image.png', data)).toBe(SCHEME.RAW);
  });

  test('PDF magic bytes -> raw', () => {
    const data = new TextEncoder().encode('%PDF-1.4\n%...');
    expect(detect('doc.pdf', data)).toBe(SCHEME.RAW);
  });

  test('gzip magic bytes -> raw', () => {
    const data = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
    expect(detect('archive.tar.gz', data)).toBe(SCHEME.RAW);
  });

  test('zip magic bytes -> raw', () => {
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(detect('bundle.zip', data)).toBe(SCHEME.RAW);
  });

  test('JSON object -> 0x02', () => {
    const data = new TextEncoder().encode('{"a":1,"b":[1,2,3]}');
    expect(detect('data.txt', data)).toBe(SCHEME.JSON);
  });

  test('JSON array -> 0x02', () => {
    const data = new TextEncoder().encode('[1,2,3,{"a":1}]');
    expect(detect('data', data)).toBe(SCHEME.JSON);
  });

  test('prose text -> 0x01', () => {
    const data = new TextEncoder().encode(
      'This is a plain English sentence with no special structure at all, just words.',
    );
    expect(detect('notes.txt', data)).toBe(SCHEME.TEXT);
  });

  test('CSV-ish content -> 0x03', () => {
    const data = new TextEncoder().encode('a,b,c\n1,2,3\n4,5,6\n7,8,9\n');
    expect(detect('table.csv', data)).toBe(SCHEME.LOG);
  });
});

// ─── End-to-end: header carries schemeId+origSize, RX restores exact bytes ──

const SAMPLE_RATE = 48000;
const CFG = {
  ...DEFAULT_CONFIG,
  sampleRate: SAMPLE_RATE,
  pilotFreqHz: 1900,
  toneCount: 16,
  useOFDM: true,
};

function runThroughModemService(fileName: string, data: Uint8Array): ModemEvent[] {
  const events: ModemEvent[] = [];
  const svc = new ModemService((ev) => events.push(ev));
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });

  svc.handle({ type: 'encodeFile', id: 1, fileName, data: data.buffer as ArrayBuffer });
  const encoded = events.find((e) => e.type === 'encoded');
  if (!encoded || encoded.type !== 'encoded') throw new Error('encode failed');
  const audio = new Float32Array(encoded.samples);

  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  const padded = new Float32Array(audio.length + symSamples * 8);
  padded.set(audio, 0);

  for (let off = 0; off < padded.length; off += 512) {
    const chunk = padded.slice(off, Math.min(off + 512, padded.length));
    svc.handle({ type: 'feedChunk', samples: chunk.buffer as ArrayBuffer });
    svc.tick();
  }
  return events;
}

describe('modemService end-to-end: compression header carriage', () => {
  test('compressible JSON payload round-trips byte-exact through encode -> RX -> decompress', () => {
    const records = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      name: `n${i}`,
      type: 'x',
      value: i,
    }));
    const json = JSON.stringify(records);
    const data = new TextEncoder().encode(json);

    // Sanity: this payload really is detected + compressed (proves the
    // header will actually carry a non-zero schemeId for this test).
    const scheme = detect('data.json', data);
    expect(scheme).toBe(SCHEME.JSON);
    const { scheme: usedScheme } = compress(data, scheme);
    expect(usedScheme).not.toBe(SCHEME.RAW);

    const events = runThroughModemService('data.json', data);
    const done = events.find((e) => e.type === 'fileComplete');
    expect(done, 'fileComplete event should fire').toBeDefined();
    if (done && done.type === 'fileComplete') {
      expect(new Uint8Array(done.data).length).toBe(data.length);
      expect(Array.from(new Uint8Array(done.data))).toEqual(Array.from(data));
    }
  });

  test('incompressible binary payload still round-trips (raw fallback path)', () => {
    const rng = mulberry32(7);
    const data = randomBytes(rng, 150);
    const events = runThroughModemService('blob.bin', data);
    const done = events.find((e) => e.type === 'fileComplete');
    expect(done).toBeDefined();
    if (done && done.type === 'fileComplete') {
      expect(Array.from(new Uint8Array(done.data))).toEqual(Array.from(data));
    }
  });
});

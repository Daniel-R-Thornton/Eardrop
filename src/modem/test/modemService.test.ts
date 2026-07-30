/**
 * ModemService — worker logic without a worker. Commands in, events out.
 */
import { expect, test } from 'vitest';
import { ModemService } from '../../workers/modemService';
import type { ModemEvent } from '../../workers/modemSchema';
import { TxEngine } from '../protocol/txEngine';
import { DEFAULT_CONFIG, ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const CFG = {
  ...DEFAULT_CONFIG,
  sampleRate: SAMPLE_RATE,
  pilotFreqHz: 1900,
  toneCount: 16,
  useOFDM: true,
};

function makeService() {
  const events: ModemEvent[] = [];
  const svc = new ModemService((ev) => events.push(ev));
  return { svc, events };
}

// Compression (gzip) + file-complete decompression are async; flush a macrotask
// so those deferred emits land before we assert on `events`.
const flush = () => new Promise((r) => setTimeout(r, 20));

test('configure → startRx → feedChunk → fileComplete', async () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });

  const data = new Uint8Array(120);
  for (let i = 0; i < data.length; i++) data[i] = (i * 11 + 3) & 0xff;
  const tx = new TxEngine(CFG as ConstructorParameters<typeof TxEngine>[0]);
  const audio = tx.transmitFile('svc.bin', data);
  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  const padded = new Float32Array(audio.length + symSamples * 8);
  padded.set(audio, 0);

  for (let off = 0; off < padded.length; off += 512) {
    const chunk = padded.slice(off, Math.min(off + 512, padded.length));
    svc.handle({ type: 'feedChunk', samples: chunk.buffer });
    svc.tick();
  }

  await flush(); // fileComplete is emitted after async decompression
  const done = events.find((e) => e.type === 'fileComplete');
  expect(done, 'fileComplete event should fire').toBeDefined();
  if (done && done.type === 'fileComplete') {
    expect(Array.from(new Uint8Array(done.data))).toEqual(Array.from(data));
  }
});

test('one configured session delivers TWO files (fileComplete not latched after first delivery)', async () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });

  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  const tx = new TxEngine(CFG as ConstructorParameters<typeof TxEngine>[0]);

  const sendAndFeed = (fileName: string, data: Uint8Array) => {
    const audio = tx.transmitFile(fileName, data);
    const padded = new Float32Array(audio.length + symSamples * 8);
    padded.set(audio, 0);
    for (let off = 0; off < padded.length; off += 512) {
      const chunk = padded.slice(off, Math.min(off + 512, padded.length));
      svc.handle({ type: 'feedChunk', samples: chunk.buffer });
      svc.tick();
    }
  };

  const data1 = new Uint8Array(120);
  for (let i = 0; i < data1.length; i++) data1[i] = (i * 11 + 3) & 0xff;
  sendAndFeed('first.bin', data1);
  await flush();

  const data2 = new Uint8Array(140);
  for (let i = 0; i < data2.length; i++) data2[i] = (i * 17 + 5) & 0xff;
  sendAndFeed('second.bin', data2);
  await flush();

  const delivered = events.filter((e) => e.type === 'fileComplete');
  expect(delivered.length, 'both transfers should deliver fileComplete exactly once each').toBe(2);
  expect(delivered[0].type === 'fileComplete' && delivered[0].fileName).toBe('first.bin');
  expect(delivered[1].type === 'fileComplete' && delivered[1].fileName).toBe('second.bin');
  if (delivered[0].type === 'fileComplete') {
    expect(Array.from(new Uint8Array(delivered[0].data))).toEqual(Array.from(data1));
  }
  if (delivered[1].type === 'fileComplete') {
    expect(Array.from(new Uint8Array(delivered[1].data))).toEqual(Array.from(data2));
  }

  // Extra ticks after the second delivery must not re-deliver anything.
  for (let i = 0; i < 20; i++) svc.tick();
  await flush();
  const deliveredAfter = events.filter((e) => e.type === 'fileComplete');
  expect(deliveredAfter.length, 'no duplicate deliveries from continued polling').toBe(2);
});

test('encodeFile emits encoded with the config given to configure (no per-call config)', async () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  const payload = new Uint8Array([1, 2, 3, 4]);
  svc.handle({ type: 'encodeFile', id: 42, fileName: 'x.bin', data: payload.buffer });

  await flush(); // encode runs after async compression
  const enc = events.find((e) => e.type === 'encoded');
  expect(enc).toBeDefined();
  if (enc && enc.type === 'encoded') {
    expect(enc.id).toBe(42);
    expect(enc.sampleRate).toBe(SAMPLE_RATE);
    expect(new Float32Array(enc.samples).length).toBeGreaterThan(0);
  }
});

test('streaming encode (start → pull* → end) reconstructs the batch waveform', async () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });

  const data = new Uint8Array(600);
  for (let i = 0; i < data.length; i++) data[i] = (i * 29 + 7) & 0xff;

  svc.handle({ type: 'encodeStreamStart', id: 7, fileName: 's.bin', data: data.slice().buffer });
  await flush(); // stream generator is set up after async compression
  const start = events.find((e) => e.type === 'streamStart');
  expect(start, 'streamStart should fire').toBeDefined();

  // Pull until streamEnd; collect chunk buffers.
  const chunks: Float32Array[] = [];
  let ended = false;
  for (let guard = 0; guard < 100000 && !ended; guard++) {
    const before = events.length;
    svc.handle({ type: 'encodeStreamPull', id: 7 });
    for (let i = before; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === 'streamChunk' && ev.id === 7) chunks.push(new Float32Array(ev.samples));
      if (ev.type === 'streamEnd' && ev.id === 7) ended = true;
    }
  }
  expect(ended, 'streamEnd should fire').toBe(true);
  expect(chunks.length).toBeGreaterThan(1);

  // Concatenate + global peak-normalize → must equal batch transmitFile.
  const total = chunks.reduce((a, b) => a + b.length, 0);
  const streamed = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    streamed.set(c, off);
    off += c.length;
  }
  let peak = 0;
  for (let i = 0; i < streamed.length; i++) peak = Math.max(peak, Math.abs(streamed[i]));
  if (peak > 1.0) {
    const scale = 1.0 / peak;
    for (let i = 0; i < streamed.length; i++) streamed[i] *= scale;
  }

  const batch = new TxEngine(CFG as ConstructorParameters<typeof TxEngine>[0]).transmitFile('s.bin', data);
  expect(streamed.length).toBe(batch.length);
  let maxDiff = 0;
  for (let i = 0; i < batch.length; i++) maxDiff = Math.max(maxDiff, Math.abs(batch[i] - streamed[i]));
  expect(maxDiff).toBeLessThan(1e-6);
});

test('encodeStreamCancel stops further chunk production', async () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  const data = new Uint8Array(600);
  svc.handle({ type: 'encodeStreamStart', id: 9, fileName: 's.bin', data: data.slice().buffer });
  await flush(); // stream generator ready after async compression
  svc.handle({ type: 'encodeStreamPull', id: 9 }); // one chunk
  svc.handle({ type: 'encodeStreamCancel', id: 9 });
  const before = events.length;
  svc.handle({ type: 'encodeStreamPull', id: 9 }); // stale — ignored
  expect(events.length).toBe(before); // no new events after cancel
});

test('telemetry tick while listening reports rms, spectrum, progress', () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });
  const noise = new Float32Array(4096);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.sin(i / 3) * 0.1;
  svc.handle({ type: 'feedChunk', samples: noise.buffer });
  svc.tick();

  const t = events.find((e) => e.type === 'telemetry');
  expect(t).toBeDefined();
  if (t && t.type === 'telemetry') {
    expect(t.telemetry.rms).toBeGreaterThan(0);
    expect(t.telemetry.spectrum.length).toBe(64);
    expect(t.telemetry.toneEnergies.length).toBe(16);
    expect(t.telemetry.progress.state).toBeGreaterThanOrEqual(0);
  }
});

test('dumpBuffer returns the most recent seconds of audio', () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });
  const chunk = new Float32Array(SAMPLE_RATE); // 1 s
  chunk.fill(0.25);
  svc.handle({ type: 'feedChunk', samples: chunk.buffer });
  svc.handle({ type: 'dumpBuffer', id: 7, seconds: 0.5 });

  const d = events.find((e) => e.type === 'bufferDump');
  expect(d).toBeDefined();
  if (d && d.type === 'bufferDump') {
    expect(d.id).toBe(7);
    expect(new Float32Array(d.samples).length).toBe(SAMPLE_RATE / 2);
    expect(d.peak).toBeCloseTo(0.25, 2);
  }
});

test('flush reports fileReady=false when the fed audio decoded nothing', () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });
  const noise = new Float32Array(SAMPLE_RATE / 2);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.sin(i * 0.31) * 0.05;
  svc.handle({ type: 'feedChunk', samples: noise.buffer });
  svc.handle({ type: 'flush', id: 5 });

  const f = events.find((e) => e.type === 'flushed');
  expect(f, 'flush must always reply, so callers never wait out a timeout').toBeDefined();
  if (f && f.type === 'flushed') {
    expect(f.id).toBe(5);
    expect(f.fileReady).toBe(false);
  }
});

test('flush finds a completed file without any tick(), and the file follows', async () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  svc.handle({ type: 'startRx' });

  const data = new Uint8Array(120);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7 + 1) & 0xff;
  const tx = new TxEngine(CFG as ConstructorParameters<typeof TxEngine>[0]);
  const audio = tx.transmitFile('flush.bin', data);
  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  const padded = new Float32Array(audio.length + symSamples * 8);
  padded.set(audio, 0);

  // Deliberately no tick() anywhere: the flush barrier alone must notice.
  svc.handle({ type: 'feedChunk', samples: padded.buffer });
  svc.handle({ type: 'flush', id: 9 });

  const f = events.find((e) => e.type === 'flushed');
  expect(f).toBeDefined();
  if (f && f.type === 'flushed') expect(f.fileReady).toBe(true);

  await flush();
  const done = events.find((e) => e.type === 'fileComplete');
  expect(done, 'fileComplete should follow the flush barrier').toBeDefined();
  if (done && done.type === 'fileComplete') {
    expect(Array.from(new Uint8Array(done.data))).toEqual(Array.from(data));
  }
});

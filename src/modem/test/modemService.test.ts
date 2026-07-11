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

test('configure → startRx → feedChunk → fileComplete', () => {
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

  const done = events.find((e) => e.type === 'fileComplete');
  expect(done, 'fileComplete event should fire').toBeDefined();
  if (done && done.type === 'fileComplete') {
    expect(Array.from(new Uint8Array(done.data))).toEqual(Array.from(data));
  }
});

test('encodeFile emits encoded with the config given to configure (no per-call config)', () => {
  const { svc, events } = makeService();
  svc.handle({ type: 'configure', config: CFG });
  const payload = new Uint8Array([1, 2, 3, 4]);
  svc.handle({ type: 'encodeFile', id: 42, fileName: 'x.bin', data: payload.buffer });

  const enc = events.find((e) => e.type === 'encoded');
  expect(enc).toBeDefined();
  if (enc && enc.type === 'encoded') {
    expect(enc.id).toBe(42);
    expect(enc.sampleRate).toBe(SAMPLE_RATE);
    expect(new Float32Array(enc.samples).length).toBeGreaterThan(0);
  }
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

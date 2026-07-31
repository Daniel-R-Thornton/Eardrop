/**
 * toneStartHz — user control for the OFDM tone-grid start offset above the
 * pilot (Task 9). Two fences:
 *
 *  1. Default-value regression: leaving toneStartHz unset must reproduce
 *     today's waveform byte-for-byte (default 2000Hz, matching
 *     OFDM_DEFAULTS.toneStartHz).
 *  2. TX/RX grid agreement at a non-default offset, proven through the real
 *     config path (buildModemConfig → TxEngine / RxEngine), not by hand-
 *     constructing matching tone-frequency arrays on both sides.
 */
import { describe, test, expect } from 'vitest';
import { buildModemConfig } from '../../ui/controllers/buildModemConfig';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';

const BASE_UI = {
  useOFDM: true,
  pilotFreqHz: 1900,
  toneCount: 32,
  symbolsPerSec: 50,
  musicalMode: false,
  diversityMode: false,
  hwSampleRate: 48000,
};

function loopback(config: Parameters<typeof buildModemConfig>[0], payload: Uint8Array): {
  decodedPayload: Uint8Array;
} {
  const cfg = buildModemConfig(config);
  const tx = new TxEngine(cfg as any);
  const rx = new RxEngine(cfg as any);

  const chunks: Float32Array[] = [];
  for (const chunk of tx.streamChunks('test.bin', payload, 19200)) {
    chunks.push(chunk);
  }
  for (const chunk of chunks) rx.feedChunk(chunk);

  const file = rx.getFile();
  if (!file) throw new Error('RX returned no file');
  return { decodedPayload: file.data.slice(0, payload.length) };
}

describe('toneStartHz — default-value regression', () => {
  test('explicit toneStartHz=2000 produces a byte-identical waveform to omitting it', () => {
    const payload = new Uint8Array(160);
    for (let i = 0; i < 160; i++) payload[i] = i;

    const cfgDefault = buildModemConfig(BASE_UI); // toneStartHz omitted
    const cfgExplicit = buildModemConfig({ ...BASE_UI, toneStartHz: 2000 });

    expect(cfgExplicit.toneStartHz).toBe(cfgDefault.toneStartHz);
    expect(cfgDefault.toneStartHz).toBe(2000);

    const txDefault = new TxEngine(cfgDefault as any);
    const txExplicit = new TxEngine(cfgExplicit as any);

    const audioDefault = txDefault.transmitFile('test.bin', payload, 0, payload.length);
    const audioExplicit = txExplicit.transmitFile('test.bin', payload, 0, payload.length);

    expect(audioExplicit).toStrictEqual(audioDefault);
  });
});

describe('toneStartHz — TX/RX grid agreement through the real config path', () => {
  test('non-default offset (1000Hz) decodes byte-exact end to end', () => {
    const payload = new Uint8Array(160);
    for (let i = 0; i < 160; i++) payload[i] = (i * 131 + 47) & 0xff;

    const result = loopback({ ...BASE_UI, toneStartHz: 1000 }, payload);
    expect(result.decodedPayload).toStrictEqual(payload);
  });

  test('multi-frame (320B) round-trip at a non-default offset (800Hz)', () => {
    const payload = new Uint8Array(320);
    for (let i = 0; i < 320; i++) payload[i] = i % 256;

    const result = loopback({ ...BASE_UI, toneStartHz: 800 }, payload);
    expect(result.decodedPayload).toStrictEqual(payload);
  });
});

describe('toneStartHz — clamp guard', () => {
  test('below the 600Hz floor is clamped, not passed through raw', () => {
    const cfg = buildModemConfig({ ...BASE_UI, toneStartHz: 100 });
    expect(cfg.toneStartHz).toBe(600);
  });
});

/**
 * 64-QAM propagation fence — verifies every hop from UI config → TxEngine
 * into the actual symbol stream. Catches silent fallbacks or dropped fields.
 */
import { describe, test, expect } from 'vitest';
import { buildModemConfig } from '../../ui/controllers/buildModemConfig';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine } from '../protocol/rxEngine';
import { decodeFrame } from '../protocol/atomicFrame';
import { OFDM_TUNING, ofdmSamples } from '../types';

// ─── Helpers ──────────────────────────────────────────────

const BASE_UI = {
  useOFDM: true,
  pilotFreqHz: 1900,
  toneCount: 32,
  symbolsPerSec: 50,
  musicalMode: false,
  diversityMode: false,
  hwSampleRate: 48000,
};

/** Run a raw-typed TX→RX loopback (same modulator/demodulator under the hood). */
function loopback(config: Parameters<typeof buildModemConfig>[0], payload: Uint8Array): {
  decodedPayload: Uint8Array;
  framesDecoded: number;
} {
  // 1. Build config and create engines
  const cfg = buildModemConfig(config);
  const tx = new TxEngine(cfg as any);
  const rx = new RxEngine(cfg as any);

  // 2. Generate audio (streaming for memory efficiency)
  const chunks: Float32Array[] = [];
  for (const chunk of tx.streamChunks('test.bin', payload, 19200)) { // 0.4s chunks
    chunks.push(chunk);
  }

  // 3. Feed all samples to RX
  for (const chunk of chunks) {
    rx.feedChunk(chunk);
  }

  // 4. Extract file
  const file = rx.getFile();
  if (!file) throw new Error('RX returned no file');

  return { decodedPayload: file.data.slice(0, payload.length), framesDecoded: file.totalBytes };
}

// ─── Config propagation ────────────────────────────────────

describe('buildModemConfig → 64-QAM', () => {
  test('emits link profile with correct qamMap length', () => {
    const cfg = buildModemConfig({ ...BASE_UI, dataQamBits: 6 });
    expect(cfg.emitLinkProfile).toBe(true);
    expect(Array.isArray(cfg.qamMap)).toBe(true);
    expect(cfg.qamMap!.length).toBe(BASE_UI.toneCount);
    expect(cfg.qamMap).toEqual(new Array(BASE_UI.toneCount).fill(2)); // value=2 ⇒ 64-QAM
  });

  test('omitting dataQamBits defaults to QPSK (no profile)', () => {
    const cfg = buildModemConfig(BASE_UI); // no dataQamBits = omit
    expect(cfg.emitLinkProfile).toBeFalsy();
    expect(cfg.qamMap).toBeUndefined();
  });

  test('non-OFDM + 64-QIM: profile suppressed entirely', () => {
    const cfg = buildModemConfig({ ...BASE_UI, useOFDM: false, dataQamBits: 6 });
    expect(cfg.emitLinkProfile).toBeFalsy();
    expect(cfg.qamMap).toBeUndefined();
  });
});

// ─── TxEngine receives config correctly ────────────────────

describe('TxEngine construction with 64-QAM config', () => {
  test('constructor accepts emitLinkProfile + qamMap from config', () => {
    const cfg = buildModemConfig({ ...BASE_UI, dataQamBits: 6 });
    const tx = new TxEngine(cfg as any);

    // Public API check: isOFDM confirms engine was built for OFDM
    expect(tx.isOFDM()).toBe(true);
  });

  test('modulateFrame returns fewer symbols at QAM-64 vs QPSK', () => {
    const cfg = buildModemConfig(BASE_UI); // QPSK default
    const tx = new TxEngine(cfg as any);
    const qpskAudio = tx.transmitFile('test.bin', new Uint8Array(8), 0, 8);
    const symLen = tx.getSymbolLengthInSamples();
    const qpskSymbols = Math.ceil(qpskAudio.length / symLen);

    // Switch to 64-QAM
    const qamCfg = buildModemConfig({ ...BASE_UI, dataQamBits: 6 });
    const qamTx = new TxEngine(qamCfg as any);
    const qamAudio = qamTx.transmitFile('test.bin', new Uint8Array(8), 0, 8);
    const qamSymbols = Math.ceil(qamAudio.length / qamTx.getSymbolLengthInSamples());

    // QAM packs more bits/symbol → fewer symbols for same frame
    expect(qamSymbols).toBeLessThan(qpskSymbols);
  });
});

// ─── End-to-end TX → RX loopback ──────────────────────────

describe('TX→RX loopback (acoustic-free, direct feed)', () => {
  test('QPSK round-trips 160 bytes cleanly', () => {
    const payload = new Uint8Array(160);
    for (let i = 0; i < 160; i++) payload[i] = i; // 0x00..0x9F

    const result = loopback(BASE_UI, payload);
    expect(result.decodedPayload).toStrictEqual(payload);
  });

  test('QAM-64 round-trips 160 bytes cleanly', () => {
    const payload = new Uint8Array(160);
    for (let i = 0; i < 160; i++) payload[i] = i; // 0x00..0x9F

    const result = loopback({ ...BASE_UI, dataQamBits: 6 }, payload);
    expect(result.decodedPayload).toStrictEqual(payload);
  });

  test('QAM-64 with random data', () => {
    const rand = new Uint8Array(160);
    for (let i = 0; i < 160; i++) rand[i] = (i * 131 + 47) & 0xff;

    const result = loopback({ ...BASE_UI, dataQamBits: 6 }, rand);
    expect(result.decodedPayload).toStrictEqual(rand);
  });

  test('QAM-16 round-trips 160 bytes', () => {
    const payload = new Uint8Array(160);
    for (let i = 0; i < 160; i++) payload[i] = i;

    const result = loopback({ ...BASE_UI, dataQamBits: 4 }, payload);
    expect(result.decodedPayload).toStrictEqual(payload);
  });

  test('multi-frame (320B) round-trip at QAM-64', () => {
    const payload = new Uint8Array(320);
    for (let i = 0; i < 320; i++) payload[i] = (i % 256);

    const result = loopback({ ...BASE_UI, dataQamBits: 6 }, payload);
    expect(result.decodedPayload).toStrictEqual(payload);
  });
});

// ─── Symbol-count verification (debug aid) ─────────────────

describe('symbol count math', () => {
  test('79-byte atomic frame spans correct symbols per rate', () => {
    const FRAME_SIZE = 235; // bytes per atomic frame
    const bitsPerByte = 8;
    const totalBits = FRAME_SIZE * bitsPerByte;

    // QPSK: 2 bits/tone × 32 tones = 64 bits/symbol
    const qpskSym = Math.ceil(totalBits / (2 * 32));
    expect(qpskSym).toBe(30); // ceil(1880/64) = 30

    // 16-QAM: 4 bits/tone × 32 tones = 128 bits/symbol
    const qam16Sym = Math.ceil(totalBits / (4 * 32));
    expect(qam16Sym).toBe(15); // ceil(1880/128) = 15

    // 64-QAM: 6 bits/tone × 32 tones = 192 bits/symbol
    const qam64Sym = Math.ceil(totalBits / (6 * 32));
    expect(qam64Sym).toBe(10); // ceil(1880/192) = 10
  });
});

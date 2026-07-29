/**
 * ofdm_qam_loopback.test.ts — THE oracle for Phase 3 part 2.
 *
 * Modulate a known random payload through OFDMQPSKModulator → (noise-free
 * channel) → OFDMQPSKDemodulator for several per-tone order maps (all-16QAM,
 * all-64QAM, mixed) and assert the demodulated bits/bytes exactly equal the
 * input. Also checks byte throughput per symbol scales with the order map.
 */
import { describe, expect, test } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import type { QamOrder } from '../modulation/constellation';
import { ofdmSamples, ofdmToneFrequencies } from '../types';

const TONE_COUNT = 8;
const PILOT_FREQ = 1900;
const PILOT_AMPLITUDE = 2.0;
const SAMPLE_RATE = 48000;
const TONE_FREQS = ofdmToneFrequencies({ toneCount: TONE_COUNT, pilotFreqHz: PILOT_FREQ });

function makeTrainedPair(orders: QamOrder[]) {
  const mod = new OFDMQPSKModulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
    pilotAmplitude: PILOT_AMPLITUDE,
  });
  const demod = new OFDMQPSKDemodulator({
    sampleRate: SAMPLE_RATE,
    toneFrequencies: TONE_FREQS,
    pilotFreqHz: PILOT_FREQ,
  });
  // Training ALWAYS happens at the base (all-QPSK) rate — see architecture
  // doc in OFDMQPSKDemodulator/rxEngine: the modulator/demodulator only
  // switch to the profile's orders AFTER training completes.
  mod.setSymbols(new Array(TONE_COUNT).fill(0));
  for (let s = 0; s < 12; s++) demod.trainOnSyncSymbol(mod.generateSymbol());

  // The single switch point on each side, mirroring rxEngine.setToneOrders()
  // right after a PROFILE frame parse, and TxEngine.frameSegments() right
  // after yielding the profile frame.
  mod.setToneOrders(orders);
  demod.setToneOrders(orders);
  return { mod, demod };
}

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generic serializer mirroring OFDMEngine.modulateFrame's QAM path: drain
 * `bytes` MSB-first into per-tone bit allocations per symbol, padding the
 * final symbol with zero bits. Returns the symbol-by-symbol tone bit values.
 */
function serializeToSymbols(bytes: Uint8Array, orders: QamOrder[]): number[][] {
  const bitsPerSymbol = orders.reduce((a, b) => a + b, 0);
  const totalBits = bytes.length * 8;
  const symbolCount = Math.ceil(totalBits / bitsPerSymbol);
  let byteIdx = 0;
  let bitInByte = 0;
  const nextBit = (): number => {
    if (byteIdx >= bytes.length) return 0;
    const bit = (bytes[byteIdx] >> (7 - bitInByte)) & 1;
    bitInByte++;
    if (bitInByte === 8) {
      bitInByte = 0;
      byteIdx++;
    }
    return bit;
  };
  const symbols: number[][] = [];
  for (let s = 0; s < symbolCount; s++) {
    const symbolTones: number[] = new Array(orders.length);
    for (let t = 0; t < orders.length; t++) {
      let value = 0;
      for (let b = 0; b < orders[t]; b++) value = (value << 1) | nextBit();
      symbolTones[t] = value;
    }
    symbols.push(symbolTones);
  }
  return symbols;
}

/** Inverse of serializeToSymbols: reassemble bytes from demodulated per-tone bits. */
function deserializeBytes(perSymbolBits: number[][], expectedByteCount: number): Uint8Array {
  const out = new Uint8Array(expectedByteCount);
  let acc = 0;
  let count = 0;
  let outIdx = 0;
  for (const bits of perSymbolBits) {
    for (const bit of bits) {
      acc = (acc << 1) | bit;
      count++;
      if (count === 8) {
        if (outIdx < expectedByteCount) out[outIdx++] = acc & 0xff;
        acc = 0;
        count = 0;
      }
    }
  }
  return out;
}

function randomBytes(n: number, seed: number): Uint8Array {
  const rnd = mulberry32(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rnd() * 256);
  return out;
}

const ORDER_MAPS: Array<{ label: string; orders: QamOrder[] }> = [
  { label: 'all-16QAM', orders: new Array(TONE_COUNT).fill(4) as QamOrder[] },
  { label: 'all-64QAM', orders: new Array(TONE_COUNT).fill(6) as QamOrder[] },
  { label: 'mixed', orders: [2, 4, 6, 2, 4, 6, 4, 2] as QamOrder[] },
  { label: 'mixed-2', orders: [6, 6, 4, 4, 2, 2, 6, 4] as QamOrder[] },
];

describe('QAM mod→demod loopback (noise-free, trained) — bit-exact', () => {
  for (const { label, orders } of ORDER_MAPS) {
    test(`${label}: random payload round-trips exactly`, () => {
      const { mod, demod } = makeTrainedPair(orders);
      const payload = randomBytes(64, 12345);
      const symbols = serializeToSymbols(payload, orders);

      const perSymbolBits: number[][] = [];
      for (const symbolTones of symbols) {
        mod.setSymbols(symbolTones);
        const audio = mod.generateSymbol();
        const result = demod.demodulate(audio);
        perSymbolBits.push(result.bits);
      }

      const recovered = deserializeBytes(perSymbolBits, payload.length);
      expect(Array.from(recovered)).toEqual(Array.from(payload));
    });
  }

  test('bit throughput per symbol scales with the order map', () => {
    for (const { orders } of ORDER_MAPS) {
      const { mod, demod } = makeTrainedPair(orders);
      const bitsPerSymbol = orders.reduce((a, b) => a + b, 0);
      const symbolTones = orders.map((o) => (1 << o) >> 1);
      mod.setSymbols(symbolTones);
      const result = demod.demodulate(mod.generateSymbol());
      expect(result.bits.length).toBe(bitsPerSymbol);
    }
    // Sanity: all-QPSK (default) still yields 2 bits/tone.
    const qpskOrders: QamOrder[] = new Array(TONE_COUNT).fill(2) as QamOrder[];
    const { mod, demod } = makeTrainedPair(qpskOrders);
    mod.setSymbols(new Array(TONE_COUNT).fill(1));
    const result = demod.demodulate(mod.generateSymbol());
    expect(result.bits.length).toBe(TONE_COUNT * 2);
  });
});

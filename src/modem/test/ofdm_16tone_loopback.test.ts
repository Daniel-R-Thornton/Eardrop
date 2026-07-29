import { describe, it, expect } from 'vitest';
import { OFDMQPSKModulator } from '../modulation/OFDMQPSKModulator';
import { OFDMQPSKDemodulator } from '../demodulation/OFDMQPSKDemodulator';
import type { QamOrder } from '../modulation/constellation';
import { ofdmToneFrequencies } from '../types';

const TONE_COUNT = 16;
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
  // Training ALWAYS happens at the base (all-QPSK) rate
  mod.setSymbols(new Array(TONE_COUNT).fill(0));
  for (let s = 0; s < 12; s++) demod.trainOnSyncSymbol(mod.generateSymbol());

  // The single switch point on each side
  mod.setToneOrders(orders);
  demod.setToneOrders(orders);
  return { mod, demod };
}

/** Generic serializer mirroring OFDMEngine.modulateFrame's QAM path. */
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
        out[outIdx++] = acc & 0xff;
        acc = 0;
        count = 0;
        if (outIdx >= expectedByteCount) return out;
      }
    }
  }
  return out;
}

describe('16-tone QAM mod→demod loopback (noise-free, trained)', () => {
  it('all-16QAM: random payload round-trips exactly', () => {
    const orders = new Array(16).fill(4) as QamOrder[];
    const { mod, demod } = makeTrainedPair(orders);
    const payload = new Uint8Array(200);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37 + 11) & 0xff;

    const symbols = serializeToSymbols(payload, orders);
    const perSymbolBits: number[][] = [];
    for (const sym of symbols) {
      mod.setSymbols(sym);
      const tx = mod.generateSymbol();
      const result = demod.demodulate(tx);
      perSymbolBits.push(result.bits);
    }
    const recovered = deserializeBytes(perSymbolBits, payload.length);
    expect(Array.from(recovered)).toEqual(Array.from(payload));
  });
});

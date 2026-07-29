/**
 * constellation.test.ts — Gray-coded QAM mapping/slicing roundtrip, average
 * power normalization, and Gray adjacency (Phase 3 bit-loading, part 1).
 */
import { describe, it, expect } from 'vitest';
import {
  QAM_ORDERS,
  mapSymbol,
  sliceSymbol,
  normalizationScale,
  maxConstellationMagnitude,
  qamMapValueToOrder,
  type QamOrder,
} from '../modulation/constellation';

function popcount(n: number): number {
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}

describe('constellation mapSymbol/sliceSymbol', () => {
  for (const order of QAM_ORDERS) {
    it(`order=${order}: every bit pattern round-trips through mapSymbol -> sliceSymbol`, () => {
      const count = 1 << order;
      for (let bits = 0; bits < count; bits++) {
        const { re, im } = mapSymbol(bits, order);
        const recovered = sliceSymbol(re, im, order);
        expect(recovered).toBe(bits);
      }
    });

    it(`order=${order}: mean constellation power is 1`, () => {
      const count = 1 << order;
      let sumPower = 0;
      for (let bits = 0; bits < count; bits++) {
        const { re, im } = mapSymbol(bits, order);
        sumPower += re * re + im * im;
      }
      const meanPower = sumPower / count;
      expect(meanPower).toBeCloseTo(1, 10);
    });

    it(`order=${order}: sliceSymbol is robust to small perturbation around each point`, () => {
      const count = 1 << order;
      const scale = normalizationScale(order);
      const jitter = scale * 0.3; // well under half the minimum level spacing (2*scale)
      for (let bits = 0; bits < count; bits++) {
        const { re, im } = mapSymbol(bits, order);
        expect(sliceSymbol(re + jitter, im - jitter, order)).toBe(bits);
      }
    });
  }

  it('QPSK and 16-QAM: adjacent constellation points differ by exactly 1 bit (Gray property)', () => {
    for (const order of [2, 4] as QamOrder[]) {
      const scale = normalizationScale(order);
      const step = 2 * scale; // minimum spacing between adjacent ladder levels
      const count = 1 << order;
      const points = new Map<number, { re: number; im: number }>();
      for (let bits = 0; bits < count; bits++) points.set(bits, mapSymbol(bits, order));

      for (const [bitsA, a] of points) {
        for (const [bitsB, b] of points) {
          if (bitsA === bitsB) continue;
          const dRe = Math.round((b.re - a.re) / step);
          const dIm = Math.round((b.im - a.im) / step);
          const isAxisNeighbor =
            (Math.abs(dRe) === 1 && dIm === 0) || (dRe === 0 && Math.abs(dIm) === 1);
          if (isAxisNeighbor) {
            expect(popcount(bitsA ^ bitsB)).toBe(1);
          }
        }
      }
    }
  });

  it('maxConstellationMagnitude grows with order (64-QAM has the largest corner)', () => {
    const mags = QAM_ORDERS.map(maxConstellationMagnitude);
    expect(mags[0]).toBeLessThan(mags[1]);
    expect(mags[1]).toBeLessThan(mags[2]);
  });

  it('qamMapValueToOrder maps profile codes to bits-per-tone', () => {
    expect(qamMapValueToOrder(0)).toBe(2);
    expect(qamMapValueToOrder(1)).toBe(4);
    expect(qamMapValueToOrder(2)).toBe(6);
  });
});

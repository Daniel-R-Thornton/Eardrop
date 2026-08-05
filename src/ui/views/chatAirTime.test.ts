import { describe, expect, it } from 'vitest';
import { textAirSeconds } from './chatAirTime';

describe('textAirSeconds', () => {
  it('estimates a two-character message at about two seconds', () => {
    // The 1.5s preamble dominates a short message: 43 wire bytes is only
    // ~0.55s of symbols. This is why a two-character message is not cheap.
    expect(textAirSeconds('ok')).toBeCloseTo(2.05, 2);
  });

  it('estimates a 140-byte message at about 6.6 seconds', () => {
    expect(textAirSeconds('x'.repeat(140))).toBeCloseTo(6.65, 2);
  });

  it('estimates a maximum-length message at about 10.4 seconds', () => {
    expect(textAirSeconds('x'.repeat(254))).toBeCloseTo(10.45, 2);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // One emoji is 4 bytes, so it costs the same air as 'aaaa'.
    expect(textAirSeconds('🦻')).toBeCloseTo(textAirSeconds('aaaa'), 6);
  });

  it('grows monotonically with length', () => {
    expect(textAirSeconds('x'.repeat(200))).toBeGreaterThan(textAirSeconds('x'.repeat(100)));
  });
});

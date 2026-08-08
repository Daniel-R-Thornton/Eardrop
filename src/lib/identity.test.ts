// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NICKNAME_MAX_BYTES,
  getDeviceId,
  getNickname,
  labelFor,
  rerollDeviceId,
  sanitizeNickname,
  setNickname,
  truncateToBytes,
} from './identity';

beforeEach(() => localStorage.clear());

describe('sanitizeNickname', () => {
  it('lowercases and turns whitespace into a separator', () => {
    // '-' rather than nothing, so "desk pc" does not read as "deskpc".
    expect(sanitizeNickname('Desk PC')).toBe('desk-pc');
  });

  it('drops characters that cannot go in a filename or log line', () => {
    expect(sanitizeNickname('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitizeNickname('a<b>c:d')).toBe('abcd');
  });

  it('collapses runs of separators and trims them from the ends', () => {
    expect(sanitizeNickname('  --desk   pc--  ')).toBe('desk-pc');
  });

  it('returns empty for input with nothing usable left', () => {
    // Callers treat '' as "no nickname", which is a distinct wire case from a
    // name — see the packWelcome tests.
    expect(sanitizeNickname('!!!')).toBe('');
    expect(sanitizeNickname('   ')).toBe('');
  });

  it('caps the result at the byte budget', () => {
    const long = sanitizeNickname('abcdefghijklmnopqrstuvwxyz');
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(NICKNAME_MAX_BYTES);
  });
});

describe('truncateToBytes', () => {
  /**
   * The failure this exists to prevent: cutting the ENCODED bytes mid-sequence
   * yields U+FFFD on decode, so a too-long name would arrive corrupted rather
   * than merely shortened.
   */
  it('never splits a multi-byte character', () => {
    const emoji = '😀😀😀'; // 4 bytes each
    const cut = truncateToBytes(emoji, 6); // room for one, not two
    expect(cut).toBe('😀');
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(6);
    expect(cut).not.toContain('�');
  });

  it('leaves a string that already fits alone', () => {
    expect(truncateToBytes('desk-pc', 12)).toBe('desk-pc');
  });
});

describe('nickname persistence', () => {
  it('round-trips through storage', () => {
    setNickname('Desk PC');
    expect(getNickname()).toBe('desk-pc');
  });

  it('reports no nickname when none was ever set', () => {
    expect(getNickname()).toBe('');
  });

  it('can be cleared', () => {
    setNickname('pixel');
    setNickname('');
    expect(getNickname()).toBe('');
  });
});

describe('labelFor', () => {
  it('prefers the nickname', () => {
    expect(labelFor(0x6a, 'pixel')).toBe('pixel');
  });

  it('falls back to zero-padded hex when there is no name', () => {
    // The label the room has always shown, so an un-named peer looks exactly
    // as it did before nicknames existed.
    expect(labelFor(0x6a)).toBe('6a');
    expect(labelFor(0x06)).toBe('06');
    expect(labelFor(0x6a, '')).toBe('6a');
  });
});

describe('getDeviceId', () => {
  it('is stable across calls — a rejoin keeps the same id', () => {
    const first = getDeviceId(() => 0.5);
    // A different rng: a persisted id must win over a freshly rolled one, else
    // "stable across reconnects" is not actually what this provides.
    expect(getDeviceId(() => 0.9)).toBe(first);
  });

  it('stays inside the 8-bit wire range', () => {
    for (const r of [0, 0.5, 0.999999]) {
      localStorage.clear();
      const id = getDeviceId(() => r);
      expect(id).toBeGreaterThanOrEqual(1);
      expect(id).toBeLessThanOrEqual(255);
    }
  });

  it('ignores a stored value outside the wire range', () => {
    localStorage.setItem('eardrop.deviceId', '999');
    const id = getDeviceId(() => 0.5);
    expect(id).toBeGreaterThanOrEqual(1);
    expect(id).toBeLessThanOrEqual(255);
  });
});

describe('rerollDeviceId', () => {
  it('avoids every id already in use', () => {
    const taken = [1, 2, 3, 4, 5];
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      expect(taken).not.toContain(rerollDeviceId(taken, () => r));
    }
  });

  it('persists the new id so the collision is not re-fought next reload', () => {
    getDeviceId(() => 0); // id 1
    const next = rerollDeviceId([1], () => 0.5);
    expect(next).not.toBe(1);
    expect(getDeviceId(() => 0)).toBe(next);
  });

  it('still returns a valid id when everything is taken', () => {
    const all = Array.from({ length: 255 }, (_, i) => i + 1);
    const id = rerollDeviceId(all, () => 0.5);
    expect(id).toBeGreaterThanOrEqual(1);
    expect(id).toBeLessThanOrEqual(255);
  });
});

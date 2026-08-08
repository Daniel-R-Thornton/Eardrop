import { describe, expect, it } from 'vitest';
import { packWelcome, parseWelcome, type BestRangeClaim } from '../protocol/controlFrame';
import { NICKNAME_MAX_BYTES } from '../../lib/identity';

/**
 * The nickname is appended to the WELCOME payload, after the claim and grid, and
 * omitted entirely when unset. These tests pin the three compatibility
 * properties that made that shape the safe way to extend a live acoustic
 * protocol mid-investigation — if any of them breaks, a build mismatch stops
 * being harmless and starts losing WELCOMEs.
 */

const CLAIM: BestRangeClaim = { lowHz: 2600, highHz: 2950, maxQamOrder: 4 };
const GRID = Array.from({ length: 64 }, (_, i) => 1 - i / 128);

/** Payload size of a WELCOME as it existed before nicknames: claim + grid. */
const LEGACY_BYTES = 35;

describe('WELCOME nickname, on the wire', () => {
  it('is byte-identical to the legacy payload when no nickname is set', () => {
    // The property that makes this free for anyone not using the feature: no
    // extra airtime, and no extra BCH chunks to lose the whole message on.
    const bare = packWelcome({ claim: CLAIM, grid: GRID });
    expect(bare.length).toBe(LEGACY_BYTES);

    expect(packWelcome({ claim: CLAIM, grid: GRID, nickname: '' })).toEqual(bare);
    // A name that sanitizes away to nothing must also not add a length byte.
    expect(packWelcome({ claim: CLAIM, grid: GRID, nickname: '!!!' })).toEqual(bare);
  });

  it('round-trips a nickname', () => {
    const wire = packWelcome({ claim: CLAIM, grid: GRID, nickname: 'desk-pc' });
    expect(wire.length).toBe(LEGACY_BYTES + 1 + 'desk-pc'.length);

    const parsed = parseWelcome(wire);
    expect(parsed?.nickname).toBe('desk-pc');
    expect(parsed?.claim).toEqual(CLAIM);
  });

  it('sanitizes and byte-caps at pack time, not just at the UI', () => {
    // Otherwise an over-long or exotic name reaches the air and the payload
    // stops matching its own declared length.
    const wire = packWelcome({ claim: CLAIM, grid: GRID, nickname: 'Some Really Long Device Name' });
    const name = parseWelcome(wire)?.nickname ?? '';
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(NICKNAME_MAX_BYTES);
    expect(name).toMatch(/^[a-z0-9_-]+$/);
  });

  it('reads a legacy 35-byte payload as simply having no name', () => {
    // New parser, old sender.
    const legacy = packWelcome({ claim: CLAIM, grid: GRID }).slice(0, LEGACY_BYTES);
    const parsed = parseWelcome(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed?.nickname).toBeUndefined();
    expect(parsed?.claim).toEqual(CLAIM);
    expect(parsed?.grid).toHaveLength(64);
  });

  it('leaves the claim and grid intact when the name field is malformed', () => {
    // A cosmetic field must never cost a WELCOME that already passed the
    // payload CRC — the room's band decisions ride on the claim and grid.
    const wire = packWelcome({ claim: CLAIM, grid: GRID, nickname: 'pixel' });
    const lying = wire.slice();
    lying[LEGACY_BYTES] = 200; // declares far more name bytes than are present

    const parsed = parseWelcome(lying);
    expect(parsed).not.toBeNull();
    expect(parsed?.nickname).toBeUndefined();
    expect(parsed?.claim).toEqual(CLAIM);
    expect(parsed?.grid).toHaveLength(64);
  });

  it('still rejects a payload too short to hold the claim and grid', () => {
    expect(parseWelcome(new Uint8Array(LEGACY_BYTES - 1))).toBeNull();
  });
});

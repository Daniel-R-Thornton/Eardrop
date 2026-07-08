/**
 * Tests for BCH(63,30) error correction.
 */
import { describe, it, expect } from "vitest";
import { bch63Encode, bch63Decode } from "./bch63";

describe("BCH(63,30) — Encode/Decode", () => {
  it("should roundtrip clean codeword", () => {
    const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const encoded = bch63Encode(data);
    expect(encoded.length).toBe(8);
    const result = bch63Decode(encoded);
    expect(result.valid).toBe(true);
    expect(result.errors).toBe(0);
    expect([...result.data]).toEqual([...data]);
  });

  it("should handle all-zero data", () => {
    const data = new Uint8Array(4);
    const encoded = bch63Encode(data);
    const result = bch63Decode(encoded);
    expect(result.valid).toBe(true);
    expect(result.errors).toBe(0);
    expect([...result.data]).toEqual([0, 0, 0, 0]);
  });

  it("should correct 1 bit error", () => {
    const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const encoded = bch63Encode(data);
    const corrupted = new Uint8Array(encoded);
    corrupted[4] ^= 0x01; // flip bit 0 of byte 4
    const result = bch63Decode(corrupted);
    expect(result.valid).toBe(true);
    expect(result.errors).toBe(1);
    expect([...result.data]).toEqual([...data]);
  });

  it("should correct 3 bit errors", () => {
    const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const encoded = bch63Encode(data);
    const corrupted = new Uint8Array(encoded);
    corrupted[0] ^= 0x01;
    corrupted[2] ^= 0x10;
    corrupted[5] ^= 0x20;
    const result = bch63Decode(corrupted);
    expect(result.valid).toBe(true);
    expect(result.errors).toBe(3);
    expect([...result.data]).toEqual([...data]);
  });

  it("should correct 6 bit errors (max)", () => {
    const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const encoded = bch63Encode(data);
    const corrupted = new Uint8Array(encoded);
    for (let i = 0; i < 6; i++) {
      corrupted[Math.floor(i * 1.5)] ^= (1 << ((i * 3) % 8));
    }
    const result = bch63Decode(corrupted);
    expect(result.valid).toBe(true);
    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect([...result.data]).toEqual([...data]);
  });

  it("should report uncorrectable for >6 errors", () => {
    const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const encoded = bch63Encode(data);
    const corrupted = new Uint8Array(encoded);
    corrupted[0] = 0xFF;
    corrupted[1] = 0xFF;
    const result = bch63Decode(corrupted);
    expect(result.valid).toBe(false);
    expect(result.errors).toBe(-1);
  });

  it("should be deterministic", () => {
    const data = new Uint8Array([0xAB, 0xCD, 0xEF, 0x01]);
    const a = bch63Encode(data);
    const b = bch63Encode(data);
    expect(a).toEqual(b);
  });
});

/**
 * src/lib/crc/index.ts
 *
 * CRC error detection utilities.
 * - CRC-32 (IEEE 802.3) for file integrity
 * - CRC-16 for frame validation (if needed)
 */

/**
 * CRC-32 (IEEE 802.3) using table-based lookup.
 * Used for file payload integrity verification.
 */
export class CRC32 {
  private static table: Uint32Array | null = null;

  private static buildTable(): Uint32Array {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[i] = c;
    }
    return t;
  }

  /**
   * Compute CRC-32 of data.
   * Polynomial: 0x04C11DB7 (IEEE 802.3).
   * @param data - Input bytes
   * @returns CRC-32 value (unsigned 32-bit)
   */
  static compute(data: Uint8Array): number {
    if (!this.table) this.table = this.buildTable();
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      c = this.table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /**
   * Verify CRC-32 of data against an expected value.
   */
  static verify(data: Uint8Array, expectedCrc: number): boolean {
    return this.compute(data) === expectedCrc;
  }
}

/**
 * Backward-compatible function wrapper for existing code.
 * @deprecated Use CRC32.compute() instead.
 */
export function crc32(data: Uint8Array): number {
  return CRC32.compute(data);
}

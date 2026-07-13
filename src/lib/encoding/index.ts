/**
 * src/lib/encoding/index.ts
 *
 * Bit and byte packing utilities.
 * - BitWriter and BitReader for safe bit-level manipulation
 * - Little-endian pack/unpack helpers
 */

/**
 * Safe bit writer for building byte streams bit-by-bit.
 */
export class BitWriter {
  private bytes: number[] = [];
  private currentByte: number = 0;
  private bitPosition: number = 0; // 0-7, where 0 is LSB

  /**
   * Write a single bit (0 or 1).
   */
  writeBit(bit: number): void {
    if (bit !== 0 && bit !== 1) {
      throw new Error(`Invalid bit: ${bit}. Must be 0 or 1.`);
    }
    if (bit) {
      this.currentByte |= 1 << this.bitPosition;
    }
    this.bitPosition++;
    if (this.bitPosition === 8) {
      this.bytes.push(this.currentByte);
      this.currentByte = 0;
      this.bitPosition = 0;
    }
  }

  /**
   * Write multiple bits from an integer.
   * @param value - The value to write
   * @param numBits - Number of bits to write (1-32)
   */
  writeBits(value: number, numBits: number): void {
    if (numBits < 1 || numBits > 32) {
      throw new Error(`numBits must be between 1 and 32, got ${numBits}`);
    }
    for (let i = 0; i < numBits; i++) {
      this.writeBit((value >> i) & 1);
    }
  }

  /**
   * Write a complete byte.
   */
  writeByte(byte: number): void {
    this.writeBits(byte, 8);
  }

  /**
   * Write an array of bytes.
   */
  writeBytes(bytes: Uint8Array): void {
    for (const element of bytes) {
      this.writeByte(element);
    }
  }

  /**
   * Finish writing and return the constructed byte array.
   * Pads the last byte with zeros if it's incomplete.
   */
  toBytes(): Uint8Array {
    const result = new Uint8Array(this.bitPosition > 0 ? this.bytes.length + 1 : this.bytes.length);
    for (let i = 0; i < this.bytes.length; i++) {
      result[i] = this.bytes[i];
    }
    if (this.bitPosition > 0) {
      result[this.bytes.length] = this.currentByte;
    }
    return result;
  }

  /**
   * Reset writer state.
   */
  reset(): void {
    this.bytes = [];
    this.currentByte = 0;
    this.bitPosition = 0;
  }
}

/**
 * Safe bit reader for extracting bits from byte streams.
 */
export class BitReader {
  private readonly bytes: Uint8Array;
  private byteIndex: number = 0;
  private bitPosition: number = 0; // 0-7

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /**
   * Read a single bit.
   * Returns 0 or 1. Throws if at end of data.
   */
  readBit(): number {
    if (this.byteIndex >= this.bytes.length) {
      throw new Error('BitReader: end of data');
    }
    const bit = (this.bytes[this.byteIndex] >> this.bitPosition) & 1;
    this.bitPosition++;
    if (this.bitPosition === 8) {
      this.byteIndex++;
      this.bitPosition = 0;
    }
    return bit;
  }

  /**
   * Read multiple bits as an unsigned integer.
   */
  readBits(numBits: number): number {
    if (numBits < 1 || numBits > 32) {
      throw new Error(`numBits must be between 1 and 32, got ${numBits}`);
    }
    let value = 0;
    for (let i = 0; i < numBits; i++) {
      value |= this.readBit() << i;
    }
    return value;
  }

  /**
   * Read a complete byte.
   */
  readByte(): number {
    return this.readBits(8);
  }

  /**
   * Read an array of bytes.
   */
  readBytes(count: number): Uint8Array {
    const result = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      result[i] = this.readByte();
    }
    return result;
  }

  /**
   * Check if there is more data to read.
   */
  hasMore(): boolean {
    return this.byteIndex < this.bytes.length || this.bitPosition < 8;
  }

  /**
   * Get current position (byte index, bit position).
   */
  position(): { byteIndex: number; bitPosition: number } {
    return { byteIndex: this.byteIndex, bitPosition: this.bitPosition };
  }
}

/**
 * Pack little-endian integer into bytes.
 * @param value - The value to pack
 * @param numBytes - Number of bytes to write (1-4)
 * @returns Packed bytes
 */
export function littleEndianPack(value: number, numBytes: number): Uint8Array {
  if (numBytes < 1 || numBytes > 4) {
    throw new Error(`numBytes must be 1-4, got ${numBytes}`);
  }
  const bytes = new Uint8Array(numBytes);
  for (let i = 0; i < numBytes; i++) {
    bytes[i] = (value >> (i * 8)) & 0xff;
  }
  return bytes;
}

/**
 * Unpack little-endian bytes into an integer.
 * @param bytes - Input bytes
 * @param offset - Starting offset
 * @param numBytes - Number of bytes to read
 * @returns Unpacked integer
 */
export function littleEndianUnpack(bytes: Uint8Array, offset: number, numBytes: number): number {
  if (numBytes < 1 || numBytes > 4) {
    throw new Error(`numBytes must be 1-4, got ${numBytes}`);
  }
  let value = 0;
  for (let i = 0; i < numBytes; i++) {
    value |= bytes[offset + i] << (i * 8);
  }
  return value >>> 0; // Unsigned
}

/**
 * Pack bytes into big-endian (network byte order).
 */
export function bigEndianPack(value: number, numBytes: number): Uint8Array {
  if (numBytes < 1 || numBytes > 4) {
    throw new Error(`numBytes must be 1-4, got ${numBytes}`);
  }
  const bytes = new Uint8Array(numBytes);
  for (let i = 0; i < numBytes; i++) {
    bytes[numBytes - 1 - i] = (value >> (i * 8)) & 0xff;
  }
  return bytes;
}

/**
 * Unpack big-endian bytes into an integer.
 */
export function bigEndianUnpack(bytes: Uint8Array, offset: number, numBytes: number): number {
  if (numBytes < 1 || numBytes > 4) {
    throw new Error(`numBytes must be 1-4, got ${numBytes}`);
  }
  let value = 0;
  for (let i = 0; i < numBytes; i++) {
    value = (value << 8) | bytes[offset + i];
  }
  return value >>> 0;
}

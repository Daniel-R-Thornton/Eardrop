/**
 * src/lib/ecc/index.ts
 *
 * Error correction code abstraction layer.
 * Defines encoder/decoder interfaces for pluggable ECC schemes.
 * Actual implementations (BCH, Reed-Solomon) are in src/modem/ecc.ts, bch63.ts, reedsolomon.ts
 */

/**
 * Generic ECC encoder interface.
 */
export interface ECCEncoder {
  /**
   * Encode data with redundancy.
   * @param data - Original data bytes
   * @returns Encoded data (original + redundancy)
   */
  encode(data: Uint8Array): Uint8Array;

  /**
   * Get the encoded length for a given data length.
   */
  getEncodedLength(dataLength: number): number;
}

/**
 * Generic ECC decoder interface.
 */
export interface ECCDecoder {
  /**
   * Decode and possibly correct data.
   * @param encoded - Encoded data (may have errors)
   * @returns { data, correctionCount, success }
   */
  decode(encoded: Uint8Array): {
    data: Uint8Array;
    correctionCount: number;
    success: boolean;
  };

  /**
   * Get the original data length for a given encoded length.
   */
  getDataLength(encodedLength: number): number;

  /**
   * Get the maximum number of correctable bit errors.
   */
  getMaxCorrections(): number;
}

/**
 * Factory for creating BCH(31,16) encoder/decoder.
 * Delegates to src/modem/bch63.ts.
 *
 * @returns { encoder, decoder }
 */
export function createBCH31x(): {
  encoder: ECCEncoder;
  decoder: ECCDecoder;
  } {
  // Stub; actual implementation delegates to modem layer
  throw new Error('createBCH31x() not yet implemented. Use bch3116Encode/Decode from modem.');
}

/**
 * Factory for creating Reed-Solomon encoder/decoder.
 * @param nsym - Number of parity symbols
 * @returns { encoder, decoder }
 */
export function createReedSolomon(nsym: number): {
  encoder: ECCEncoder;
  decoder: ECCDecoder;
} {
  // Stub; actual implementation delegates to modem layer
  throw new Error('createReedSolomon() not yet implemented. Use Reed-Solomon from modem.');
}

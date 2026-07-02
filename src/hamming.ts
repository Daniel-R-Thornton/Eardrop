/**
 * Hamming(7,4) systematic encoder/decoder.
 *
 * Encodes 4 data bits into 8 bits (7-bit codeword + 1 pad bit)
 * so each nibble fits exactly into two 4-tone modem symbols.
 *
 * Codeword layout: p0 p1 d0 p2 d1 d2 d3 0
 *   p0 = d0 ⊕ d1 ⊕ d3
 *   p1 = d0 ⊕ d2 ⊕ d3
 *   p2 = d1 ⊕ d2 ⊕ d3
 *
 * Syndrome = s0 + 2·s1 + 4·s2 gives the bit position to flip (1-indexed).
 * Syndrome 0 = no error.
 */

/** Encode a 4-bit nibble into 8 bits (7 Hamming + 1 pad) */
export function hammingEncode(nibble: number): number {
  const d0 = (nibble >> 3) & 1;
  const d1 = (nibble >> 2) & 1;
  const d2 = (nibble >> 1) & 1;
  const d3 = (nibble >> 0) & 1;

  const p0 = d0 ^ d1 ^ d3;
  const p1 = d0 ^ d2 ^ d3;
  const p2 = d1 ^ d2 ^ d3;

  // Pack: p0(bit7) p1(bit6) d0(bit5) p2(bit4) d1(bit3) d2(bit2) d3(bit1) 0(bit0)
  let out = 0;
  out |= (p0 << 7);
  out |= (p1 << 6);
  out |= (d0 << 5);
  out |= (p2 << 4);
  out |= (d1 << 3);
  out |= (d2 << 2);
  out |= (d3 << 1);
  // bit 0 is pad (always 0)
  return out;
}

/** Decode 8-bit Hamming(7,4) word, correct 1-bit error, return 4-bit nibble */
export function hammingDecode(byte: number): number {
  // Extract bits (ignore pad bit 0)
  const p0 = (byte >> 7) & 1;
  const p1 = (byte >> 6) & 1;
  const d0 = (byte >> 5) & 1;
  const p2 = (byte >> 4) & 1;
  const d1 = (byte >> 3) & 1;
  const d2 = (byte >> 2) & 1;
  const d3 = (byte >> 1) & 1;

  const s0 = p0 ^ d0 ^ d1 ^ d3;
  const s1 = p1 ^ d0 ^ d2 ^ d3;
  const s2 = p2 ^ d1 ^ d2 ^ d3;
  const syndrome = s0 + (s1 << 1) + (s2 << 2);

  // Rebuild the 7-bit word: positions 1-7
  const word = [
    0,        // pos 0 unused
    p0,       // pos 1
    p1,       // pos 2
    d0,       // pos 3
    p2,       // pos 4
    d1,       // pos 5
    d2,       // pos 6
    d3,       // pos 7
  ];

  if (syndrome !== 0 && syndrome <= 7) {
    word[syndrome] ^= 1; // flip the erroneous bit
  }

  // Re-extract data bits after correction
  const corrD0 = word[3];
  const corrD1 = word[5];
  const corrD2 = word[6];
  const corrD3 = word[7];

  return (corrD0 << 3) | (corrD1 << 2) | (corrD2 << 1) | corrD3;
}

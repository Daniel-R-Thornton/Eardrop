/**
 * ecc.ts — BCH(31,16) encoder/decoder + block interleaver.
 *
 * BCH(31,16) over GF(2^5) with primitive polynomial x^5 + x^2 + 1 (0x25).
 *   - 16 data bits + 15 parity bits = 31-bit codeword
 *   - Corrects up to 3 bit errors per codeword
 *   - Rate: 16/31 ≈ 0.516
 *
 * GF(2^5) representation:
 *   α = primitive element, α^5 + α^2 + 1 = 0
 *   Elements are 5-bit values (0-31)
 *   Precomputed lookup tables for gf_add, gf_mul, gf_pow, gf_log
 */

import { debugLogger, STAGE, LOG_LEVEL } from "./debugger";

// ─── GF(2^5) Arithmetic ──────────────────────────────

const GF_SIZE = 32;
const GF_PRIMITIVE = 0x25; // x^5 + x^2 + 1

// Precomputed tables
let gfLog: Int8Array | null = null;
let gfExp: Int8Array | null = null;
let gfMul: Int8Array[] | null = null;

function ensureGfTables(): void {
  if (gfLog) return;

  gfLog = new Int8Array(GF_SIZE);
  gfExp = new Int8Array(GF_SIZE);

  // Build exp/log tables
  let v = 1;
  for (let i = 0; i < GF_SIZE - 1; i++) {
    gfExp[i] = v;
    gfLog[v] = i;
    v <<= 1;
    if (v & GF_SIZE) v ^= GF_PRIMITIVE;
    v &= GF_SIZE - 1;
  }
  gfExp[31] = gfExp[0]; // α^31 = α^0 = 1
  gfLog[0] = -1; // log(0) is undefined

  // Build multiplication table
  gfMul = new Array(GF_SIZE);
  for (let i = 0; i < GF_SIZE; i++) {
    gfMul[i] = new Int8Array(GF_SIZE);
    for (let j = 0; j < GF_SIZE; j++) {
      if (i === 0 || j === 0) {
        gfMul[i][j] = 0;
      } else {
        gfMul[i][j] = gfExp[(gfLog[i] + gfLog[j]) % (GF_SIZE - 1)];
      }
    }
  }
}

function gfAdd(a: number, b: number): number {
  return a ^ b;
}

function gfMulVal(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  if (!gfLog || !gfExp) ensureGfTables();
  return gfExp![(gfLog![a] + gfLog![b]) % (GF_SIZE - 1)];
}

function gfInv(a: number): number {
  if (a === 0) return 0;
  if (!gfLog || !gfExp) ensureGfTables();
  return gfExp![(GF_SIZE - 1 - gfLog![a]) % (GF_SIZE - 1)];
}

// ─── Precomputed Generator Polynomial Coefficients ───

// BCH(31,16) generator polynomial: g(x) = m₁(x) · m₃(x) · m₅(x)
// where m_i(x) is the minimal polynomial of αⁱ over GF(2).
// Degree = 15 (binary coefficients), roots: α¹, α², α³, α⁴, α⁵, α⁶
//
// Cyclotomic cosets:
//   C₁ = {1, 2, 4, 8, 16}  → m₁(x)
//   C₃ = {3, 6, 12, 24, 17} → m₃(x)
//   C₅ = {5, 10, 20, 9, 18} → m₅(x)
const GENERATOR: number[] = (() => {
  ensureGfTables();

  // Build a minimal polynomial from its set of conjugate roots.
  // Returns binary coefficients (0 or 1) indexed by power of x.
  function minPoly(roots: number[]): number[] {
    // Start with polynomial = 1
    let p = [1];
    for (const r of roots) {
      const a = gfExp![r % (GF_SIZE - 1)];
      const next = new Array(p.length + 1).fill(0);
      for (let j = 0; j < p.length; j++) {
        // Multiply by (x + a): shift + scale
        next[j + 1] ^= p[j];
        next[j] ^= gfMulVal(p[j], a);
      }
      p = next;
    }
    // Minimal polynomial over GF(2) has binary coefficients;
    // the full GF(2⁵) product naturally yields 0/1 values.
    // Mask as a safety measure.
    return p.map(c => c & 1);
  }

  // Binary polynomial multiplication
  function mulPoly(a: number[], b: number[]): number[] {
    const r = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        r[i + j] ^= (a[i] & b[j]);
      }
    }
    return r;
  }

  const m1 = minPoly([1, 2, 4, 8, 16]);
  const m3 = minPoly([3, 6, 12, 24, 17]);
  const m5 = minPoly([5, 10, 20, 9, 18]);

  return mulPoly(mulPoly(m1, m3), m5);
})();

// ─── Syndrome Calculation ────────────────────────────

function calculateSyndrome(codeword: number[]): number[] {
  ensureGfTables();
  const syndrome = new Array(6).fill(0); // 2t = 6 syndromes
  for (let i = 0; i < 6; i++) {
    const alpha = gfExp![(i + 1) % (GF_SIZE - 1)];
    let s = 0;
    // Horner's method for polynomial evaluation
    for (let j = codeword.length - 1; j >= 0; j--) {
      s = gfAdd(codeword[j], gfMulVal(s, alpha));
    }
    syndrome[i] = s;
  }
  return syndrome;
}

// ─── Berlekamp-Massey to find error locator polynomial ──

function berlekampMassey(syndrome: number[], t: number): number[] {
  // Returns coefficients of error locator polynomial Λ(x)
  // Λ(x) = 1 + Λ₁x + Λ₂x² + ... + Λₜxᵗ
  const n = syndrome.length;
  let C = new Array(n + 1).fill(0);
  let B = new Array(n + 1).fill(0);
  C[0] = 1;
  B[0] = 1;
  let L = 0;
  let m = 1;
  let b = 1;

  for (let r = 0; r < n; r++) {
    // Compute discrepancy d = Σ C[i] * syndrome[r-i]
    let d = 0;
    for (let i = 0; i <= L; i++) {
      if (i <= r) {
        d = gfAdd(d, gfMulVal(C[i], syndrome[r - i]));
      }
    }

    if (d !== 0) {
      // C = C - d/b * x^m * B
      const scale = gfMulVal(d, gfInv(b));
      const newC = [...C];
      for (let i = 0; i < B.length; i++) {
        const idx = i + m;
        if (idx < newC.length) {
          newC[idx] = gfAdd(newC[idx], gfMulVal(scale, B[i]));
        } else {
          newC.push(gfMulVal(scale, B[i]));
        }
      }

      if (2 * L <= r) {
        B = C.map(c => c);
        b = d;
        L = r + 1 - L;
        m = 1;
      } else {
        m++;
      }

      C = newC;
    } else {
      m++;
    }
  }

  // Trim trailing zeros
  while (C.length > 0 && C[C.length - 1] === 0) C.pop();
  return C;
}

// ─── Find roots of error locator polynomial (Chien search) ──

function chienSearch(lambda: number[]): number[] {
  // Returns positions of errors (0-indexed from LSB of codeword)
  ensureGfTables();
  const errors: number[] = [];
  const n = 31; // codeword length

  for (let i = 0; i < n; i++) {
    // Evaluate Λ(α^i)
    const alpha = gfExp![(i * 1) % (GF_SIZE - 1)];
    let val = 0;
    let pow = 1;
    for (let j = 0; j < lambda.length; j++) {
      val = gfAdd(val, gfMulVal(lambda[j], pow));
      pow = gfMulVal(pow, alpha);
    }
    if (val === 0) {
      // Λ(αⁱ) = 0  ⇒  αⁱ = α^(-pos)  ⇒  pos = (n - i) mod n
      errors.push((n - i) % n);
    }
  }

  return errors;
}

// ─── Correct Errors ──────────────────────────────────

function correctErrors(codeword: number[], errorPositions: number[]): number[] {
  const corrected = [...codeword];
  for (const pos of errorPositions) {
    if (pos >= 0 && pos < corrected.length) {
      corrected[pos] ^= 1; // flip bit
    }
  }
  return corrected;
}

// ─── Public API ──────────────────────────────────────

export interface BchResult {
  /** Decoded data bytes */
  data: Uint8Array;
  /** Total number of corrected bit errors */
  errors: number;
  /** Number of codewords that had 1-3 errors corrected */
  correctedCodewords: number;
  /** Number of codewords with >3 errors (uncorrectable) */
  uncorrectableCodewords: number;
  /** Total codewords processed */
  totalCodewords: number;
}

/**
 * BCH(31,16) encode: 16-bit input → 31-bit codeword.
 * Returns 31 bits packed into a Uint8Array (4 bytes, MSB-aligned).
 */
function encodeCodeword(input16: number): Uint8Array {
  ensureGfTables();

  // Systematic encoding: data bits in high 16 positions, parity in low 15
  // Represent codeword as array of 31 coefficients (index 0 = x^0 = LSB)
  const codeword = new Array(31).fill(0);

  // Set data bits (positions 15-30)
  for (let i = 0; i < 16; i++) {
    codeword[30 - i] = (input16 >> i) & 1;
  }

  // Compute parity: remainder of x^15 * m(x) / g(x)
  // g(x) has binary coefficients, GENERATOR[i] = coefficient of xⁱ
  // Synthetic (binary) polynomial long division over a 31-bit workspace
  const work = [...codeword]; // 31 elements, indices 0..30 = x⁰..x³⁰
  for (let i = 30; i >= 15; i--) {
    if (work[i] !== 0) {
      // Subtract g(x) · x^(i-15)  ⟹  XOR generator coefficients starting at (i-15)
      for (let j = 0; j < GENERATOR.length; j++) {
        if (GENERATOR[j]) {
          work[i - 15 + j] ^= 1;
        }
      }
    }
  }

  // work[0..14] now holds the remainder → place in low 15 codeword positions
  for (let i = 0; i < 15; i++) {
    codeword[i] = work[i];
  }

  // Pack into 4 bytes (31 bits MSB-aligned in 4 bytes = 32 bits, discard bit 31)
  const result = new Uint8Array(4);
  for (let i = 0; i < 31; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    if (codeword[i]) result[byteIdx] |= (1 << bitIdx);
  }
  return result;
}

/**
 * Decode a BCH(31,16) codeword, correct up to 3 errors.
 * Input: 4 bytes (31 bits MSB-aligned).
 * Returns 2 bytes (16 data bits).
 */
function decodeCodeword(encoded4: Uint8Array): { data: number; errors: number } {
  // Extract 31-bit codeword from 4 bytes
  const codeword = new Array(31).fill(0);
  for (let i = 0; i < 31; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    codeword[i] = (encoded4[byteIdx] >> bitIdx) & 1;
  }

  // Calculate syndromes
  const syndrome = calculateSyndrome(codeword);

  // Check if any syndrome is non-zero
  const hasError = syndrome.some(s => s !== 0);
  if (!hasError) {
    // No errors: extract data bits (positions 15-30)
    let data = 0;
    for (let i = 0; i < 16; i++) {
      if (codeword[30 - i]) data |= (1 << i);
    }
    return { data, errors: 0 };
  }

  // Find error locations using Berlekamp-Massey
  const lambda = berlekampMassey(syndrome, 3);
  const errorPositions = chienSearch(lambda);

  // Count errors found
  const foundErrors = errorPositions.length;

  if (foundErrors > 0 && foundErrors <= 3) {
    // Correct errors
    const corrected = correctErrors(codeword, errorPositions);

    // Extract data bits
    let data = 0;
    for (let i = 0; i < 16; i++) {
      if (corrected[30 - i]) data |= (1 << i);
    }
    return { data, errors: foundErrors };
  }

  // No valid error pattern found or too many errors — uncorrectable
  let data = 0;
  for (let i = 0; i < 16; i++) {
    if (codeword[30 - i]) data |= (1 << i);
  }
  // Use -1 for uncorrectable (syndrome ≠ 0 but no valid ≤3-error pattern)
  return { data, errors: -1 };
}

// ─── Block-Level API ─────────────────────────────────

/**
 * BCH(31,16) encode a byte array.
 * Each 2 bytes of input → 4 bytes of encoded output.
 * Padded with zeros if input length is odd.
 */
export function bch3116Encode(data: Uint8Array): Uint8Array {
  const paddedLen = data.length % 2 === 0 ? data.length : data.length + 1;
  const padded = new Uint8Array(paddedLen);
  padded.set(data);

  const numCodewords = paddedLen / 2;
  const output = new Uint8Array(numCodewords * 4);

  for (let i = 0; i < numCodewords; i++) {
    const input16 = (padded[i * 2] << 8) | padded[i * 2 + 1];
    const encoded = encodeCodeword(input16);
    output.set(encoded, i * 4);
  }

  return output;
}

/**
 * BCH(31,16) decode a byte array.
 * Returns decoded data + error statistics.
 */
export function bch3116Decode(encoded: Uint8Array): BchResult {
  const numCodewords = Math.floor(encoded.length / 4);
  const output = new Uint8Array(numCodewords * 2);
  let totalErrors = 0;
  let correctedCodewords = 0;
  let uncorrectableCodewords = 0;

  for (let i = 0; i < numCodewords; i++) {
    const chunk = encoded.slice(i * 4, i * 4 + 4);
    if (chunk.length < 4) break;

    const result = decodeCodeword(chunk);
    const absErrors = Math.abs(result.errors);

    output[i * 2] = (result.data >> 8) & 0xFF;
    output[i * 2 + 1] = result.data & 0xFF;

    if (result.errors > 0) {
      totalErrors += result.errors;
      correctedCodewords++;
    } else if (result.errors < 0) {
      totalErrors += absErrors;
      uncorrectableCodewords++;
    }
  }

  // Log to debugger
  debugLogger.info(STAGE.ECC_DECODE, {
    codewords: numCodewords,
    syndrome_fix: correctedCodewords,
    syndrome_rate: numCodewords > 0 ? (correctedCodewords / numCodewords) : 0,
    double_err: uncorrectableCodewords,
    double_err_rate: numCodewords > 0 ? (uncorrectableCodewords / numCodewords) : 0,
    total_errors: totalErrors,
  }, `BCH: ${correctedCodewords}/${numCodewords} fixed, ${uncorrectableCodewords} uncorrectable`);

  return {
    data: output,
    errors: totalErrors,
    correctedCodewords,
    uncorrectableCodewords,
    totalCodewords: numCodewords,
  };
}

// ─── Block Interleaver / Deinterleaver ───────────────

/**
 * Block interleave: reorder bytes to spread burst errors across codewords.
 * Writes data row-by-row into a matrix, reads column-by-column.
 */
export function interleave(data: Uint8Array, depth: number): Uint8Array {
  if (depth <= 1) return data;

  const cols = Math.ceil(data.length / depth);
  const output = new Uint8Array(data.length);
  let outIdx = 0;

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < depth; r++) {
      const idx = r * cols + c;
      if (idx < data.length) {
        output[outIdx++] = data[idx];
      }
    }
  }

  return output;
}

/**
 * Block deinterleave: reverse of interleave.
 */
export function deinterleave(data: Uint8Array, depth: number): Uint8Array {
  if (depth <= 1) return data;

  const cols = Math.ceil(data.length / depth);
  const output = new Uint8Array(data.length);
  let inIdx = 0;

  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < depth; r++) {
      const idx = r * cols + c;
      if (idx < data.length) {
        output[idx] = data[inIdx++];
      }
    }
  }

  return output;
}

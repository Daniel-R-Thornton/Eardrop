/**
 * bch63.ts — BCH(63,30) encoder/decoder over GF(2^6).
 *
 * Primitive polynomial: x^6 + x + 1 (0x43)
 * Codeword length: 63 bits (8 bytes, 1 padding bit)
 * Data: 30 bits (4 bytes, 2 padding high bits)
 * Parity: 33 bits
 * Corrects up to t=6 bit errors (designed distance d >= 13)
 * Generator: g(x) = m₁(x)·m₃(x)·m₅(x)·m₇(x)·m₉(x)·m₁₁(x), degree 33
 *
 * Interface takes 4 input bytes (32 bits, top 2 must be 0) and
 * produces 8 output bytes (63 bits MSB-aligned, bit 0 unused/padding).
 */

// ─── GF(2^6) Arithmetic ──────────────────────────────

const GF = 64;
const PRIMITIVE = 0x43; // x^6 + x + 1

let gfLog: Int8Array | null = null;
let gfExp: Int8Array | null = null;

function ensureTables(): void {
  if (gfLog) return;
  gfLog = new Int8Array(GF);
  gfExp = new Int8Array(GF * 2);

  let v = 1;
  for (let i = 0; i < GF - 1; i++) {
    gfExp[i] = v;
    gfLog[v] = i;
    v = (v << 1);
    if (v & GF) v ^= PRIMITIVE;
    v &= GF - 1;
  }
  gfExp[GF - 1] = gfExp[0];
  gfLog[0] = -1;
  for (let i = GF; i < GF * 2; i++) {
    gfExp[i] = gfExp[i - (GF - 1)];
  }
}

function gfAdd(a: number, b: number): number { return a ^ b; }

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  if (!gfLog || !gfExp) ensureTables();
  return gfExp![(gfLog![a] + gfLog![b]) % (GF - 1)];
}

function gfInv(a: number): number {
  if (a === 0) return 0;
  if (!gfLog || !gfExp) ensureTables();
  return gfExp![(GF - 1 - gfLog![a]) % (GF - 1)];
}

function gfPow(a: number, n: number): number {
  if (a === 0) return 0;
  if (!gfLog || !gfExp) ensureTables();
  return gfExp![(gfLog![a] * (n % (GF - 1))) % (GF - 1)];
}

// ─── Generator Polynomial ────────────────────────────

// Cyclotomic cosets for GF(64): find minimal polynomials
function computeGenerator(): number[] {
  ensureTables();
  const seen = new Set<number>();
  const cosets: number[][] = [];

  for (let i = 1; i <= 12; i++) {
    if (seen.has(i)) continue;
    const coset: number[] = [];
    let cur = i;
    while (!seen.has(cur)) {
      seen.add(cur);
      coset.push(cur);
      cur = (cur * 2) % (GF - 1);
    }
    cosets.push(coset);
  }

  // Minimal polynomial from a coset: ∏ (x - α^r) for r in coset
  function minPoly(roots: number[]): number[] {
    // Returns binary coefficients (0 or 1) of the minimal polynomial
    let p = [1];
    for (const r of roots) {
      const a = gfExp![r % (GF - 1)];
      const next = new Array(p.length + 1).fill(0);
      for (let j = 0; j < p.length; j++) {
        next[j] ^= gfMul(p[j], a);
        next[j + 1] ^= p[j];
      }
      p = next;
    }
    // Coefficients must be 0 or 1 for binary minimal polynomials
    return p.map(c => c & 1);
  }

  // Multiply binary polynomials
  function mulPoly(a: number[], b: number[]): number[] {
    const r = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        r[i + j] ^= (a[i] & b[j]);
      }
    }
    return r;
  }

  let g: number[] = [1];
  for (const coset of cosets) {
    const mp = minPoly(coset);
    g = mulPoly(g, mp);
  }

  return g;
}

const GENERATOR = computeGenerator();
const GENERATOR_DEGREE = GENERATOR.length - 1; // should be 33

const N = 63;
const K = N - GENERATOR_DEGREE; // data bits, should be 30
const T = 6; // corrects up to 6 errors
const SYNDROMES = 12; // 2t = 12

// ─── Syndrome Calculation ────────────────────────────

function calculateSyndrome(bits: number[]): number[] {
  ensureTables();
  const syndrome = new Array(SYNDROMES).fill(0);
  for (let j = 0; j < SYNDROMES; j++) {
    const alpha = gfExp![(j + 1) % (GF - 1)];
    let s = 0;
    // Horner from highest degree
    for (let i = N - 1; i >= 0; i--) {
      s = gfAdd(bits[i], gfMul(s, alpha));
    }
    syndrome[j] = s;
  }
  return syndrome;
}

// ─── Berlekamp-Massey ────────────────────────────────

function berlekampMassey(syndrome: number[]): number[] {
  ensureTables();
  const n = syndrome.length;
  let C: number[] = [1];
  let B: number[] = [1];
  let L = 0;
  let m = 1;
  let b = 1;

  for (let r = 0; r < n; r++) {
    let d = 0;
    for (let i = 0; i <= L; i++) {
      if (i <= r) {
        d = gfAdd(d, gfMul(C[i], syndrome[r - i]));
      }
    }

    if (d !== 0) {
      const scale = gfMul(d, gfInv(b));
      const newC = [...C];
      for (let i = 0; i < B.length; i++) {
        const idx = i + m;
        if (idx < newC.length) {
          newC[idx] = gfAdd(newC[idx], gfMul(scale, B[i]));
        } else {
          const entry = gfMul(scale, B[i]);
          if (entry !== 0) newC.push(entry);
        }
      }
      while (newC.length <= L) newC.push(0);

      if (2 * L <= r) {
        B = [...C];
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

  while (C.length > 0 && C[C.length - 1] === 0) C.pop();
  return C;
}

// ─── Chien Search ────────────────────────────────────

function chienSearch(lambda: number[]): number[] {
  ensureTables();
  const errors: number[] = [];
  for (let i = 0; i < N; i++) {
    const alpha = gfExp![(i * 1) % (GF - 1)];
    let val = 0;
    let pow = 1;
    for (let j = 0; j < lambda.length; j++) {
      val = gfAdd(val, gfMul(lambda[j], pow));
      pow = gfMul(pow, alpha);
    }
    if (val === 0) {
      // Λ(α^i) = 0 → error at position (N - i) % N
      errors.push((N - i) % N);
    }
  }
  return errors;
}

function correctErrors(bits: number[], errorPositions: number[]): number[] {
  const corrected = [...bits];
  for (const pos of errorPositions) {
    if (pos >= 0 && pos < corrected.length) {
      corrected[pos] ^= 1;
    }
  }
  return corrected;
}

// ─── Public API: Encode ──────────────────────────────

/**
 * BCH(63,30) encode: 30 data bits → 63-bit codeword.
 * Input: 4 bytes (32 bits, top 2 bits of byte 0 must be 0).
 * Output: 8 bytes (63 bits MSB-aligned, bit 63 unused).
 */
export function bch63Encode(data: Uint8Array): Uint8Array {
  ensureTables();

  // Extract 30 data bits from 4 bytes (top 2 bits of byte 0 are padding)
  const bits = new Array(N).fill(0);
  const dataBits = Math.min(K, data.length * 8);
  for (let i = 0; i < dataBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    // Place data at top K positions: bits[N-1] = MSB, bits[N-K] = LSB
    bits[N - 1 - i] = (data[byteIdx] >> bitIdx) & 1;
  }

  // Systematic encoding: compute parity via polynomial division
  const work = [...bits];
  for (let i = N - 1; i >= N - K; i--) {
    if (work[i] !== 0) {
      for (let j = 0; j < GENERATOR.length; j++) {
        if (GENERATOR[j]) {
          work[i - (N - K) + j] ^= 1;
        }
      }
    }
  }

  // work[0..N-K-1] = parity, bits[N-K..N-1] = data
  for (let i = 0; i < N - K; i++) {
    bits[i] = work[i];
  }

  // Pack into 8 bytes (63 bits = 7.875 bytes → 8 bytes with 1 padding bit)
  const result = new Uint8Array(8);
  for (let i = 0; i < N; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    if (bits[i]) result[byteIdx] |= (1 << bitIdx);
  }
  return result;
}

// ─── Public API: Decode ──────────────────────────────

export interface Bch63Result {
  data: Uint8Array;  // 4 decoded bytes (top 2 bits of byte 0 are padding)
  errors: number;    // corrected errors (-1 if uncorrectable)
  valid: boolean;
}

/**
 * BCH(63,30) decode: correct up to 6 errors.
 * Input: 8 bytes (63 bits MSB-aligned).
 * Output: 4 bytes data + error stats.
 */
export function bch63Decode(encoded: Uint8Array): Bch63Result {
  ensureTables();

  // Extract 63-bit codeword
  const bits = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    bits[i] = (encoded[byteIdx] >> bitIdx) & 1;
  }

  // Calculate syndromes
  const syndrome = calculateSyndrome(bits);

  // Check if any syndrome is non-zero
  const hasError = syndrome.some(s => s !== 0);
  if (!hasError) {
    // Extract data bits (top K positions)
    const data = new Uint8Array(4);
    for (let i = 0; i < K; i++) {
      const bit = bits[N - 1 - i];
      const byteIdx = Math.floor(i / 8);
      const bitIdx = 7 - (i % 8);
      if (bit) data[byteIdx] |= (1 << bitIdx);
    }
    return { data, errors: 0, valid: true };
  }

  // Find error locator
  const lambda = berlekampMassey(syndrome);
  const errorPositions = chienSearch(lambda);

  if (errorPositions.length > 0 && errorPositions.length <= T) {
    const corrected = correctErrors(bits, errorPositions);

    // Extract data bits
    const data = new Uint8Array(4);
    for (let i = 0; i < K; i++) {
      const bit = corrected[N - 1 - i];
      const byteIdx = Math.floor(i / 8);
      const bitIdx = 7 - (i % 8);
      if (bit) data[byteIdx] |= (1 << bitIdx);
    }
    return { data, errors: errorPositions.length, valid: true };
  }

  // Uncorrectable
  const data = new Uint8Array(4);
  for (let i = 0; i < K; i++) {
    const bit = bits[N - 1 - i];
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    if (bit) data[byteIdx] |= (1 << bitIdx);
  }
  return { data, errors: -1, valid: false };
}

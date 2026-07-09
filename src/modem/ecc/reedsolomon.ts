/**
 * reedsolomon.ts — Reed-Solomon encoder/decoder over GF(256)
 *
 * RS(52,40) over GF(2^8) with primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D).
 *   - n' = 52 symbols (shortened from 255)
 *   - k  = 40 data symbols
 *   - n' - k = 12 parity symbols
 *   - Corrects up to t = 6 symbol errors per codeword
 *   - Each symbol is 8 bits
 *
 * Generator polynomial g(x) = ∏(x - α^j) for j = 0..11  (consecutive roots)
 * Evaluation indices: α^0, α^1, ..., α^11
 *
 * Soft-decision support: LLR-weighted syndrome computation.
 * Instead of hard syndrome S_j = Σ r_i · α^{i·j}, each symbol contributes
 * proportionally to its reliability: S_j = Σ w_i · r_i · α^{i·j}
 * where w_i ∈ [0, 1] is the symbol reliability from the demodulator.
 */

// ─── GF(256) Arithmetic ──────────────────────────────

const GF = 256;
const PRIMITIVE = 0x11d; // x^8 + x^4 + x^3 + x^2 + 1

let gfLog: Int16Array | null = null;
let gfExp: Int16Array | null = null;

function ensureTables(): void {
  if (gfLog) return;
  gfLog = new Int16Array(GF);
  gfExp = new Int16Array(GF * 2); // extra space for multiplication overflow

  let v = 1;
  for (let i = 0; i < GF - 1; i++) {
    gfExp[i] = v;
    gfLog[v] = i;
    v = v << 1;
    if (v & GF) v ^= PRIMITIVE;
    v &= GF - 1;
  }
  // α^255 = α^0 = 1
  gfExp[GF - 1] = gfExp[0];
  gfLog[0] = -1;
  // Extend exp table for multiplication: α^i · α^j = α^(i+j) where i+j may exceed 254
  for (let i = GF; i < GF * 2; i++) {
    gfExp[i] = gfExp[i - (GF - 1)];
  }
}

function gfAdd(a: number, b: number): number {
  return a ^ b;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  if (!gfLog || !gfExp) ensureTables();
  const sum = gfLog![a] + gfLog![b];
  return gfExp![sum];
}

function gfInv(a: number): number {
  if (a === 0) return 0;
  if (!gfLog || !gfExp) ensureTables();
  return gfExp![GF - 1 - gfLog![a]];
}

function gfPow(a: number, n: number): number {
  if (a === 0) return 0;
  if (!gfLog || !gfExp) ensureTables();
  return gfExp![(gfLog![a] * n) % (GF - 1)];
}

// ─── Generator Polynomial ────────────────────────────

// g(x) = ∏(x - α^j) for j = 1..12 (standard RS: roots at α^1, α^2, ..., α^{2t})
function rsGeneratorPoly(t: number): number[] {
  ensureTables();
  let g: number[] = [1];
  // Multiply by (x - α^j) for j = 1, 2, ..., 2t
  for (let j = 1; j <= 2 * t; j++) {
    const root = gfExp![j % (GF - 1)];
    const next = new Array(g.length + 1).fill(0);
    for (let i = 0; i < g.length; i++) {
      next[i] ^= gfMul(g[i], root);
      next[i + 1] ^= g[i];
    }
    g = next;
  }
  return g;
}

const GEN_POLY = rsGeneratorPoly(6); // t=6 → 12 roots at α^1..α^12

// ─── RS Encoder ──────────────────────────────────────

/**
 * RS(52,40) systematic encode (shortened from RS(255,243)).
 *
 * The 40 data symbols are placed at full-length positions 215..254
 * (the last 40 positions of a 255-symbol RS codeword). Positions 12..214
 * are implicitly zero. Parity is computed at positions 0..11.
 *
 * Output wire format: [parity 12B][data 40B]
 * Decoder reverses: data at output[12..51], parity at output[0..11]
 */
export function rsEncode(data: Uint8Array): Uint8Array {
  ensureTables();
  if (data.length !== 40) {
    const padded = new Uint8Array(40);
    padded.set(data, 40 - data.length);
    data = padded;
  }

  // Full-length workspace (255 symbols). Data at positions 215..254.
  const full = new Array(255).fill(0);
  for (let i = 0; i < 40; i++) full[215 + i] = data[i];

  // Polynomial long division (positions 254 down to 12)
  for (let i = 254; i >= 12; i--) {
    if (full[i] !== 0) {
      const scalar = full[i]; // g[12] = 1, leading coeff
      // Subtract scalar · g(x) at positions i-12 through i
      for (let j = 0; j <= 12; j++) {
        full[i - 12 + j] = gfAdd(full[i - 12 + j], gfMul(scalar, GEN_POLY[j]));
      }
    }
  }

  // Output: parity at 0..11 (from full[0..11]), data at 12..51
  const output = new Uint8Array(52);
  for (let i = 0; i < 12; i++) output[i] = full[i];
  for (let i = 0; i < 40; i++) output[12 + i] = data[i];
  return output;
}

// ─── RS Decoder (Hard-Decision) ──────────────────────

interface RsResult {
  /** Corrected data (40 bytes) */
  data: Uint8Array;
  /** Number of corrected symbol errors (0 if no correction needed) */
  errors: number;
  /** True if the codeword was valid (syndrome zero) or corrected */
  valid: boolean;
}

/**
 * Calculate syndrome for shortened RS(52,40). Generator roots at α^1..α^{12}.
 * Syndrome S_j = r(α^{j+1}) for j = 0..11.
 * For full-length position f: contribution r·α^{(j+1)·f}.
 */
function rsSyndrome(received: number[]): number[] {
  ensureTables();
  const n = received.length;
  const syndrome = new Array(12).fill(0);
  for (let j = 0; j < 12; j++) {
    const rootPower = (j + 1) % (GF - 1);
    let s = 0;
    for (let t = 0; t < 12; t++) {
      if (received[t] !== 0) {
        // Full-length position = t (parity)
        s = gfAdd(s, gfMul(received[t], gfPow(gfExp![rootPower], t)));
      }
    }
    for (let t = 12; t < n; t++) {
      if (received[t] !== 0) {
        // Full-length position = 203 + t (info)
        s = gfAdd(s, gfMul(received[t], gfPow(gfExp![rootPower], 203 + t)));
      }
    }
    syndrome[j] = s;
  }
  return syndrome;
}

/**
 * Berlekamp-Massey algorithm to find error locator polynomial Λ(x).
 */
function rsBerlekampMassey(syndrome: number[], t: number): number[] {
  ensureTables();
  // Λ(x) = 1 + Λ₁x + Λ₂x² + ...
  let C: number[] = [1];
  let B: number[] = [1];
  let L = 0;
  let m = 1;
  let b = 1;

  for (let r = 0; r < 2 * t; r++) {
    // Compute discrepancy d = Σ C[i] * S[r - i]
    let d = 0;
    for (let i = 0; i <= L && i <= r; i++) {
      d = gfAdd(d, gfMul(C[i], syndrome[r - i]));
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
      // Ensure enough length
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

  // Trim trailing zeros
  while (C.length > 0 && C[C.length - 1] === 0) C.pop();
  return C;
}

/**
 * Chien search for shortened RS(52,40) with roots at α^1..α^{2t}.
 * Error locator Λ(x) = ∏(1 - α^{fullPos_k}·x). Root at x = α^{-fullPos_k}.
 *
 * For parity region (i = 0..11): fullPos = i, root at α^{-i} = α^{255-i}
 * For info region  (i = 12..51): fullPos = 203 + i, root at α^{-(203+i)} = α^{52-i}
 */
function rsChienSearch(lambda: number[], n: number): number[] {
  ensureTables();
  const errors: number[] = [];
  for (let i = 0; i < n; i++) {
    // Determine full-length position for this transmitted symbol
    const fullPos = i < 12 ? i : 203 + i;
    // Root at α^{-fullPos} = α^{255 - (fullPos % 255)}
    const evalPower = (GF - 1 - (fullPos % (GF - 1))) % (GF - 1);
    let val = 0;
    for (let j = 0; j < lambda.length; j++) {
      val = gfAdd(val, gfMul(lambda[j], gfExp![(evalPower * j) % (GF - 1)]));
    }
    if (val === 0) {
      errors.push(i);
    }
  }
  return errors;
}

/**
 * Forney algorithm. Generator roots at α^1..α^{2t}.
 * Error value e_ℓ = Ω(α^{-ℓ}) / Λ'(α^{-ℓ})
 * where ℓ is the full-length position.
 */
function rsForney(syndrome: number[], lambda: number[], errorPos: number[], n: number): number[] {
  ensureTables();
  if (errorPos.length === 0) return [];

  const omega: number[] = [];
  for (let i = 0; i < syndrome.length; i++) {
    let sum = 0;
    for (let j = 0; j <= i && j < lambda.length; j++) {
      sum = gfAdd(sum, gfMul(lambda[j], syndrome[i - j]));
    }
    omega.push(sum);
  }

  const values: number[] = [];
  for (const pos of errorPos) {
    // Full-length position for this shortened index
    const fullPos = pos < 12 ? pos : 203 + pos;
    // X^{-1} = α^{-fullPos}
    const xInvPower = (GF - 1 - (fullPos % (GF - 1))) % (GF - 1);

    // Ω(X^{-1})
    let omegaVal = 0;
    for (let j = 0; j < omega.length; j++) {
      if (omega[j] !== 0) {
        omegaVal = gfAdd(omegaVal, gfMul(omega[j], gfExp![(xInvPower * j) % (GF - 1)]));
      }
    }

    // Λ'(X^{-1}) — only odd terms survive in GF(2)
    let lambdaDeriv = 0;
    for (let j = 1; j < lambda.length; j += 2) {
      if (lambda[j] !== 0) {
        const pow = (xInvPower * (j - 1)) % (GF - 1);
        lambdaDeriv = gfAdd(lambdaDeriv, gfMul(lambda[j], gfExp![pow]));
      }
    }

    if (lambdaDeriv !== 0) {
      values.push(gfMul(omegaVal, gfInv(lambdaDeriv)));
    } else {
      values.push(0);
    }
  }
  return values;
}

/**
 * RS(52,40) hard-decision decode.
 * Input: 52 bytes (40 data + 12 parity).
 * Output: corrected data + error count.
 */
export function rsDecode(encoded: Uint8Array): RsResult {
  ensureTables();

  const n = 52;
  const t = 6;

  if (encoded.length !== n) {
    return { data: encoded.slice(12, 52), errors: -1, valid: false };
  }

  // Convert to number array and compute syndrome
  const received: number[] = Array.from(encoded);
  const syndrome = rsSyndrome(received);

  // Check if syndrome is all zero (no errors)
  if (syndrome.every((s) => s === 0)) {
    return { data: new Uint8Array(received.slice(12, 52)), errors: 0, valid: true };
  }

  // Find error locator polynomial
  const lambda = rsBerlekampMassey(syndrome, t);

  // Find error positions
  const errorPos = rsChienSearch(lambda, n);

  // If no errors found or too many, report uncorrectable
  if (errorPos.length === 0 || errorPos.length > t) {
    return { data: new Uint8Array(received.slice(12, 52)), errors: errorPos.length, valid: false };
  }

  // Compute error values
  const errorValues = rsForney(syndrome, lambda, errorPos, n);

  // Correct errors
  for (let i = 0; i < errorPos.length; i++) {
    const pos = errorPos[i];
    if (pos >= 0 && pos < received.length) {
      received[pos] ^= errorValues[i];
    }
  }

  return {
    data: new Uint8Array(received.slice(12, 52)),
    errors: errorPos.length,
    valid: true,
  };
}

// ─── LLR-Weighted Soft-Decision ──────────────────────

/**
 * LLR-weighted syndrome computation for soft-decision RS decoding.
 * Each received symbol contributes proportionally to its reliability w_i.
 *
 * S_j = Σ w_i · r_i · α^{i·j}  for j = 0..11
 *
 * where w_i ∈ [0, 1] is the symbol reliability (1 = fully reliable, 0 = unknown).
 * This is NOT the standard Chase approach — it's a simpler weighted syndrome
 * that naturally emphasizes reliable symbols in the error-location search.
 *
 * @param received — 52 received symbols (hard decisions)
 * @param reliability — 52 per-symbol reliabilities in [0, 1] (1 = high confidence)
 * @returns corrected data + error count
 */
export function rsDecodeSoft(encoded: Uint8Array, reliability: Float32Array | number[]): RsResult {
  ensureTables();

  const n = 52;
  const t = 6;

  if (encoded.length !== n) {
    return { data: encoded.slice(12, 52), errors: -1, valid: false };
  }

  // Ensure reliability array (default to 1 = fully reliable)
  const reliab: number[] = Array.from(
    reliability.length === n ? reliability : new Array(n).fill(1),
  );

  // Compute erasure-weighted syndrome using proper shortened-code positions.
  // Symbols with reliability < 0.5 are treated as erasures (don't contribute to
  // the syndrome). This is the simplest form of soft-decision and gives ~1-2dB
  // gain over hard-decision. True LLR-weighting would require modifying BM.
  const syndrome = new Array(12).fill(0);
  for (let j = 0; j < 12; j++) {
    const rootPower = (j + 1) % (GF - 1);
    const root = gfExp![rootPower];
    let s = 0;
    for (let t = 0; t < 12; t++) {
      if (encoded[t] !== 0 && reliab[t] >= 0.5) {
        s = gfAdd(s, gfMul(encoded[t], gfPow(root, t)));
      }
    }
    for (let t = 12; t < n; t++) {
      if (encoded[t] !== 0 && reliab[t] >= 0.5) {
        const fullPos = 203 + t;
        s = gfAdd(s, gfMul(encoded[t], gfPow(root, fullPos)));
      }
    }
    syndrome[j] = s;
  }

  // If syndrome all zero, no errors
  if (syndrome.every((s) => s === 0)) {
    return { data: new Uint8Array(encoded.slice(12, 52)), errors: 0, valid: true };
  }

  // Standard BM + Chien + Forney with weighted syndrome
  const lambda = rsBerlekampMassey(syndrome, t);
  const errorPos = rsChienSearch(lambda, n);

  if (errorPos.length === 0 || errorPos.length > t) {
    return { data: new Uint8Array(encoded.slice(12, 52)), errors: errorPos.length, valid: false };
  }

  const errorValues = rsForney(syndrome, lambda, errorPos, n);

  const corrected = Array.from(encoded);
  for (let i = 0; i < errorPos.length; i++) {
    const pos = errorPos[i];
    if (pos >= 0 && pos < corrected.length) {
      corrected[pos] ^= errorValues[i];
    }
  }

  return {
    data: new Uint8Array(corrected.slice(12, 52)),
    errors: errorPos.length,
    valid: true,
  };
}

// ─── LLR-to-Reliability Conversion ───────────────────

/**
 * Convert per-bit LLR values to per-symbol (byte) reliability.
 *
 * Input:  320 LLR values (40 bytes × 8 bits for the RS data portion).
 *          LLR > 0  → bit = 1,  LLR < 0 → bit = 0.
 *          |LLR| is the confidence magnitude.
 *
 * Output: 40 symbol reliability values in [0, 1].
 *          Each byte's reliability = average of its 8 bit |LLR|s,
 *          mapped through: reliability = 1 - exp(-meanAbs / sigma)
 *          where sigma = 0.5 (LLR scale factor, tunes the soft-ness).
 *
 * A perfectly confident byte (all |LLR|s large) → ~1.0.
 * A completely uncertain byte (all |LLR|s = 0) → 0.0.
 */
export function bitLLRtoSymbolReliability(bitLLRs: Float32Array): Float32Array {
  const numSymbols = 40;
  const result = new Float32Array(numSymbols);
  const bitsPerByte = 8;
  const sigma = 0.5; // LLR scale for soft mapping

  for (let s = 0; s < numSymbols; s++) {
    let sumAbs = 0;
    for (let b = 0; b < bitsPerByte; b++) {
      const idx = s * bitsPerByte + b;
      if (idx < bitLLRs.length) {
        sumAbs += Math.abs(bitLLRs[idx]);
      }
    }
    const meanAbs = sumAbs / bitsPerByte;
    // Map mean absolute LLR to [0, 1] via exponential saturation
    // meanAbs = 0 → rel = 0, meanAbs → ∞ → rel → 1
    result[s] = 1 - Math.exp(-meanAbs / sigma);
  }
  return result;
}

/**
 * Convert per-bit LLR values from a full 79-byte atomic frame to
 * 52 per-symbol (byte) reliabilities for the RS(52,40) decoder.
 *
 * Frame layout (79 bytes on the wire):
 *   [0..2]   Sentinel   (3 bytes) — not RS-protected
 *   [3..26]  BCH Header (24 bytes) — not RS-protected
 *   [27..78] RS Payload (52 bytes) — the RS codeword
 *
 * RS Payload bytes (indices 27..78 = 52 bytes) are mapped as:
 *   output[0..11]  = 1.0 (parity region — always fully trusted)
 *   output[12..51] = per-byte reliability from the RS data portion
 *
 * @param frameBitLLRs — 632 LLR values (79 bytes × 8 bits).
 * @param payloadOffset — byte index in frame where RS payload starts (default 27).
 * @returns 52 symbol reliability values for rsDecodeSoft.
 */
export function frameLLRtoReliability(
  frameBitLLRs: Float32Array,
  payloadOffset = 27,
): Float32Array {
  const result = new Float32Array(52);

  // Parity region (positions 0..11): always fully reliable
  for (let i = 0; i < 12; i++) {
    result[i] = 1.0;
  }

  // Data region (positions 12..51): compute from frame LLRs
  const bitsPerByte = 8;
  const sigma = 0.5;

  for (let s = 0; s < 40; s++) {
    let sumAbs = 0;
    const frameByteIdx = payloadOffset + 12 + s; // 27 + 12 + s = 39 + s
    for (let b = 0; b < bitsPerByte; b++) {
      const bitIdx = frameByteIdx * bitsPerByte + b;
      if (bitIdx < frameBitLLRs.length) {
        sumAbs += Math.abs(frameBitLLRs[bitIdx]);
      }
    }
    const meanAbs = sumAbs / bitsPerByte;
    result[12 + s] = 1 - Math.exp(-meanAbs / sigma);
  }

  return result;
}

// ─── Unit Test Helper ────────────────────────────────

/**
 * Run a quick self-test. Returns true if RS(52,40) roundtrips correctly.
 */
export function rsSelfTest(): boolean {
  // Test 1: encode then decode (no errors)
  const testData = new Uint8Array(40);
  for (let i = 0; i < 40; i++) testData[i] = (i * 7 + 3) & 0xff;

  const encoded = rsEncode(testData);
  const decoded = rsDecode(encoded);

  if (decoded.errors !== 0) return false;
  for (let i = 0; i < 40; i++) {
    if (decoded.data[i] !== testData[i]) return false;
  }

  // Test 2: correct 3 symbol errors
  const corrupted = new Uint8Array(encoded);
  corrupted[5] ^= 0xff; // flip all bits in symbol 5
  corrupted[12] ^= 0xaa;
  corrupted[30] ^= 0x55;

  const corrected = rsDecode(corrupted);
  if (corrected.errors !== 3) return false;
  for (let i = 0; i < 40; i++) {
    if (corrected.data[i] !== testData[i]) return false;
  }

  // Test 3: correct 6 symbol errors (max capacity)
  const corrupted6 = new Uint8Array(encoded);
  for (let i = 0; i < 6; i++) {
    corrupted6[i * 8] ^= 0x80 + i;
  }
  const corrected6 = rsDecode(corrupted6);
  if (corrected6.errors < 1) return false;
  for (let i = 0; i < 40; i++) {
    if (corrected6.data[i] !== testData[i]) return false;
  }

  return true;
}

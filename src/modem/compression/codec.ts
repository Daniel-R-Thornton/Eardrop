/**
 * codec.ts — ESC-prefixed dictionary substitution codec.
 *
 * Binary-safe by construction: every byte in the input is either emitted
 * literally, or escaped, or replaced by a dictionary-match token — there is
 * no byte value that can be silently corrupted, unlike the old
 * `src/modem/debug/dictionary.ts` implementation this replaces.
 *
 * ESC = 0xFE. Encoding, at each position:
 *   - literal byte b, b !== ESC  -> emit b
 *   - literal byte b === ESC     -> emit ESC, 0x00
 *   - dictionary match of pattern at index i (0-based),
 *     found via greedy longest-match -> emit ESC, varint(i + 1)
 *     (i+1 because 0 is reserved for "escaped literal ESC")
 *
 * Decoding is the exact inverse. varint is unsigned LEB128 (7 bits per
 * byte, high bit = continuation): with dictionaries kept under 128 entries
 * every index fits in 1 byte, so a match token is always 2 bytes — hence
 * only patterns of length >= 3 are worth tokenizing (see dictionaries.ts).
 */

import { getDictionary } from './dictionaries';

export const ESC = 0xfe;

/** Scheme registry — room to grow; 0x00 is always the identity fallback. */
export const SCHEME = {
  RAW: 0x00,
  TEXT: 0x01,
  JSON: 0x02,
  LOG: 0x03,
} as const;

export interface CompressResult {
  bytes: Uint8Array;
  scheme: number;
}

// ─── varint (unsigned LEB128) ────────────────────────

function pushVarint(out: number[], value: number): void {
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    out.push(byte);
  } while (v !== 0);
}

/** Read a varint starting at `offset`. Returns the value and bytes consumed. */
function readVarint(bytes: Uint8Array, offset: number): { value: number; length: number } {
  let value = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= bytes.length) {
      // Truncated stream — treat as end-of-data (best-effort, should not
      // happen for well-formed input).
      return { value, length: i - offset };
    }
    const byte = bytes[i];
    i++;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: value >>> 0, length: i - offset };
}

// ─── Dictionary buckets (grouped by first byte, longest-first) ──────────

interface Candidate {
  pattern: Uint8Array;
  index: number;
}

type Buckets = Map<number, Candidate[]>;

const bucketCache = new WeakMap<Uint8Array[], Buckets>();

function getBuckets(dict: Uint8Array[]): Buckets {
  const cached = bucketCache.get(dict);
  if (cached) return cached;

  const buckets: Buckets = new Map();
  dict.forEach((pattern, index) => {
    const key = pattern[0];
    const list = buckets.get(key) ?? [];
    list.push({ pattern, index });
    buckets.set(key, list);
  });
  // Longest match first within each bucket for greedy matching.
  for (const list of buckets.values()) {
    list.sort((a, b) => b.pattern.length - a.pattern.length);
  }
  bucketCache.set(dict, buckets);
  return buckets;
}

function matchAt(data: Uint8Array, pos: number, candidates: Candidate[] | undefined): Candidate | null {
  if (!candidates) return null;
  for (const candidate of candidates) {
    const pat = candidate.pattern;
    if (pos + pat.length > data.length) continue;
    let ok = true;
    for (let j = 1; j < pat.length; j++) {
      if (data[pos + j] !== pat[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return candidate;
  }
  return null;
}

// ─── Encode / decode against a dictionary ────────────

function encodeWithDict(data: Uint8Array, dict: Uint8Array[]): Uint8Array {
  const buckets = getBuckets(dict);
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i];
    if (b === ESC) {
      out.push(ESC, 0x00);
      i++;
      continue;
    }
    const match = matchAt(data, i, buckets.get(b));
    if (match) {
      out.push(ESC);
      pushVarint(out, match.index + 1);
      i += match.pattern.length;
    } else {
      out.push(b);
      i++;
    }
  }
  return Uint8Array.from(out);
}

function decodeWithDict(bytes: Uint8Array, dict: Uint8Array[]): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b !== ESC) {
      out.push(b);
      i++;
      continue;
    }
    i++; // consume ESC
    const { value, length } = readVarint(bytes, i);
    i += length;
    if (value === 0) {
      out.push(ESC);
    } else {
      const pattern = dict[value - 1];
      if (pattern) {
        for (let j = 0; j < pattern.length; j++) out.push(pattern[j]);
      }
    }
  }
  return Uint8Array.from(out);
}

// ─── Public API ───────────────────────────────────────

/**
 * Compress `data` using `scheme`'s dictionary. Guarantees the result is
 * never larger than the input: if the scheme's dictionary is unknown, or
 * the encoded output isn't smaller than the raw input, falls back to
 * scheme 0x00 (raw / identity) verbatim.
 */
export function compress(data: Uint8Array, scheme: number): CompressResult {
  if (scheme === SCHEME.RAW) return { bytes: data, scheme: SCHEME.RAW };

  const dict = getDictionary(scheme);
  if (!dict) return { bytes: data, scheme: SCHEME.RAW };

  const encoded = encodeWithDict(data, dict);
  if (encoded.length >= data.length) {
    return { bytes: data, scheme: SCHEME.RAW };
  }
  return { bytes: encoded, scheme };
}

/** Inverse of `compress`. scheme 0x00 (or any unrecognized scheme) is identity. */
export function decompress(bytes: Uint8Array, scheme: number): Uint8Array {
  if (scheme === SCHEME.RAW) return bytes;
  const dict = getDictionary(scheme);
  if (!dict) return bytes;
  return decodeWithDict(bytes, dict);
}

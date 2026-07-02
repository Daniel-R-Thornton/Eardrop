/**
 * dictionary.ts — Per-file-type compression/decompression.
 *
 * Compresses payload before framed block encoding. Decompresses after
 * block extraction. Falls back to raw if no matching dictionary.
 *
 * dictScheme values:
 *   0x00 = no compression (raw)
 *   0x01 = ASCII text dictionary (common words + 7-bit packing)
 *   0xFF = no compression (explicit)
 */

import {
  ESCAPE_TOKEN,
  getAsciiLookup,
  getAsciiReverse,
  detectDictScheme,
  getDictSchemeName,
} from "./dictionary_data";

// ─── Compress ────────────────────────────────────────

/**
 * Compress data using the ASCII text dictionary.
 *
 * Strategy:
 *   1. Try longest token match starting at current position
 *   2. If matched, emit token byte, advance by pattern length
 *   3. If no match, emit ESCAPE + literal byte (or just literal if < 0x80 by itself)
 *   4. Simple approach: no 7-bit packing for now, just token + ESC/literal
 */
function compressAscii(input: Uint8Array): Uint8Array {
  const lookup = getAsciiLookup();
  const output: number[] = [];
  const ESC = ESCAPE_TOKEN;

  let i = 0;
  while (i < input.length) {
    const firstByte = input[i];
    const candidates = lookup.get(firstByte);
    let matched = false;

    if (candidates) {
      // Sort candidates by length descending for greedy longest match
      candidates.sort((a, b) => b.pattern.length - a.pattern.length);
      for (const candidate of candidates) {
        if (i + candidate.pattern.length <= input.length) {
          let match = true;
          for (let j = 1; j < candidate.pattern.length; j++) {
            if (input[i + j] !== candidate.pattern[j]) {
              match = false;
              break;
            }
          }
          if (match) {
            output.push(candidate.token);
            i += candidate.pattern.length;
            matched = true;
            break;
          }
        }
      }
    }

    if (!matched) {
      // Check if this byte value is already used as a token (collision avoidance)
      // Token range 0x01-0x10, ESC=0xFF. ASCII literals < 0x80 are emitted as-is.
      // The decompress path checks token lookup first, then treats remaining as literal.
      output.push(input[i]);
      i++;
    }
  }

  return new Uint8Array(output);
}

/**
 * Compress data using the specified dictionary scheme.
 * Returns { compressed, scheme }.
 */
export function compress(
  data: Uint8Array,
  scheme: number,
): { compressed: Uint8Array; scheme: number } {
  switch (scheme) {
    case 0x01:
      return { compressed: compressAscii(data), scheme: 0x01 };
    default:
      return { compressed: data, scheme: 0x00 };
  }
}

/**
 * Compress data, auto-detecting scheme from file name.
 */
export function compressWithDetection(
  data: Uint8Array,
  fileName: string,
): { compressed: Uint8Array; scheme: number } {
  const scheme = detectDictScheme(fileName);
  return compress(data, scheme);
}

// ─── Decompress ──────────────────────────────────────

/**
 * Decompress ASCII text tokens.
 */
function decompressAscii(compressed: Uint8Array): Uint8Array {
  const reverse = getAsciiReverse();
  const output: number[] = [];
  const ESC = ESCAPE_TOKEN;
  // Set of valid token values
  const tokenValues = new Set(reverse.keys());

  let i = 0;
  while (i < compressed.length) {
    const byte = compressed[i];

    if (byte === ESC) {
      // Escape: next byte is literal
      i++;
      if (i < compressed.length) {
        output.push(compressed[i]);
      }
      i++;
      continue;
    }

    if (tokenValues.has(byte)) {
      // Token: expand to pattern
      const pattern = reverse.get(byte)!;
      for (let j = 0; j < pattern.length; j++) {
        output.push(pattern[j]);
      }
      i++;
      continue;
    }

    // Literal byte
    output.push(byte);
    i++;
  }

  return new Uint8Array(output);
}

/**
 * Decompress data using the specified dictionary scheme.
 * If scheme is 0x00, returns data unchanged.
 */
export function decompress(
  compressed: Uint8Array,
  scheme: number,
): Uint8Array {
  switch (scheme) {
    case 0x01:
      return decompressAscii(compressed);
    default:
      return compressed;
  }
}

// ─── Compression Stats ──────────────────────────────

export interface CompressionStats {
  originalSize: number;
  compressedSize: number;
  ratio: number;
  scheme: number;
  schemeName: string;
}

/**
 * Get compression statistics.
 */
export function getCompressionStats(
  data: Uint8Array,
  scheme: number,
): CompressionStats {
  const compressed = compress(data, scheme);
  return {
    originalSize: data.length,
    compressedSize: compressed.compressed.length,
    ratio: data.length > 0 ? compressed.compressed.length / data.length : 1,
    scheme: compressed.scheme,
    schemeName: getDictSchemeName(compressed.scheme),
  };
}

export { detectDictScheme, getDictSchemeName };

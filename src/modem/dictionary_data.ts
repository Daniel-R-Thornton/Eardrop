/**
 * dictionary_data.ts — Static lookup tables for dictionary compression.
 *
 * ASCII text dictionary with token → pattern mapping for fast lookup.
 * Tokens are sorted by frequency for optimal compression.
 */

export const ESCAPE_TOKEN = 0xFF;
export const SPACE_TOKEN = 0x01;
export const NEWLINE_TOKEN = 0x02;

/** A token entry with its byte value and literal pattern */
export interface TokenEntry {
  token: number;
  pattern: Uint8Array;
}

// ─── ASCII Token Map ─────────────────────────────────

/**
 * Maps first byte → list of token entries starting with that byte.
 * This enables O(1) lookup by first character, then O(k) scan through
 * candidates starting with that character.
 */
let asciiLookup: Map<number, TokenEntry[]> | null = null;
let asciiReverse: Map<number, Uint8Array> | null = null;

const ASCII_TOKENS: TokenEntry[] = [
  { token: 0x01, pattern: new Uint8Array([0x20, 0x74, 0x68, 0x65, 0x20]) },    // ' the '
  { token: 0x02, pattern: new Uint8Array([0x20, 0x61, 0x6E, 0x64, 0x20]) },    // ' and '
  { token: 0x03, pattern: new Uint8Array([0x20, 0x74, 0x68, 0x61, 0x74, 0x20]) }, // ' that '
  { token: 0x04, pattern: new Uint8Array([0x20, 0x77, 0x69, 0x74, 0x68, 0x20]) }, // ' with '
  { token: 0x05, pattern: new Uint8Array([0x20, 0x66, 0x72, 0x6F, 0x6D, 0x20]) }, // ' from '
  { token: 0x06, pattern: new Uint8Array([0x20, 0x74, 0x68, 0x69, 0x73, 0x20]) }, // ' this '
  { token: 0x07, pattern: new Uint8Array([0x20, 0x69, 0x73, 0x20]) },        // ' is '
  { token: 0x08, pattern: new Uint8Array([0x20, 0x69, 0x6E, 0x20]) },       // ' in '
  { token: 0x09, pattern: new Uint8Array([0x61, 0x20]) },                   // 'a '
  { token: 0x0A, pattern: new Uint8Array([0x74, 0x6F, 0x20]) },            // 'to '
  { token: 0x0B, pattern: new Uint8Array([0x6F, 0x66, 0x20]) },            // 'of '
  { token: 0x0C, pattern: new Uint8Array([0x66, 0x6F, 0x72, 0x20]) },      // 'for '
  { token: 0x0D, pattern: new Uint8Array([0x0D, 0x0A]) },                  // '\r\n'
  { token: 0x0E, pattern: new Uint8Array([0x0A]) },                         // '\n'
  { token: 0x0F, pattern: new Uint8Array([0x20, 0x20]) },                  // '  '
  { token: 0x10, pattern: new Uint8Array([0x2E, 0x20]) },                  // '. '
];

export function getAsciiLookup(): Map<number, TokenEntry[]> {
  if (asciiLookup) return asciiLookup;
  asciiLookup = new Map();
  for (const entry of ASCII_TOKENS) {
    const firstByte = entry.pattern[0];
    const list = asciiLookup.get(firstByte) || [];
    list.push(entry);
    asciiLookup.set(firstByte, list);
  }
  return asciiLookup;
}

export function getAsciiReverse(): Map<number, Uint8Array> {
  if (asciiReverse) return asciiReverse;
  asciiReverse = new Map();
  for (const entry of ASCII_TOKENS) {
    asciiReverse.set(entry.token, entry.pattern);
  }
  return asciiReverse;
}

// ─── Detection ────────────────────────────────────

/**
 * Detect file type from file name and return the appropriate dictScheme.
 */
export function detectDictScheme(fileName: string): number {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv') ||
      lower.endsWith('.tsv') || lower.endsWith('.log') || lower.endsWith('.ini') ||
      lower.endsWith('.cfg') || lower.endsWith('.conf')) {
    return 0x01;
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.xml') ||
      lower.endsWith('.sgml')) {
    return 0x01; // ASCII-adjacent
  }
  if (lower.endsWith('.json')) {
    return 0x01; // Also ASCII
  }
  return 0x00;
}

export function getDictSchemeName(scheme: number): string {
  switch (scheme) {
    case 0x00: return 'Raw (no compression)';
    case 0x01: return 'ASCII Text';
    case 0xFF: return 'Explicit Raw';
    default: return `Unknown (0x${scheme.toString(16)})`;
  }
}

export { ASCII_TOKENS };

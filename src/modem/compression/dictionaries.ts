/**
 * dictionaries.ts — Static, hand-authored per-scheme pattern tables.
 *
 * These are shipped in code so both TX and RX have identical tables without
 * any handshake or corpus training. Keep entries small (modest dictionary
 * size keeps varint indices 1 byte) and every pattern >= 3 bytes — a match
 * token costs 2 bytes (ESC + 1-byte varint for <128 entries), so tokenizing
 * anything shorter than 3 literal bytes cannot win.
 *
 * Order matters only in that index 0 = first entry; greedy matching tries
 * the longest candidate at each position regardless of table order.
 */

const enc = new TextEncoder();

/** Convert an ASCII/Latin1 string literal into pattern bytes. */
function p(s: string): Uint8Array {
  return enc.encode(s);
}

// ─── Scheme 0x01 — text / prose ──────────────────────
// Common English fragments (word plus surrounding spaces where it helps
// the greedy matcher span word boundaries too).
export const TEXT_DICTIONARY: Uint8Array[] = [
  p(' the '), //  the␣
  p(' and '), //  and␣
  p(' that '), //  that␣
  p(' with '), //  with␣
  p(' for '), //  for␣
  p(' you '), //  you␣
  p(' this '), //  this␣
  p(' have '), //  have␣
  p(' from '), //  from␣
  p(' they '), //  they␣
  p(' which '), //  which␣
  p(' would '), //  would␣
  p(' there '), //  there␣
  p(' their '), //  their␣
  p(' were '), //  were␣
  p(' when '), //  when␣
  p(' your '), //  your␣
  p(' said '), //  said␣
  p(' not '), //  not␣
  p(' one '), //  one␣
  p(' all '), //  all␣
  p(' can '), //  can␣
  p(' what '), //  what␣
  p(' is '), //  is␣
  p(' as '), //  as␣
  p(' at '), //  at␣
  p(' be '), //  be␣
  p(' or '), //  or␣
  p(' it '), //  it␣
  p(' an '), //  an␣
  p(' on '), //  on␣
  p(' of '), //  of␣
  p(' in '), //  in␣
  p(' to '), //  to␣
  p(' a '), //  a␣
  p('the '), // the␣
  p('and '), // and␣
  p('tion'), // tion
  p('ing '), // ing␣
  p('ed '), // ed␣
  p('ly '), // ly␣
  p(', and '), // ,␣and␣
  p('. The '), // .␣The␣
  p(". \n"), // .␣\n
];

// ─── Scheme 0x02 — JSON ───────────────────────────────
// Common JSON punctuation runs and literals. Two-byte fragments like `{"`
// are deliberately omitted: a 2-byte match still costs a 2-byte token
// (ESC + varint), so there is nothing to gain versus emitting the literal
// bytes — only patterns >= 3 bytes are worth tokenizing.
export const JSON_DICTIONARY: Uint8Array[] = [
  p('":"'), // ":"
  p('","'), // ","
  p('"},{"'), // "},{"
  p('":['), // ":[
  p('":{'), // ":{
  p('":0'), // ":0
  p('":1'), // ":1
  p('"},'), // "},
  p(',{"'), // ,{"
  p('"[]'), // "[]
  p('":true'), // ":true
  p('":false'), // ":false
  p('":null'), // ":null
  p('"},\n'), // "},\n
  p('":""'), // ":""
  p('"}]'), // "}]
  p('":[]'), // ":[]
  p('":{}'), // ":{}
  p('null'), // null
  p('true'), // true
  p('false'), // false
  p('\n  '), // \n␣␣
  p('    '), // four spaces
  p('"id":'), // "id":
  p('"name":'), // "name":
  p('"type":'), // "type":
  p('"value":'), // "value":
  p('"data":'), // "data":
];

// ─── Scheme 0x03 — log / CSV ──────────────────────────
// Log-level tags, timestamp skeletons, HTTP status fragments, and CSV/CRLF
// runs. A bare single "," is 1 byte (< 3) and is intentionally excluded.
export const LOG_DICTIONARY: Uint8Array[] = [
  p(' ERROR '), //  ERROR␣
  p(' DEBUG '), //  DEBUG␣
  p(' TRACE '), //  TRACE␣
  p(' WARN '), //  WARN␣
  p(' INFO '), //  INFO␣
  p(':00:00'), // :00:00
  p('T00:00'), // T00:00
  p(':00 '), // :00␣
  p('202'), // 202 (2020s year prefix)
  p('-01-'), // -01-
  p('-02-'), // -02-
  p('-03-'), // -03-
  p(',\r\n'), // ,\r\n
  p('","'), // ","
  p('GET '), // GET␣
  p('POST '), // POST␣
  p(' 200 '), //  200␣
  p(' 404 '), //  404␣
  p(' 500 '), //  500␣
  p('.log'), // .log
  p('.csv'), // .csv
  p('\r\n\r\n'), // \r\n\r\n
];

/** Scheme registry: id -> dictionary. 0x00 (raw) has no dictionary. */
export const DICTIONARIES: Record<number, Uint8Array[]> = {
  0x01: TEXT_DICTIONARY,
  0x02: JSON_DICTIONARY,
  0x03: LOG_DICTIONARY,
};

export function getDictionary(scheme: number): Uint8Array[] | undefined {
  return DICTIONARIES[scheme];
}

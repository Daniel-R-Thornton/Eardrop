/**
 * detect.ts — file-type -> compression scheme id, via magic bytes then a
 * text heuristic. Extension is only ever a tiebreak, never the primary
 * signal (renamed files must still be classified correctly).
 */

import { SCHEME } from './codec';

/** Magic-byte signatures for formats that are already compressed — always raw. */
const MAGIC_RAW: Array<{ bytes: number[]; name: string }> = [
  { bytes: [0xff, 0xd8, 0xff], name: 'jpeg' },
  { bytes: [0x89, 0x50, 0x4e, 0x47], name: 'png' },
  { bytes: [0x25, 0x50, 0x44, 0x46], name: 'pdf' }, // %PDF
  { bytes: [0x1f, 0x8b], name: 'gzip' },
  { bytes: [0x50, 0x4b], name: 'zip' }, // also covers docx/xlsx/jar etc.
];

function matchesMagic(data: Uint8Array, sig: number[]): boolean {
  if (data.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (data[i] !== sig[i]) return false;
  }
  return true;
}

/** Sample size for text sniffing — enough to be representative, small enough to be cheap. */
const SNIFF_SAMPLE = 2048;

function looksLikeText(data: Uint8Array): boolean {
  if (data.length === 0) return true;
  const n = Math.min(data.length, SNIFF_SAMPLE);
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = data[i];
    // Tab, LF, CR, or printable ASCII/UTF-8 continuation range.
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) || b >= 0x80) {
      printable++;
    }
    // Anything else (NUL, other C0 control chars) is a binary signal and
    // is simply not counted as printable, dragging the ratio down below.
  }
  return printable / n > 0.95;
}

function firstNonSpaceChar(data: Uint8Array): string {
  const n = Math.min(data.length, SNIFF_SAMPLE);
  for (let i = 0; i < n; i++) {
    const b = data[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    return String.fromCharCode(b);
  }
  return '';
}

function looksLikeCsvOrLog(data: Uint8Array): boolean {
  const n = Math.min(data.length, SNIFF_SAMPLE);
  let commas = 0;
  let tabs = 0;
  let newlines = 0;
  for (let i = 0; i < n; i++) {
    if (data[i] === 0x2c) commas++;
    else if (data[i] === 0x09) tabs++;
    else if (data[i] === 0x0a) newlines++;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(0, n));
  const timestampish = /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}/.test(text);
  // Require a comma density well above what ordinary prose punctuation
  // produces (occasional single commas) — a real CSV/log row packs several
  // commas per line (or per the whole sample, if there's no trailing
  // newline yet).
  const delimited = (commas >= 2 && commas / (newlines + 1) >= 1.5) || tabs > 2;
  return timestampish || delimited;
}

/**
 * Detect the compression scheme for `data` (optionally named `fileName`).
 * Magic bytes take priority (already-compressed formats -> raw). Otherwise
 * sniff for text and pick JSON / log-CSV / prose. Extension is a tiebreak
 * only, applied when the content heuristic is ambiguous (empty data).
 */
export function detect(fileName: string, data: Uint8Array): number {
  for (const sig of MAGIC_RAW) {
    if (matchesMagic(data, sig.bytes)) return SCHEME.RAW;
  }

  if (!looksLikeText(data)) return SCHEME.RAW;

  const ext = (fileName.split('.').pop() ?? '').toLowerCase();

  if (data.length === 0) {
    // No content to sniff — fall back to extension.
    if (ext === 'json') return SCHEME.JSON;
    if (ext === 'csv' || ext === 'log' || ext === 'tsv') return SCHEME.LOG;
    return SCHEME.TEXT;
  }

  const first = firstNonSpaceChar(data);
  if (first === '{' || first === '[') return SCHEME.JSON;

  if (looksLikeCsvOrLog(data)) return SCHEME.LOG;

  return SCHEME.TEXT;
}

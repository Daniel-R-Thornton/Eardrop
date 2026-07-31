/**
 * index.ts — public surface of the compression module.
 */
import { decompress, SCHEME, type CompressResult } from './codec';
import { detect } from './detect';
import { gzipBytes, gunzipBytes } from './gzip';

export { compress, decompress, SCHEME, ESC } from './codec';
export type { CompressResult } from './codec';
export { detect } from './detect';
export { gzipBytes, gunzipBytes } from './gzip';
export { getDictionary, TEXT_DICTIONARY, JSON_DICTIONARY, LOG_DICTIONARY, DICTIONARIES } from './dictionaries';

/**
 * Pick the best compression for a file and return the wire bytes + scheme id.
 * Screens out already-compressed formats (magic bytes → raw), gzips everything
 * else, and falls back to raw if gzip doesn't actually shrink it — so the wire
 * output is never larger than the input.
 */
export async function compressBest(data: Uint8Array, fileName: string): Promise<CompressResult> {
  if (detect(fileName, data) === SCHEME.RAW) return { bytes: data, scheme: SCHEME.RAW };
  const gz = await gzipBytes(data);
  return gz.length < data.length ? { bytes: gz, scheme: SCHEME.GZIP } : { bytes: data, scheme: SCHEME.RAW };
}

/**
 * Inverse of compressBest. Handles gzip (async) and the legacy static-dictionary
 * schemes (sync); raw / unknown → identity.
 */
export async function decompressScheme(bytes: Uint8Array, scheme: number): Promise<Uint8Array> {
  if (scheme === SCHEME.GZIP) return gunzipBytes(bytes);
  if (scheme === SCHEME.RAW || scheme === undefined) return bytes;
  return decompress(bytes, scheme);
}

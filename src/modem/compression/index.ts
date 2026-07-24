/**
 * index.ts — public surface of the compression module.
 */
export { compress, decompress, SCHEME, ESC } from './codec';
export type { CompressResult } from './codec';
export { detect } from './detect';
export { getDictionary, TEXT_DICTIONARY, JSON_DICTIONARY, LOG_DICTIONARY, DICTIONARIES } from './dictionaries';

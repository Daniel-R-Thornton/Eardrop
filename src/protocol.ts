/**
 * Protocol — preamble packet for file transfer.
 * @deprecated Use src/lib/protocol instead
 */

export type {
  FilePreamble,
  FileBlock,
  ParseResult,
} from './lib/protocol/index';

export {
  preambleSize,
  buildPacket,
  tryParsePreamble,
  verifyPayload,
} from './lib/protocol/index';

// Wrapper for backward compatibility with old verifyPayload signature
import { verifyPayload as verifyPayloadNew } from './lib/protocol/index';
export function verifyPayloadOld(preamble: any, payload: Uint8Array): boolean {
  if (payload.length !== preamble.totalSize) return false;
  return verifyPayloadNew(payload, preamble.crc32);
}

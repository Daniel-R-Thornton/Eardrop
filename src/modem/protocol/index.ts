/**
 * src/modem/protocol/index.ts — Barrel export for protocol implementations.
 */
export { Encoder } from './encoder';
export { Decoder } from './decoder';
export type { DecoderDebugInfo } from './decoder';
export { TxEngine } from './txEngine';
export { RxEngine, RxState } from './rxEngine';
export type { ReceivedFile } from './rxEngine';
export { encodeBlock, FramedBlockDecoder, BLOCK_TYPE, getSentinel } from './framing';
export type { EncodedBlock, BlockType } from './framing';
export { encodeFrame, decodeFrame, FRAME_SIZE, PAYLOAD_DATA_SIZE } from './atomicFrame';
export type { AtomicHeader } from './atomicFrame';
export { BlockProcessor } from './blockProcessor';
export { encodeSquawkPayload, SquawkProcessor } from './squawk';
export { generatePreamble } from './preamble';
export type { PreambleConfig } from './preamble';

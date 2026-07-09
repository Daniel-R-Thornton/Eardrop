/**
 * src/modem/receiver/index.ts
 * Barrel export for receiver components.
 */
export { BlockProcessor } from '../protocol/blockProcessor';
export { FramedBlockDecoder, BLOCK_TYPE, getSentinel } from '../protocol/framing';
export { SquawkProcessor } from '../protocol/squawk';
export { NoiseProfiler } from './NoiseProfiler';
export { PreambleDetector } from './PreambleDetector';
export { SentinelScanner } from './SentinelScanner';
export type { PreamblePhase, PreambleFrameInput, PreambleResult } from './PreambleDetector';

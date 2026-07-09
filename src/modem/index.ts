/**
 * src/modem/index.ts — Unified barrel export for all modem components.
 *
 * Sub-modules by use case:
 *   protocol/    — Encoder, Decoder, TxEngine, RxEngine, framing, atomic frames
 *   ecc/         — BCH, Reed-Solomon error correction
 *   dsp/         — Oscillator, noise generation, digital signal processing
 *   pilot/       — Pilot discovery, PLL tracking, tone I/Q
 *   modulation/  — BPSK tone generation (shared by Encoder and TxEngine)
 *   demodulation/— Bit extraction from audio samples
 *   receiver/    — Frame assembly, noise profiling, sentinel scanning
 *   channel/     — Channel impairment simulation
 *   debug/       — Structured logging, diagnostics, visualization, LLM export
 *   test/        — Test harness and test suites
 */

// ── Protocol ──
export {
  Encoder,
  Decoder,
  TxEngine,
  RxEngine,
  RxState,
  encodeBlock,
  FramedBlockDecoder,
  BLOCK_TYPE,
  getSentinel,
  BlockProcessor,
  encodeSquawkPayload,
  SquawkProcessor,
  generatePreamble,
} from './protocol/index';
export type {
  DecoderDebugInfo,
  ReceivedFile,
  PreambleConfig,
} from './protocol/index';

// ── ECC ──
export { bch3116Encode, bch3116Decode } from './ecc/index';

// ── DSP ──
export { PhaseAcc } from './dsp/index';

// ── Pilot ──
export {
  PilotScanner,
  PilotPLL,
  PilotTracker,
  toneIQ,
  getDataToneFreqs,
} from './pilot/index';
export type {
  PilotDiscovery,
  PilotScannerConfig,
  PLLConfig,
  PilotTrackerConfig,
} from './pilot/index';

// ── Modulation ──
export { BPSKModulator } from './modulation/index';
export type { BPSKModulatorConfig } from './modulation/index';

// ── Receiver ──
export {
  NoiseProfiler,
  PreambleDetector,
  SentinelScanner,
} from './receiver/index';
export type {
  PreamblePhase,
  PreambleFrameInput,
  PreambleResult,
} from './receiver/index';

// ── Channel ──
export { ChannelSimulator } from './channel/index';

// ── Debug ──
export {
  debugLogger,
  STAGE,
  LOG_LEVEL,
  Visualizer,
} from './debug/index';

// ── Core types ──
export {
  TONE_OFFSETS,
  MUSICAL_OFFSETS,
  TONE_COLORS,
  DEFAULT_CONFIG,
} from './types';
export type { ModemConfig } from './types';

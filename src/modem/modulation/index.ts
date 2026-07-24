/**
 * src/modem/modulation/index.ts
 * Barrel export for BPSK modulation components.
 */
export { BPSKModulator } from './BPSKModulator';
export type { BPSKModulatorConfig } from './BPSKModulator';
export { OFDMQPSKModulator } from './OFDMQPSKModulator';
export type { OFDMQPSKModulatorConfig } from './OFDMQPSKModulator';
export {
  mapSymbol,
  sliceSymbol,
  normalizationScale,
  maxConstellationMagnitude,
  qamMapValueToOrder,
  MAX_QAM_MAGNITUDE,
  QAM_ORDERS,
} from './constellation';
export type { QamOrder, ConstellationPoint } from './constellation';

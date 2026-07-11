/**
 * The single place UI state becomes a ModemConfig. Every TX and RX path
 * must go through this — inline config literals caused TX/RX mismatch
 * bugs (2026-07-10: omitted toneCount fell back to 4 in the worker).
 */
import { DEFAULT_CONFIG, type ModemConfig } from '../../modem/types';

export interface ModemUiConfig {
  useOFDM: boolean;
  pilotFreqHz: number;
  toneCount: number;
  symbolsPerSec: number;
  musicalMode: boolean;
  diversityMode: boolean;
  hwSampleRate: number;
}

export function buildModemConfig(ui: ModemUiConfig): ModemConfig & { useOFDM: boolean } {
  return {
    ...DEFAULT_CONFIG,
    sampleRate: ui.useOFDM ? ui.hwSampleRate : DEFAULT_CONFIG.sampleRate,
    pilotFreqHz: ui.pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz,
    toneCount: ui.toneCount || DEFAULT_CONFIG.toneCount,
    bitsPerFrame: (ui.toneCount || DEFAULT_CONFIG.toneCount) * 2,
    symbolsPerSec: ui.symbolsPerSec || DEFAULT_CONFIG.symbolsPerSec,
    musical: ui.musicalMode,
    diversityMode: ui.diversityMode,
    useOFDM: ui.useOFDM,
  };
}

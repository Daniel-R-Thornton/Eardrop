/**
 * The single place UI state becomes a ModemConfig. Every TX and RX path
 * must go through this — inline config literals caused TX/RX mismatch
 * bugs (2026-07-10: omitted toneCount fell back to 4 in the worker).
 *
 * OFDM pilot snapping: the pilot must be an integer multiple of the FFT
 * bin spacing so every tone has integer cycles per symbol — otherwise
 * the cyclic prefix has phase discontinuities and multipath immunity
 * breaks. Snapping is lossless for the user because the bin spacing
 * (50 Hz at 48 kHz native rate) is finer than any practical tuning knob.
 */
import { DEFAULT_CONFIG, ofdmSamples, type ModemConfig } from '../../modem/types';
import { dlog } from '../../lib/debug/dlog';

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
  let pilot = ui.pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz;

  // OFDM cyclic-prefix continuity requires every tone (pilot + offsets)
  // to have integer cycles in the FFT window. Snap the pilot to the
  // nearest multiple of the FFT bin spacing.
  if (ui.useOFDM) {
    const { fftSamples } = ofdmSamples(ui.hwSampleRate);
    const binHz = ui.hwSampleRate / fftSamples; // e.g. 48000/960 = 50 Hz
    const snapped = Math.round(pilot / binHz) * binHz;
    if (snapped !== pilot) {
      dlog('CONFIG', { note: 'pilotSnapped', from: pilot, to: snapped, binHz, fftSamples });
      pilot = snapped;
    }
  }

  return {
    ...DEFAULT_CONFIG,
    sampleRate: ui.useOFDM ? ui.hwSampleRate : DEFAULT_CONFIG.sampleRate,
    pilotFreqHz: pilot,
    toneCount: ui.toneCount || DEFAULT_CONFIG.toneCount,
    bitsPerFrame: (ui.toneCount || DEFAULT_CONFIG.toneCount) * 2,
    symbolsPerSec: ui.symbolsPerSec || DEFAULT_CONFIG.symbolsPerSec,
    musical: ui.musicalMode,
    diversityMode: ui.diversityMode,
    useOFDM: ui.useOFDM,
  };
}

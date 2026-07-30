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
import { DEFAULT_CONFIG, OFDM_DEFAULTS, MIN_TONE_START_HZ, ofdmSamples, type ModemConfig } from '../../modem/types';
import { dlog } from '../../lib/debug/dlog';

export interface ModemUiConfig {
  useOFDM: boolean;
  pilotFreqHz: number;
  toneCount: number;
  symbolsPerSec: number;
  musicalMode: boolean;
  diversityMode: boolean;
  hwSampleRate: number;
  /** Phase 3 data-tone constellation, applied to ALL tones (default 2 = QPSK, unchanged waveform) */
  dataQamBits?: 2 | 4 | 6;
  /** Optional override for the fixed per-tone TX scale used in QAM data symbols.
   *  Leave undefined for the default crest-factor-derived scale. Tuning this
   *  can help real audio chains where the receiver's expected QAM amplitude
   *  does not match the actual transmitted amplitude. */
  qamScaleOverride?: number;
  /** OFDM: Hz above the pilot where the first data tone sits. Leave undefined
   *  for the default (OFDM_DEFAULTS.toneStartHz = 2000Hz, today's behavior). */
  toneStartHz?: number;
}

export function buildModemConfig(
  ui: ModemUiConfig,
): ModemConfig & { useOFDM: boolean; emitLinkProfile?: boolean; qamMap?: number[]; qamScaleOverride?: number } {
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

  const toneCount = ui.toneCount || DEFAULT_CONFIG.toneCount;

  // Tone-grid start offset above the pilot. Clamp defensively so a config
  // that somehow slips below the minimum separation can't alias the lowest
  // data tone onto the pilot — ofdmToneFrequencies() enforces the same floor,
  // so this is belt-and-braces, not the only guard.
  const toneStartHz = Math.max(
    MIN_TONE_START_HZ,
    typeof ui.toneStartHz === 'number' && Number.isFinite(ui.toneStartHz)
      ? ui.toneStartHz
      : OFDM_DEFAULTS.toneStartHz,
  );

  // Phase 3 per-tone QAM (bit-loading): a 2-bit profile code applied to every
  // tone. Default (2 bits = QPSK) must NEVER emit a link profile — the
  // waveform has to stay byte-identical to the pre-bit-loading behavior.
  const bits = ui.dataQamBits ?? 2;
  const order = bits === 4 ? 1 : bits === 6 ? 2 : 0;

  const config: ModemConfig & { useOFDM: boolean; emitLinkProfile?: boolean; qamMap?: number[]; qamScaleOverride?: number } = {
    ...DEFAULT_CONFIG,
    sampleRate: ui.useOFDM ? ui.hwSampleRate : DEFAULT_CONFIG.sampleRate,
    pilotFreqHz: pilot,
    toneCount,
    toneStartHz,
    bitsPerFrame: toneCount * 2,
    symbolsPerSec: ui.symbolsPerSec || DEFAULT_CONFIG.symbolsPerSec,
    musical: ui.musicalMode,
    diversityMode: ui.diversityMode,
    useOFDM: ui.useOFDM,
  };

  if (ui.useOFDM && order > 0) {
    config.emitLinkProfile = true;
    config.qamMap = new Array(toneCount).fill(order);
  }

  if (ui.useOFDM && typeof ui.qamScaleOverride === 'number' && Number.isFinite(ui.qamScaleOverride)) {
    config.qamScaleOverride = ui.qamScaleOverride;
  }

  return config;
}

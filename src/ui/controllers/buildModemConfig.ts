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
import { DEFAULT_CONFIG, OFDM_DEFAULTS, MIN_TONE_START_HZ, OFDM_TUNING, ofdmSamples, type ModemConfig } from '../../modem/types';
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
  /** Per-tone pre-emphasis (linear, mean-unity). */
  toneGains?: number[];
  /** Settle symbols discarded before training; TX and RX must agree. */
  trainingSettleSymbols?: number;
  /** OFDM: Hz above the pilot where the first data tone sits. Leave undefined
   *  for the default (OFDM_DEFAULTS.toneStartHz = 2000Hz, today's behavior). */
  toneStartHz?: number;
  /** Band handshake: preamble+profile on the fixed OFDM_HANDSHAKE band; the
   *  v2 profile announces this config's band and both sides hop. */
  bandHandshake?: boolean;
}

export function buildModemConfig(
  ui: ModemUiConfig,
): ModemConfig & { useOFDM: boolean; emitLinkProfile?: boolean; bandHandshake?: boolean; qamMap?: number[]; qamScaleOverride?: number; toneGains?: number[];
  trainingSettleSymbols?: number } {
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

  // Tone-grid start offset above the pilot. Same reasoning as the pilot snap
  // above: every tone needs integer cycles per FFT window, so toneStartHz
  // must land on a whole multiple of the bin spacing too — the UI slider's
  // 50Hz step already guarantees this, but any other ModemUiConfig producer
  // (persisted state, a script, a test) could hand in an arbitrary value.
  // Snap first, then floor-clamp so a config that somehow slips below the
  // minimum separation can't alias the lowest data tone onto the pilot —
  // ofdmToneFrequencies() enforces the same floor too, so this is
  // belt-and-braces, not the only guard.
  let toneStartHz =
    typeof ui.toneStartHz === 'number' && Number.isFinite(ui.toneStartHz)
      ? ui.toneStartHz
      : OFDM_DEFAULTS.toneStartHz;
  if (ui.useOFDM) {
    const { fftSamples } = ofdmSamples(ui.hwSampleRate);
    const binHz = ui.hwSampleRate / fftSamples;
    const snappedStart = Math.round(toneStartHz / binHz) * binHz;
    if (snappedStart !== toneStartHz) {
      dlog('CONFIG', { note: 'toneStartSnapped', from: toneStartHz, to: snappedStart, binHz, fftSamples });
      toneStartHz = snappedStart;
    }
  }
  toneStartHz = Math.max(MIN_TONE_START_HZ, toneStartHz);

  // Phase 3 per-tone QAM (bit-loading): a 2-bit profile code applied to every
  // tone. Default (2 bits = QPSK) must NEVER emit a link profile — the
  // waveform has to stay byte-identical to the pre-bit-loading behavior.
  const bits = ui.dataQamBits ?? 2;
  const order = bits === 4 ? 1 : bits === 6 ? 2 : 0;

  const config: ModemConfig & { useOFDM: boolean; emitLinkProfile?: boolean; bandHandshake?: boolean; qamMap?: number[]; qamScaleOverride?: number; toneGains?: number[];
  trainingSettleSymbols?: number } = {
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

  // Band handshake: an announcement segment (preamble + band card, see
  // bandCard.ts) on the fixed handshake band, then the normal transmission in
  // this config's band. TX reads the flag to emit the segment; RX reads it to
  // LISTEN on the handshake band and retune from the card. No forced link
  // profile — the target-band stream is byte-identical to a flag-off send,
  // which only carries a profile when the qamMap needs one (order > 0 above).
  if (ui.useOFDM && ui.bandHandshake === true) {
    config.bandHandshake = true;
  }

  if (ui.useOFDM && typeof ui.qamScaleOverride === 'number' && Number.isFinite(ui.qamScaleOverride)) {
    config.qamScaleOverride = ui.qamScaleOverride;
  }

  // Pre-emphasis only applies when it matches the tone count in force. A
  // calibration captured at a different count would land on the wrong
  // frequencies, and the modulator would silently apply it to a prefix of the
  // tones — so drop it here rather than half-use it.
  if (
    ui.useOFDM
    && Array.isArray(ui.toneGains)
    && ui.toneGains.length === toneCount
    && ui.toneGains.every((g) => Number.isFinite(g) && g > 0)
  ) {
    config.toneGains = ui.toneGains.slice();
  }

  // Settle length is a bring-up lever (see generateSettleSymbols). Clamped so a
  // UI value cannot violate OFDM_TUNING's invariant, which the ENERGY-sync path
  // depends on: the sync burst must still cover detection + alignment + settle
  // + training, or that path trains on data.
  if (typeof ui.trainingSettleSymbols === 'number' && Number.isFinite(ui.trainingSettleSymbols)) {
    const maxSettle =
      OFDM_TUNING.syncBurstSymbols - OFDM_TUNING.syncMinFrames - 2 - OFDM_TUNING.trainingSymbols;
    config.trainingSettleSymbols = Math.max(0, Math.min(maxSettle, Math.round(ui.trainingSettleSymbols)));
  }

  return config;
}

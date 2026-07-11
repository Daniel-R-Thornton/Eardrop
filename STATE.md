# Eardrop — State Summary

**Branch**: `feat/ofdm-throughput-max`  
**Last commit**: `16cde2c` — feat(ui): net OFDM bitrate readout, hide no-op symbol rate, default 32 tones  
**Date**: 2026-07-11

---

## What works

### Acoustic transfer (BPSK, OFDM checkbox OFF)
- **4 tones, 25 sym/s, pilot at configurable freq** — confirmed working for file transfers
- All debug sweep tools functional (Audio Check, Full Sweep, Multi-Tone, Interference, Fine Sweep, Speed Sweep)

### Audio pipeline
- Hann-windowed 31-tap sinc FIR downsampler in AudioWorklet (48000→3200 Hz)
- Live mic gain slider (1-20×), playback volume slider (1-10×)
- AGC/noise suppression/echo cancellation force-disabled
- Resampled playback via linear interpolation when output rate != modem rate

### OFDM/QPSK (OFDM checkbox ON) — Throughput Max
- **Modulation**: Direct cosine synthesis, configurable tone count (default 32), QPSK per subcarrier, pilot at 1900 Hz (OFDM-scaled 2.0 amplitude)
- **Symbol**: 20 ms + 5 ms cyclic prefix = 25 ms total (~40 sym/s at any hardware rate)
- **Demodulation**: Goertzel / toneIQ bank at exact tone frequencies with per-tone channel equalization (amplitude + phase correction trained on sync burst)
- **Sample rate**: Native hardware rate (48000 / 44100 Hz) — no downsampling. Symbol adapts automatically to any sample rate via ceil(sampleRate * OFDM_SYMBOL_MS / 1000)
- **Sync**: 24-symbol burst (~600 ms), all tones QPSK 0°, detected via total tone energy threshold
- **Tone grid**: 2000-3550 Hz at 50 Hz spacing (32 tones default), pilot at 1900 Hz. All frequencies are multiples of 50 Hz for orthogonality with the 20 ms symbol
- **Frame format**: [SENTINEL 3B][BCH 24B][RS(52,40)×4 = 208B] = 235B carrying 160 payload B (68% payload density)
- **Cross-rate**: Encode at 48000 Hz, decode at 44100 Hz — verified working
- **Tuning**: All OFDM constants centralized in `OFDM_TUNING` in `types.ts`

### Key parameters (current)
| Parameter | Default | Notes |
|-----------|---------|-------|
| Sample rate | Hardware rate | 48000 or 44100 Hz, no downsampling for OFDM |
| Symbol length | 20 ms | Time-domain, adapts to any sample rate |
| CP length | 5 ms | ceil(sampleRate * 0.005) samples |
| Tone spacing | 50 Hz | Multiples of 50 Hz for orthogonality |
| Tone count | 32 | Configurable 8/16/32 |
| Pilot freq | 1900 Hz | Below data band (2000-3550 Hz at 32 tones) |
| Pilot amplitude | 2.0 (OFDM) | Previously used BPSK-scaled 0.4 — fixed |
| Net payload rate (32 tones) | ~1707 bps (166 B/s) | 2000-byte file benchmark |
| Raw bitrate (32 tones) | 2560 bps | 2 bits/tone × 32 tones / 0.025 s |

### Throughput benchmark (2000-byte file, 48 kHz)

| Config | 16 tones | 32 tones |
|--------|----------|----------|
| Baseline (45ms symbol, 79B frame) | 41.5 B/s | 80.8 B/s |
| + 4 RS blocks (235B frame) | 48.6 B/s | 92.6 B/s |
| + 20ms symbol (25ms total) | **87.4 B/s** | **166.7 B/s** |
| Overall gain vs baseline | ×2.1 | ×2.1 |

### Code organization
- `src/lib/` — 8 utility modules (math, encoding, crc, ecc, scan, protocol, debug, channel)
- `src/modem/` — modulation/, demodulation/, protocol/, dsp/, ecc/, pilot/, receiver/, channel/, debug/, test/
- `src/audio/` — dsp/, browser/, player.ts, recorder.ts, devices.ts
- `src/workers/` — encoder.worker.ts, broadcast.worker.ts, schema.ts
- `src/ui/` — MainApp.tsx, Store.ts, components/, controllers/, debug/, lib/, styles/

### Tests
- **115 tests total** (112 pass, 3 pre-existing failures)
- **All OFDM tests pass**: modulation, demodulation, loopback, sync, acoustic path, cross-rate, hum immunity, frame geometry V2, tuning invariants, pilot level, throughput benchmark
- 3 pre-existing failures: Doppler +2Hz, Doppler -1Hz, Full Stress (BPSK pipeline test — do not chase)

---

## Known issues

### OFDM acoustic status
- OFDM works in-memory (all tests pass)
- The pilot amplitude bug (buried pilot at 32 tones) is fixed — live acoustic path may now decode reliably at 32 tones
- **Live acoustic testing with real speaker/mic not yet performed for the new timing** — this is the next step

### OFDM tone count > 16
- 32-tone mode is now the default. Tested in-memory with the fix for pilot amplitude.

### Pre-existing BPSK pipeline failures
- Doppler +2Hz, Doppler -1Hz, Full Stress — BPSK-specific, not related to OFDM changes

---

## Files not to touch without careful testing
- `src/modem/protocol/preamble.ts` — warble timing is sensitive
- `src/modem/protocol/rxEngine.ts` — BPSK detection + calibration tightly coupled
- `src/modem/pilot.ts` — PLL Kp/Ki scaling is fragile
- `src/audio/recorder.ts` — Hann-sinc worklet is production-quality

## Key files for OFDM continuation
- `src/modem/modulation/OFDMQPSKModulator.ts` — Direct cosine synthesis modulator (native-rate)
- `src/modem/demodulation/OFDMQPSKDemodulator.ts` — Goertzel/toneIQ demod with per-tone channel equalization
- `src/modem/protocol/ofdmEngine.ts` — TX engine (sync burst, frame modulation)
- `src/modem/protocol/txEngine.ts` — TxEngine integration (OFDMEngine creation, pilot amplitude fix)
- `src/modem/protocol/rxEngine.ts` — RxEngine integration (OFDM detection, demod path)
- `src/modem/protocol/atomicFrame.ts` — Frame geometry (4 RS blocks, 235B frame, 160B payload)
- `src/modem/types.ts` — OFDM constants and tuning levers (OFDM_SYMBOL_MS, OFDM_TUNING, OFDM_DEFAULTS)

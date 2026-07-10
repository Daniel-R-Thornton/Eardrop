# Eardrop — State Summary

**Branch**: `main`  
**Last commit**: `455f379` — fix: add blocksDecoded/blocksCrcFailed to debug snapshot  
**Date**: 2026-07-09

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

### OFDM/QPSK (OFDM checkbox ON)
- **Modulation**: Direct cosine synthesis, configurable tone count (default 16), QPSK per subcarrier, pilot at fixed 1900 Hz
- **Symbol**: 40 ms + 5 ms cyclic prefix = 45 ms total (~22.22 sym/s at any hardware rate)
- **Demodulation**: Goertzel / toneIQ bank at exact tone frequencies with per-tone channel equalization (amplitude + phase correction trained on sync burst)
- **Sample rate**: Native hardware rate (48000 / 44100 Hz) — no downsampling. Symbol adapts automatically to any sample rate via ceil(sampleRate * OFDM_SYMBOL_MS / 1000)
- **Sync**: 24-symbol burst (~1.08 s at any rate), all tones QPSK 0°, detected via total tone energy threshold
- **Tone grid**: 2000-2750 Hz at 50 Hz spacing (16 tones default), pilot at 1900 Hz. All frequencies are multiples of 25 Hz for orthogonality with the 40 ms symbol
- **Cross-rate**: Encode at 48000 Hz, decode at 44100 Hz — verified working
- **In-memory**: All 13 tests pass (modulation, demodulation, loopback, sync, acoustic path, cross-rate, hum immunity)
- **Acoustic testing pending**: Live mic/speaker verification (Task 9)

### Key parameters (current)
| Parameter | Default | Notes |
|-----------|---------|-------|
| Sample rate | Hardware rate | 48000 or 44100 Hz, no downsampling for OFDM |
| Symbol length | 40 ms | Time-domain, adapts to any sample rate |
| CP length | 5 ms | ceil(sampleRate * 0.005) samples |
| Tone spacing | 50 Hz | Multiples of 25 Hz for orthogonality |
| Tone count | 16 | Configurable 8/16/32 |
| Pilot freq | 1900 Hz | Below data band (2000-2750 Hz at 16 tones) |
| Raw bitrate (16 tones) | 711 bps | 2 bits/tone × 16 tones / 0.045 s |
| Raw bitrate (32 tones) | 1422 bps | 2 bits/tone × 32 tones / 0.045 s |

### Code organization
- `src/lib/` — 8 utility modules (math, encoding, crc, ecc, scan, protocol, debug, channel)
- `src/modem/` — modulation/, demodulation/, protocol/, dsp/, ecc/, pilot/, receiver/, channel/, debug/, test/
- `src/audio/` — dsp/, browser/, player.ts, recorder.ts, devices.ts
- `src/workers/` — encoder.worker.ts, broadcast.worker.ts, schema.ts
- `src/ui/` — MainApp.tsx, Store.ts, components/, controllers/, debug/, lib/, styles/

### Tests
- **90 tests total** (87 pass, 3 pre-existing failures)
- **13 OFDM-specific tests** — all pass (modulation, demodulation, loopback, sync, full frame)
- 3 failures: Doppler +2Hz, Doppler -1Hz, Full Stress (pipeline test, pre-existing)

---

## Known issues

### OFDM acoustic status
- OFDM works perfectly in-memory (all 13 tests pass: modulation, demodulation, loopback, sync, acoustic path, cross-rate, hum immunity)
- Per-tone channel equalization (amplitude + phase correction trained on sync burst) is implemented and verified in-memory
- Acoustic testing with live mic/speaker not yet performed (blocked on Task 9)

### OFDM tone count > 16
- 32-tone mode is configurable (1422 bps raw bitrate) but untested acoustically
- The nibble-based bit packing in the sentinel scanner adapts automatically to any tone count (every 2 frame bits → 1 byte)

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
- `src/modem/protocol/txEngine.ts` — TxEngine integration (useOFDM flag, OFDMEngine creation)
- `src/modem/protocol/rxEngine.ts` — RxEngine integration (OFDM detection, demod path)
- `src/modem/ofdm.ts` — Native-rate OFDM constants and tone frequency generation

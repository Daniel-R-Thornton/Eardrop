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
- **Modulation**: 256-point IFFT, configurable tone count (2/4/8), QPSK per subcarrier, pilot carrier at pilotFreqHz bin
- **Cyclic prefix**: 16 samples (5ms guard interval) — enabled on both TX and RX
- **Symbol size**: 272 samples (256 FFT + 16 CP) → ~11.76 sym/s
- **Demodulation**: 256-point FFT, CP discarded, pilot-phase correction (all tones rotated by pilot bin phase)
- **Sync**: OFDM sync burst (24 identical symbols, all QPSK 0°) detected via total tone energy threshold
- **Sentinel compatibility**: Nibble-based bit packing matches BPSK frame format for sentinel scanner
- **Acoustic**: Works intermittently — frequency-selective phase rotation causes some symbols to land in wrong QPSK quadrant. The 16-sample CP helps with timing alignment but doesn't fix per-tone phase rotation

### Key parameters (current)
| Parameter | Default | Notes |
|-----------|---------|-------|
| Sample rate | 3200 Hz | Modem rate |
| FFT size | 256 | Fixed for OFDM |
| CP length | 16 samples | 5ms guard interval |
| SYM length | 272 samples | FFT + CP |
| Tone count | 4 | Configurable 2/4/8 |
| Pilot freq | 487.5 Hz | Configurable via UI slider |

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

### OFDM acoustic instability
- OFDM works perfectly in-memory (13/13 tests pass) but acoustically only some frames decode correctly
- Root cause: **frequency-selective phase rotation** — the pilot-phase correction rotates all tones by the pilot's measured phase, but each tone experiences a different phase shift through the acoustic channel (due to timing offsets, multipath, mic/speaker frequency response)
- The 16-sample CP fixes symbol-level timing but doesn't fix per-tone phase rotation
- Possible solutions (not yet implemented):
  1. **Per-tone channel equalization** — train on sync burst to measure per-tone phase, apply per-tone correction to data symbols (was partially implemented but had magnitude issues with earlier code)
  2. **Differential QPSK** — encode bits as phase changes between consecutive symbols instead of absolute phase, eliminates need for phase reference
  3. **Increase CP + add timing recovery** — use CP autocorrelation to find exact symbol boundary (currently just uses energy threshold)

### OFDM tone count > 4
- 8-tone mode is implemented in OFDMEngine but untested acoustically
- The sentinel scanner's byte packing assumes 4-tone structure for the bchBuf (2 frameBits → 1 byte). For 8 tones, each OFDM symbol produces 4 frameBits → 2 bytes. The RxEngine doesn't handle this yet.

### OFDM symbol rate scaling
- Current OFDM uses fixed 256-FFT (272 samples with CP) regardless of UI symbol rate
- The modulator and demodulator accept variable `fftSize` from config
- The `selectOFDMFFT()` function in `src/lib/math/index.ts` maps UI symbol rates to FFT sizes (10→256, 25→128, 50→64, 100→32)
- The TxEngine/RxEngine OFDM creation used this mapping but it was rolled back due to acoustic issues
- To re-enable: set `fftSize` and `sps` from `selectOFDMFFT()` for OFDM mode, match on both TX and RX

### The "worked before" mystery
- OFDM with pilot-phase correction briefly worked acoustically (user confirmed file download) after the initial nibble-based bit packing fix
- It broke when symbol-rate-dependent FFT scaling was introduced, and reverted versions haven't reproduced the working state
- Hypothesis: the working case had some fortuitous combination of gain/pilot-freq/speaker-position that minimized frequency-selectivity. Not reproducible deterministically.

---

## Files not to touch without careful testing
- `src/modem/protocol/preamble.ts` — warble timing is sensitive
- `src/modem/protocol/rxEngine.ts` — BPSK detection + calibration tightly coupled
- `src/modem/pilot.ts` — PLL Kp/Ki scaling is fragile
- `src/audio/recorder.ts` — Hann-sinc worklet is production-quality

## Key files for OFDM continuation
- `src/modem/modulation/OFDMQPSKModulator.ts` — IFFT-based modulator
- `src/modem/demodulation/OFDMQPSKDemodulator.ts` — FFT-based demod with pilot-phase correction
- `src/modem/protocol/ofdmEngine.ts` — TX engine (sync burst, frame modulation)
- `src/modem/protocol/txEngine.ts` — TxEngine integration (useOFDM flag, OFDMEngine creation)
- `src/modem/protocol/rxEngine.ts` — RxEngine integration (OFDM detection, demod path)
- `src/lib/math/index.ts` — contains `selectOFDMFFT()`, `makeToneOffsets()`, `makeToneFrequencies()`

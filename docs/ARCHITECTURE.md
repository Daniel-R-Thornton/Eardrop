# Eardrop — Architecture

## Overview

Eardrop transfers files over audio using two physical layers: BPSK and OFDM/QPSK. The current UI sends commands to a unified modem worker, which then drives the transmit/receive engine that matches the selected mode.

## Runtime flow

### 1. UI and config

The React UI in `src/ui/` gathers user input, file selection, device choice, and debug preferences. The single place where UI settings become a modem config is `src/ui/controllers/buildModemConfig.ts`, which builds the config handed to the worker.

### 2. Worker boundary

The app no longer uses separate encoder and broadcast workers. Instead, `src/workers/modem.worker.ts` hosts a `ModemService` instance from `src/workers/modemService.ts`.

- `configure` creates or reinitializes the receiver and configures the worker state.
- `startRx` and `stopRx` start or stop the receiver lifecycle.
- `encodeFile` creates a `TxEngine` and returns encoded audio.
- `feedChunk` streams mic audio into `RxEngine.feedChunk()`.
- `tick()` emits telemetry snapshots at roughly 20 Hz.

### 3. Modem implementation

The worker uses the core modem stack in `src/modem/`:

- `TxEngine` handles file-level transmission and dispatches to either BPSK or OFDM.
- `RxEngine` handles file-level reception and dispatches to the matching demodulator.
- `OFDMEngine` and `OFDMQPSKModulator` implement the native-rate OFDM transmit path.
- `OFDMQPSKDemodulator` performs Goertzel/toneIQ demodulation with per-tone equalization and pilot-referenced drift correction.

## Signal flow

### BPSK path

```text
Main UI → modem.worker.ts → ModemService → TxEngine/RxEngine → BPSKModulator / PilotPLL / toneIQ
```

The BPSK path uses the older production-style preamble and atomic framing. It remains the more mature acoustic path and is still used when OFDM is not enabled.

### OFDM/QPSK path

```text
Main UI → modem.worker.ts → ModemService → TxEngine/RxEngine → OFDMEngine / OFDMQPSKModulator / OFDMQPSKDemodulator
```

The OFDM path uses native hardware-rate audio, a sync burst, cyclic-prefix alignment, per-tone equalization, and atomic frame decoding. The current defaults are centered around 32 tones at 50 Hz spacing in the 2–4 kHz band.

## Repository layout

```text
src/
├── audio/          # recorder/player/device handling
├── lib/            # shared math/encoding/crc/ecc/protocol/debug helpers
├── modem/          # core modem algorithms and protocol state machines
├── ui/             # React UI, stores, controllers, and debug panels
└── workers/        # modem worker entrypoint, schema, and service wrapper
```

## Design notes

- The modem config is intentionally centralized in `src/modem/types.ts` and `src/ui/controllers/buildModemConfig.ts` to avoid mismatches between the UI and worker.
- The OFDM path uses a sync-once-then-coast timing model rather than per-symbol timing tracking.
- The debug and telemetry stack uses `dlog()` from `src/lib/debug/dlog.ts` so the app can surface structured logs without spamming the console.
- **RX**: `RxEngine.feedSample() → OFDMQPSKDemodulator` (Goertzel/toneIQ per tone)

**Key architectural properties:**
- No FFT/IFFT — exact tone frequencies via trigonometric synthesis/analysis
- Time-domain symbols (20ms + 5ms CP) adapt to any hardware sample rate
- Channel equalization is per-tone (amplitude + phase), trained on sync burst
- No per-symbol timing tracking — CP correlation at sync, then fixed stride
- Pilot-referenced phase drift correction handles clock skew

### Self-Framing Blocks (Encoder/Decoder)

Every logical unit is wrapped: `[0xE79FE7][TYPE][LEN][DATA][CRC16]`. The `FramedBlockDecoder` uses a 24-bit sliding shift register to find block boundaries at any bit offset. CRC verification discards corrupted blocks.

### Atomic Frames V2 (TxEngine/RxEngine OFDM)

Every frame is 235 bytes: `[0xE79FE7:3B][BCH_HEADER:24B][RS_PAYLOAD:208B]`. Contains 4 × RS(52,40) blocks = 160 data bytes per frame. The sentinel scanner uses Hamming distance ≤2 for robust matching. BPSK uses the legacy V1 format (79 bytes, single RS block).

### Diversity Mode

Optional 3× frame repetition. Transmitter sends each frame 3 times consecutively. Receiver deduplicates by fileID (headers) and sequence number (payloads). Provides redundancy without requiring voting/consensus logic.

### Error Correction

Two-tier ECC in the production path:
1. **BCH(63,30) × 3** on header: corrects up to 3 bit errors per 30-bit data block. Protects frame type, sequence number, and CRC.
2. **RS(52,40) × 4** on payload: corrects up to 6 byte errors per 40-byte block (×4 = 24 byte errors total per frame).

## Throughput

```
BPSK (SPS=256):
  Raw:          4 bits/sym × 25 sym/s = 100 bit/s
  Framing:      40 data bytes / 79 frame bytes = 50.6% efficiency → ~50 data bit/s
  Diversity:    ÷3 when enabled → ~17 data bit/s

OFDM 16-tone (native rate):
  Raw:          32 bits/sym × 40 sym/s = 1280 bit/s
  Framing:      160 data bytes / 235 frame bytes = 68% efficiency → ~870 bit/s
  Net:          ~87 B/s

OFDM 32-tone (native rate):
  Raw:          64 bits/sym × 40 sym/s = 2560 bit/s
  Framing:      160 data bytes / 235 frame bytes = 68% efficiency → ~1740 bit/s
  Net:          ~167 B/s
```

## Debug Output

All runtime debug output goes through `dlog()` (`src/lib/debug/dlog.ts`) — one line per event in `[TAG] key=value` format. See `docs/DEBUG-OUTPUT.md` for the full tag reference and healthy value ranges. The production path uses tags like `OFDM-SYNC`, `OFDM-TRAIN`, `OFDM-DEMOD`, `RX-FRAME`, `TX-OFDM`. The self-test path uses tags like `[PILOT]`, `[PLL]`, `[SYNC]`, `[FRAME]`, `[BLK]`, `[BER]`, `[ECC]` documented in `docs/LLM_PROMPT.md`.

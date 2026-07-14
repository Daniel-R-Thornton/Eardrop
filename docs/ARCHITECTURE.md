# Eardrop — Architecture

## Overview

Eardrop transfers files over audio using two physical layers: **BPSK** (4 tones, production-proven) and **OFDM/QPSK** (N-tone, native-rate, high throughput). Both share a continuous pilot tone as phase/amplitude reference. Two protocol stacks share the BPSK modulation layer: a simpler Encoder/Decoder path (self-test, loopback) and a production TxEngine/RxEngine path (actual file transfer via workers). The OFDM path uses the production TxEngine/RxEngine with a different modulation/demodulation backend.

## Signal Flow

### Production Path — BPSK

```
┌─ TxEngine → RxEngine (BPSK) ──────────────────────────────────────┐
│                                                                      │
│  TxEngine.transmitFile()                                             │
│    ├── generatePreamble()      Warble + marker + Gray cal + guard    │
│    └── transmitFrame() × N     79B atomic frames (BCH header + RS)   │
│                                                                      │
│                              ↓ audio (3200 Hz sample rate)           │
│                                                                      │
│  RxEngine.feedSample()                                              │
│    ├── WAITING state     Warble detection (code correlation)         │
│    ├── PREAMBLE state    Marker → Gray code calibration → guard      │
│    ├── FRAMES state      DBPSK demodulation → sentinel scanner       │
│    └── COMPLETE state    File assembled, available via getFile()     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### Production Path — OFDM/QPSK

```
┌─ TxEngine → RxEngine (OFDM/QPSK) ──────────────────────────────────┐
│                                                                      │
│  TxEngine (OFDMEngine)                                              │
│    ├── generateSyncBurst(24)   All tones at QPSK 0° (~600 ms)      │
│    └── modulateFrame() × N     235B V2 frames (BCH + 4×RS blocks)   │
│         via OFDMQPSKModulator (direct cosine synthesis)              │
│                                                                      │
│                              ↓ audio (native rate: 48000/44100 Hz)   │
│                                                                      │
│  RxEngine.feedSample()                                              │
│    ├── WAITING state     Tone-energy sync detection + CP correlation │
│    ├── FRAMES state      OFDMQPSKDemodulator                        │
│    │    ├── Per-tone Goertzel (toneIQ)                              │
│    │    ├── Pilot-referenced phase drift correction                  │
│    │    ├── Decision-directed per-tone channel tracking              │
│    │    ├── QPSK hard decision → nibble packing                     │
│    │    └── Sentinel scanner → frame decode                         │
│    └── COMPLETE state    File assembled                              │
│                                                                      │
│  Note: No per-symbol timing tracking — sync-once, CP absorbs drift  │
└──────────────────────────────────────────────────────────────────────┘
```

### Self-Test Path — BPSK

```
┌─ Encoder → Decoder (BPSK) ─────────────────────────────────────────┐
│                                                                      │
│  Encoder.encode()                                                    │
│    ├── Leader (pilot-only)                                           │
│    ├── Sync (all tones ON)                                           │
│    ├── Calibrate (one tone at a time)                                │
│    └── Data (self-framing blocks)                                    │
│                                                                      │
│                              ↓ audio (3200 Hz)                       │
│                                                                      │
│  Decoder.feedSample()                                                │
│    ├── Preamble detection (frame counting)                           │
│    ├── Calibration (global phase flip)                               │
│    ├── BPSK bit detection (raw I sign)                               │
│    └── FramedBlockDecoder → BlockProcessor → file                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Module Dependency Graph

```
src/
├── modem/
│   ├── types.ts              ← ModemConfig, TONE_OFFSETS, OFDM constants
│   │
│   ├── dsp/
│   │   ├── oscillator.ts     ← Shared PhaseAcc (sin-then-increment contract)
│   │   ├── dsp.ts            ← FFT, spectrogram utilities
│   │   └── noise.ts          ← Noise floor estimation
│   │
│   ├── pilot/
│   │   ├── index.ts          ← Re-exports: toneIQ(), getDataToneFreqs()
│   │   └── PilotTracker.ts   ← Pilot amplitude/phase tracker
│   ├── pilot.ts              ← Legacy PilotPLL (2nd-order), toneIQ() correlator
│   │
│   ├── modulation/
│   │   ├── BPSKModulator.ts  ← BPSK tone generator (used by preamble.ts)
│   │   ├── OFDMQPSKModulator.ts ← Direct cosine synthesis OFDM modulator
│   │   └── index.ts
│   │
│   ├── demodulation/
│   │   ├── OFDMQPSKDemodulator.ts ← Goertzel/toneIQ OFDM demod + equalization
│   │   └── index.ts
│   │
│   ├── protocol/
│   │   ├── encoder.ts        ← Encoder (self-test path, SPS=128)
│   │   ├── decoder.ts        ← Decoder (self-test path, self-framing blocks)
│   │   ├── framing.ts        ← Block encoder, FramedBlockDecoder (sentinel scanner)
│   │   ├── blockProcessor.ts ← Block dispatch, file assembly
│   │   ├── preamble.ts       ← BPSK production preamble generator (warble + cal)
│   │   ├── txEngine.ts       ← Production transmitter (BPSK + OFDMEngine)
│   │   ├── rxEngine.ts       ← Production receiver (BPSK DBPSK + OFDM/QPSK)
│   │   ├── ofdmEngine.ts     ← OFDM TX engine (sync burst, frame modulation)
│   │   ├── atomicFrame.ts    ← Atomic frame V2 encode/decode (BCH+RS + 4×RS blocks)
│   │   ├── squawk.ts         ← BPSK squawk calibration (legacy)
│   │   └── index.ts
│   │
│   ├── ecc/
│   │   ├── ecc.ts            ← BCH(31,16) for self-test path
│   │   ├── bch63.ts          ← BCH(63,30) for production path
│   │   ├── reedsolomon.ts    ← RS(52,40) for production path
│   │   └── index.ts
│   │
│   ├── receiver/
│   │   ├── SentinelScanner.ts ← 24-bit sentinel scanner (BPSK + OFDM shared)
│   │   ├── PreambleDetector.ts ← BPSK preamble detector (warble + cal)
│   │   ├── NoiseProfiler.ts  ← Noise floor profiling
│   │   └── index.ts
│   │
│   ├── channel/
│   │   ├── channel.ts        ← Channel simulator (AWGN, echo, Doppler, hum)
│   │   └── index.ts
│   │
│   ├── debug/
│   │   ├── debugger.ts       ← Per-stage structured logging
│   │   ├── diag.ts           ← State snapshots, BER tracker
│   │   ├── visualizer.ts     ← Canvas debug visualizer (legacy)
│   │   ├── compressForLLM.ts ← LLM-compressed debug output
│   │   ├── dictionary.ts     ← Compression dictionaries
│   │   ├── dictionary_data.ts ← Precomputed dictionary tables
│   │   ├── rtcp.ts           ← Real-time control protocol (debug diagnostics)
│   │   └── index.ts
│   │
│   ├── test/
│   │   ├── loopback.test.ts  ← Encoder→Decoder loopback
│   │   ├── pipeline.test.ts  ← Encoder→Decoder + channel sim
│   │   ├── production.test.ts ← TxEngine→RxEngine
│   │   ├── diversity.test.ts ← 3× repetition tests
│   │   ├── ofdm_*.test.ts    ← 8 OFDM test files (sync, loopback, end-to-end, etc.)
│   │   ├── atomicFrameV2.test.ts ← Frame geometry tests
│   │   ├── tuning.test.ts    ← OFDM tuning constraint tests
│   │   └── ... (20 test files total)
│   │
│   └── index.ts
│
├── lib/
│   ├── debug/
│   │   └── dlog.ts           ← Structured logging: dlog(), dlogDump(), rate limiting
│   ├── math/
│   │   └── index.ts          ← Math utilities
│   ├── ecc/
│   │   └── index.ts          ← ECC utility re-exports
│   ├── encoding/
│   │   └── index.ts          ← Encoding helpers
│   ├── crc/
│   │   └── index.ts          ← CRC helpers
│   ├── protocol/
│   │   └── index.ts          ← Protocol utility re-exports
│   ├── channel/
│   │   └── index.ts          ← Channel utility re-exports
│   └── scan/
│       └── index.ts          ← Scan utility re-exports
│
├── workers/
│   ├── modem.worker.ts       ← Web worker entry (runs modemService)
│   ├── modemService.ts       ← ModemService: manages TxEngine/RxEngine lifecycle
│   ├── modemSchema.ts        ← Worker message protocol schemas
│   ├── encoder.worker.ts     ← Legacy worker (TxEngine only)
│   └── broadcast.worker.ts   ← Legacy worker (RxEngine only)
│
├── audio/
│   ├── recorder.ts           ← Mic capture via AudioWorklet (Hann-sinc downsampler)
│   ├── player.ts             ← Audio playback (linear interpolation resampler)
│   ├── devices.ts            ← Device enumeration
│   ├── index.ts
│   └── browser/
│       └── index.ts
│
├── ui/
│   ├── app.ts                ← Main UI thread, worker management
│   ├── Store.ts              ← Central state store
│   ├── react.ts              ← React mount point
│   ├── telemetryStore.ts     ← Real-time telemetry storage
│   ├── controllers/
│   │   ├── modemController.ts ← Modem lifecycle controller
│   │   ├── buildModemConfig.ts ← Config builder from UI state
│   │   ├── selfTest.ts       ← Self-test controller
│   │   └── index.ts
│   ├── lib/
│   │   ├── colors.ts         ← Tone color mapping
│   │   ├── formatters.ts     ← Data formatting helpers
│   │   └── index.ts
│   ├── debug/
│   │   └── hooks/useDecoderState.ts ← Debug panel state hook
│   └── styles/
│       ├── tokens.ts         ← Design tokens
│       └── index.ts
│
├── crc32.ts                  ← CRC-32 utility (shared)
├── hamming.ts                ← Hamming(7,4) code (legacy)
└── protocol.ts               ← Preamble packet format (legacy, very old)
```

## Key Design Decisions

### Phase Contract (sin-then-increment)

All tone generation uses the shared `PhaseAcc` oscillator (`modem/dsp/oscillator.ts`). The contract is:

```typescript
advance(freqHz, sampleRate): number {
    const v = Math.sin(2π · phase);  // sin at CURRENT phase
    phase += freqHz / sampleRate;     // then advance
    return v;
}
```

The decoder's `toneIQ()` correlates with `sin(ωn)` starting at `n=0`. Since both encoder and decoder use the same reference origin, **0° BPSK always gives positive I for all tones**, eliminating the need for per-tone phase calibration.

### Two Physical Layers

| Aspect | BPSK | OFDM/QPSK |
|--------|------|-----------|
| Sample rate | 3200 Hz (downsampled) | Native (48000/44100 Hz) |
| Symbol rate | 25 sym/s | ~40 sym/s |
| Tones | 4 (configurable 2) | 8/16/32 |
| Bits/sym | 4 | 2× toneCount (QPSK) |
| Demodulation | PilotPLL + DBPSK | toneIQ bank + channel equalization |
| Sync | Warble code detection | Tone energy + CP correlation |
| Pilot freq | 600 Hz (configurable) | 1900 Hz (fixed) |
| RX timing | Fixed SPS stride | Sync-once, CP drift guard |

### Two Protocol Stacks (BPSK)

The Encoder/Decoder and TxEngine/RxEngine paths are separate implementations sharing the modulation layer. Key differences:

| Aspect | Encoder/Decoder | TxEngine/RxEngine |
|--------|----------------|-------------------|
| SPS | 128 | 256 |
| Preamble | Leader→sync→calibrate→data | Warble→marker→Gray cal→guard→data |
| Framing | Self-framing blocks (sentinel scanner) | Atomic frames V1 (79B) or V2 (235B) |
| Demodulation | Raw I sign (absolute BPSK) | DBPSK (dot product) + centroid fallback |
| Calibration | Global phase flip | Gray code centroid averaging |
| ECC | BCH(31,16) + interleaver | BCH(63,30) + RS(52,40)×1 or ×4 |

Both paths exist because they serve different purposes — the Encoder/Decoder is the older tested reference, while TxEngine/RxEngine is the production system with more features (warble preamble, atomic frames, stronger ECC, diversity mode, OFDM).

### OFDM Architecture

The OFDM path reuses the production TxEngine/RxEngine frame pipeline (atomic frames V2, sentinel scanner) but replaces the modulation/demodulation backend:

- **TX**: `TxEngine → OFDMEngine → OFDMQPSKModulator` (direct cosine synthesis)
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

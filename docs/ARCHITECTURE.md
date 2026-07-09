# Eardrop — Architecture

## Overview

Eardrop transfers files over audio using BPSK on 4 data tones with a continuous pilot reference. The modem has two protocol stacks sharing the same modulation layer: a simpler Encoder/Decoder path (self-test, loopback) and a production TxEngine/RxEngine path (actual file transfer via workers).

## Signal Flow

```
┌─ Production Path (TxEngine → RxEngine) ────────────────────────────┐
│                                                                      │
│  TxEngine.transmitFile()                                             │
│    ├── generatePreamble()      Warble + marker + Gray cal + guard    │
│    └── transmitFrame() × N     Atomic frames (BCH header + RS data)  │
│                                                                      │
│                              ↓ audio                                 │
│                                                                      │
│  RxEngine.feedSample()                                              │
│    ├── WAITING state     Warble detection (code correlation)         │
│    ├── PREAMBLE state    Marker → Gray code calibration → guard      │
│    ├── FRAMES state      DBPSK demodulation → sentinel scanner       │
│    └── COMPLETE state    File assembled, available via getFile()     │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘

┌─ Self-Test Path (Encoder → Decoder) ────────────────────────────────┐
│                                                                      │
│  Encoder.encode()                                                    │
│    ├── Leader (pilot-only)                                           │
│    ├── Sync (all tones ON)                                           │
│    ├── Calibrate (one tone at a time)                                │
│    └── Data (self-framing blocks)                                    │
│                                                                      │
│                              ↓ audio                                 │
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
│   ├── oscillator.ts     ← Shared PhaseAcc (sin-then-increment contract)
│   ├── types.ts          ← ModemConfig, TONE_OFFSETS, constants
│   ├── pilot.ts          ← PilotPLL (2nd-order), toneIQ() correlator
│   ├── encoder.ts        ← Encoder (self-test path, SPS=128)
│   ├── decoder.ts        ← Decoder (self-test path, self-framing blocks)
│   ├── framing.ts        ← Block encoder, FramedBlockDecoder (sentinel scanner)
│   ├── blockProcessor.ts ← Block dispatch, file assembly
│   ├── preamble.ts       ← Production preamble generator (warble + cal)
│   ├── txEngine.ts       ← Production transmitter (atomic frames, SPS=256)
│   ├── rxEngine.ts       ← Production receiver (DBPSK, sentinel scanner, SPS=256)
│   ├── atomicFrame.ts    ← Atomic frame encode/decode (BCH+RS)
│   ├── ecc.ts            ← BCH(31,16) for self-test path
│   ├── bch63.ts          ← BCH(63,30) for production path
│   ├── reedsolomon.ts    ← RS(52,40) for production path
│   ├── channel.ts        ← Channel simulator (AWGN, echo, Doppler, etc.)
│   ├── debugger.ts       ← Per-stage structured logging
│   ├── diag.ts           ← State snapshots, BER tracker
│   ├── compressForLLM.ts ← LLM-compressed debug output
│   ├── dictionary.ts     ← Compression dictionaries
│   ├── dsp.ts            ← FFT, spectrogram utilities
│   └── visualizer.ts     ← Canvas debug visualizer (legacy)
├── workers/
│   ├── encoder.worker.ts ← TxEngine in web worker
│   └── broadcast.worker.ts ← RxEngine in web worker
├── audio/
│   ├── player.ts         ← Audio playback
│   ├── recorder.ts       ← Mic capture via AudioWorklet
│   ├── devices.ts        ← Device enumeration
│   └── resampler.ts      ← Sample rate conversion
├── ui/
│   ├── app.ts            ← Main UI thread, worker management
│   ├── react.ts          ← React mount point
│   └── debug/            ← React debug panels
├── protocol.ts           ← Preamble packet format (legacy)
└── crc32.ts              ← CRC-32 utility
```

## Key Design Decisions

### Phase Contract (sin-then-increment)

All tone generation uses the shared `PhaseAcc` oscillator (`oscillator.ts`). The contract is:

```typescript
advance(freqHz, sampleRate): number {
    const v = Math.sin(2π · phase);  // sin at CURRENT phase
    phase += freqHz / sampleRate;     // then advance
    return v;
}
```

The decoder's `toneIQ()` correlates with `sin(ωn)` starting at `n=0`. Since both encoder and decoder use the same reference origin, **0° BPSK always gives positive I for all tones**, eliminating the need for per-tone phase calibration.

### Two Protocol Stacks

The Encoder/Decoder and TxEngine/RxEngine paths are separate implementations sharing the modulation layer. Key differences:

| Aspect | Encoder/Decoder | TxEngine/RxEngine |
|--------|----------------|-------------------|
| SPS | 128 | 256 |
| Preamble | Leader→sync→calibrate→data | Warble→marker→Gray cal→guard→data |
| Framing | Self-framing blocks (sentinel scanner) | Atomic frames (BCH header + RS payload) |
| Demodulation | Raw I sign (absolute BPSK) | DBPSK (dot product) + centroid fallback |
| Calibration | Global phase flip | Gray code centroid averaging |
| ECC | BCH(31,16) + interleaver | BCH(63,30) + RS(52,40) |
| Test coverage | 12/12 loopback, 17/20 pipeline | 4/4 production, 3/3 diversity |

Both paths exist because they serve different purposes — the Encoder/Decoder is the tested reference implementation, while TxEngine/RxEngine is the production system with more features (warble preamble, atomic frames, stronger ECC, diversity mode).

### Self-Framing Blocks (Encoder/Decoder)

Every logical unit is wrapped: `[0xE79FE7][TYPE][LEN][DATA][CRC16]`. The `FramedBlockDecoder` uses a 24-bit sliding shift register to find block boundaries at any bit offset. CRC verification discards corrupted blocks.

### Atomic Frames (TxEngine/RxEngine)

Every frame is 79 bytes: `[0xE79FE7:3B][BCH_HEADER:24B][RS_PAYLOAD:52B]`. The sentinel scanner uses Hamming distance ≤2 for robust matching in noisy conditions. Frames carry sequence numbers for diversity-mode deduplication.

### Diversity Mode

Optional 3× frame repetition. Transmitter sends each frame 3 times consecutively. Receiver deduplicates by fileID (headers) and sequence number (payloads). Provides redundancy without requiring voting/consensus logic.

### Error Correction

Two-tier ECC in the production path:
1. **BCH(63,30) × 3** on header: corrects up to 3 bit errors per 30-bit data block. Protects frame type, sequence number, and CRC.
2. **RS(52,40)** on payload: corrects up to 6 byte errors per 40-byte block.

## Throughput

```
Production path (SPS=256):
  Raw:          4 bits/sym × 25 sym/s = 100 bit/s
  Framing:      40 data bytes / 79 frame bytes = 50.6% efficiency → ~50 data bit/s
  Diversity:    ÷3 when enabled → ~17 data bit/s
  
Self-test path (SPS=128):
  Raw:          4 bits/sym × 25 sym/s = 100 bit/s
  BCH(31,16):   51.6% efficiency → ~52 data bit/s
  Framing:      ~7 bytes overhead per block → ~40-50 data bit/s
```

**Typical**: 5-6 byte/s for production path, ~5 byte/s for self-test path.

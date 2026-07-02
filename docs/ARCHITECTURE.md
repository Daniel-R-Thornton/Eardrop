# Eardrop — Architecture

## Overview

Eardrop transfers files over audio using a pilot-relative multi-tone modem. The modem encodes data into 4 simultaneous tones (offset from a configurable pilot frequency), and the decoder recovers data by discovering the pilot frequency, tracking its phase via PLL, and measuring all data tones relative to it.

## Signal Flow

```
┌─ Encoder ──────────────────────────────────────────────────────────┐
│  raw bytes → BCH(31,16) → interleave → frame blocks                │
│    → [SENTINEL|TYPE|LEN|DATA|CRC] → pilot + 4 tones → float32 audio│
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (speaker → air → mic)
                              │
┌─ Decoder ──────────────────────────────────────────────────────────┐
│  float32 audio → PilotScanner (FFT 40-120Hz) → discover pilot freq │
│    → PilotPLL (2nd-order PLL, phase tracking)                       │
│    → per-frame: I/Q at each tone → rotate by pilot phase           │
│    → extract 8 bits (amp0 phase0 amp1 phase1 amp2 phase2 amp3 phase3)│
│    → FramedBlockDecoder (bit-level sentinel scanner)               │
│    → BlockProcessor (dispatch by type: CONFIG/PAYLOAD/DICT/EOF)    │
│    → deinterleave → BCH(31,16) decode → file bytes                │
└────────────────────────────────────────────────────────────────────┘
```

## Module Dependency Graph

```
src/
├── modem/
│   ├── types.ts          ← ModemConfig, TONE_OFFSETS, helpers
│   ├── pilot.ts          ← PilotScanner (FFT), PilotPLL (2nd-order)
│   ├── encoder.ts        ← Encoder (pilot + BPSK tones)
│   ├── decoder.ts        ← Decoder (pilot-relative I/Q, framing, block processor)
│   ├── framing.ts        ← encodeBlock(), FramedBlockDecoder (sentinel scanner)
│   ├── blockProcessor.ts ← BlockProcessor (block dispatch, file assembly)
│   ├── ecc.ts            ← BCH(31,16) encode/decode, interleaver (Phase F)
│   ├── squawk.ts         ← Squawk calibration (Phase D)
│   ├── channel.ts        ← Channel simulator (Phase E)
│   ├── debugger.ts       ← Per-stage structured logging (Phase C)
│   ├── diag.ts           ← State snapshots, BER tracker (Phase C)
│   ├── compressForLLM.ts ← LLM-compressed output (Phase C)
│   ├── dictionary.ts     ← Compression dictionaries (Phase G)
│   ├── dsp.ts            ← FFT, spectrogram utilities
│   └── visualizer.ts     ← Canvas debug visualizer (legacy)
├── workers/
│   ├── encoder.worker.ts ← Encoder in web worker
│   └── broadcast.worker.ts ← Decoder in web worker
├── audio/
│   ├── player.ts         ← Audio playback
│   ├── recorder.ts       ← Mic capture via AudioWorklet
│   ├── devices.ts        ← Device enumeration
│   └── resampler.ts      ← Sample rate conversion
├── ui/
│   ├── app.ts            ← Main UI thread, worker management
│   ├── react.ts          ← React mount point
│   └── debug/            ← React debug panels (Phase I)
├── protocol.ts           ← Preamble format (legacy, replaced by framed CONFIG blocks)
└── crc32.ts              ← CRC-32 for payload verification
```

## Key Design Decisions

### Pilot-Relative Measurement
- Pilot frequency is **configurable** (default 62.5 Hz), not hardcoded
- Decoder **discovers** pilot frequency via FFT scan (40-120 Hz, 2048-point zero-padded)
- PilotPLL (2nd-order) tracks phase continuously
- All tone measurements are rotated by pilot phase → cancels Doppler, echo, volume differences

### Self-Framing Blocks
- Every logical unit is wrapped: `[0xE79F][TYPE][LEN][DATA][CRC16]`
- Bit-level sentinel scanner finds block boundaries without symbol alignment
- CRC verification ensures corrupted blocks are silently discarded
- Block types: SQUAWK(0x01), CONFIG(0x02), DICT(0x03), PAYLOAD(0x04), EOF(0xFF)

### Squawk Calibration
- Periodic calibration beacons every N data symbols (default 32)
- Carry known reference I/Q points → decoder measures actual vs expected
- Computes phase correction, AGC gain, per-tone threshold refresh
- Keeps the link solid through temperature drift, movement, volume changes

### Error Correction
- BCH(31,16): corrects up to 3 bit errors per 31-bit codeword
- Block interleaver depth 8: spreads burst errors across multiple codewords
- Rate 0.52 (same overhead as Hamming(7,4) but far more correction power)

## Throughput

```
Raw:         8 bits/sym × 25 sym/s = 200 bit/s
ECC (0.52):  ~104 data bit/s
Framing:     ~80 data bit/s (7 bytes overhead per ~13 byte payload)
Squawks:     ~64 data bit/s (20% overhead)
Dictionary:  ~80-100 data bit/s (1.3-1.5× on text)
```

**Typical**: 8-12 byte/s for text files, ~8 byte/s for binary.

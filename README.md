# 🦻 Eardrop

**File transfer over audio** — speaker to mic, no network needed.

BPSK modem on 4 data tones (650, 900, 1150, 1500 Hz) with continuous pilot (412.5 Hz). Two protocol stacks: production (TxEngine/RxEngine, atomic frames, diversity mode) and self-test (Encoder/Decoder, self-framing blocks).

## Quick Start

```bash
npm install
npm run dev      # → http://localhost:5173
```

1. Open in two browser tabs (or two devices)
2. Press **🎙 Start Listening** on the receiver
3. Drag a file onto the sender → **Send as Audio**
4. File appears as a download link on the receiver

Press **Ctrl+Shift+D** to open the debug panel.

## Features

- **BPSK on 4 tones**: 4 data bits per symbol at 25 sym/s
- **Pilot tone**: Continuous 412.5 Hz reference for amplitude tracking
- **Warble preamble**: 16-bit code correlation for robust start detection
- **Gray code calibration**: 16-frame sequence for per-tone reference vectors
- **DBPSK demodulation**: Differential BPSK with centroid fallback
- **Atomic frames**: 79-byte frames with BCH(63,30) header + RS(52,40) payload
- **Diversity mode**: Optional 3× frame repetition for noisy channels
- **Self-test**: Clean loopback tests for both protocol stacks
- **Channel simulator**: AWGN, echo, Doppler, amplitude drift, phase noise
- **React debug UI**: Constellation plots, spectrum, bit stream, sentinel scanner

## Modem Specs

| Parameter | Value |
|-----------|-------|
| Sample rate | 3200 Hz |
| Symbol rate | 25 sym/s |
| Production SPS | 256 samples/symbol |
| Self-test SPS | 128 samples/symbol |
| Data bits/symbol | 4 (1 phase bit × 4 tones) |
| Pilot frequency | 412.5 Hz |
| Tone frequencies | 650, 900, 1150, 1500 Hz |
| ECC (production) | BCH(63,30) × 3 + RS(52,40) |
| ECC (self-test) | BCH(31,16) + interleaver |
| Framing (production) | 79-byte atomic frames with Hamming-distance sentinel scanning |
| Framing (self-test) | Self-framing blocks with 24-bit sentinel scanner |
| Effective throughput | ~5-6 byte/s (production), ~5 byte/s (self-test) |

## Architecture

```
src/modem/
├── oscillator.ts     ← Shared PhaseAcc (sin-then-increment contract)
├── types.ts          ← ModemConfig, TONE_OFFSETS = [237.5, 487.5, 737.5, 1087.5]
├── pilot.ts          ← PilotPLL, toneIQ() Goertzel correlator
├── preamble.ts       ← Production preamble (warble + Gray cal + guard)
├── txEngine.ts       ← Production transmitter (atomic frames, SPS=256)
├── rxEngine.ts       ← Production receiver (DBPSK, sentinel scanner, SPS=256)
├── atomicFrame.ts    ← Atomic frame encode/decode (BCH+RS)
├── encoder.ts        ← Self-test encoder (self-framing, SPS=128)
├── decoder.ts        ← Self-test decoder (BPSK, framing, block processor)
├── framing.ts        ← Self-framing block protocol
├── blockProcessor.ts ← Block dispatch, file assembly
├── ecc.ts            ← BCH(31,16)
├── bch63.ts          ← BCH(63,30)
├── reedsolomon.ts    ← RS(52,40)
├── channel.ts        ← Channel simulator
└── debugger.ts       ← Structured logging

Tests: loopback.test.ts (12/12), production.test.ts (4/4), diversity.test.ts (3/3), pipeline.test.ts (17/20)
```

## Documentation

| Document | Description |
|----------|-------------|
| `docs/ARCHITECTURE.md` | System architecture, signal flow, two-stack design |
| `docs/MODEM.md` | Full modem spec (tones, framing, phase contract, ECC) |
| `docs/API.md` | Public API reference |

## License

MIT

# 🦻 Eardrop

**File transfer over audio** — speaker to mic, no network needed.

Built on a **pilot-relative multi-tone modem** with configurable pilot frequency, self-framing block protocol, BCH error correction, and per-file-type dictionary compression.

## Quick Start

```bash
npm install
npm run dev      # → http://localhost:5173
npm run build    # → dist/
```

1. Open in two browser tabs (or two devices)
2. Press **🎙 Start Listening** on the receiver
3. Drag a file onto the sender → **Send as Audio**
4. File appears as a download link on the receiver

Press **Ctrl+Shift+D** to open the debug panel (waveform, spectrogram, tone energies, decoder state).

## Features

- **Pilot-relative modem**: Decoder discovers the pilot frequency via FFT scan (40-120 Hz), tracks phase with a 2nd-order PLL. All measurements are pilot-relative — cancels Doppler, echo, volume differences.
- **Configurable pilot**: Encoder picks any frequency. Decoder finds it automatically.
- **Phase encoding**: 2 bits per tone (amplitude + BPSK) = 8 bits/symbol = 2× throughput of amplitude-only.
- **Self-framing blocks**: Every data unit is wrapped in `[SENTINEL][TYPE][LEN][DATA][CRC]`. Bit-level sentinel scanning means the decoder finds blocks at any symbol alignment.
- **BCH(31,16) ECC**: Corrects up to 3 bit errors per codeword. + block interleaver for burst error resilience.
- **Squawk calibration**: Periodic calibration beacons (every ~1.3s) re-lock the PLL, adjust AGC, and refresh per-tone thresholds.
- **Dictionary compression**: Shared per-file-type dictionaries (ASCII text, structured text) reduce payload size by 30-50%.
- **Channel simulator**: Built-in test harness with AWGN, echo, Doppler, amplitude drift, phase noise, band-limiting, impulse noise.
- **Self-test**: Clean loopback + noisy loopback at configurable SNR + full stress test.
- **Compressed LLM output**: One-click copy of structured debug summary for LLM analysis.
- **React debug UI** (floating windows): Constellation plots, FFT spectrum, band breakdown, bit stream, decoder state, squawk history, dictionary stats.

## Architecture

```
src/
├── modem/
│   ├── types.ts          ModemConfig, TONE_OFFSETS, helpers
│   ├── pilot.ts          PilotScanner (FFT), PilotPLL (2nd-order)
│   ├── encoder.ts        Pilot + BPSK tone encoder
│   ├── decoder.ts        Pilot-relative I/Q, framing, block processor
│   ├── framing.ts        Block encoder, bit-level sentinel scanner
│   ├── blockProcessor.ts Block dispatch, file assembly
│   ├── ecc.ts            BCH(31,16) + interleaver
│   ├── squawk.ts         Squawk calibration
│   ├── channel.ts        Channel simulator (AWGN, echo, Doppler, etc.)
│   ├── debugger.ts       Per-stage structured logging
│   ├── diag.ts           State snapshots, BER tracker
│   ├── compressForLLM.ts LLM-compressed debug output
│   ├── dictionary.ts     Compression dictionaries
│   └── dsp.ts            FFT, spectrogram utilities
├── workers/
│   ├── encoder.worker.ts
│   └── broadcast.worker.ts
├── audio/
│   ├── player.ts         Web Audio playback
│   ├── recorder.ts       Mic capture via AudioWorklet
│   ├── devices.ts        Device enumeration
│   └── resampler.ts      48kHz → 3200 Hz downsampling
├── ui/
│   ├── app.ts            Main UI, worker management
│   ├── react.ts          React mount point
│   └── debug/            React debug panels
├── protocol.ts           Legacy preamble format
└── crc32.ts              CRC-32 for payload integrity
```

## Modem Specs

| Parameter | Value |
|-----------|-------|
| Sample rate | 3200 Hz |
| Symbol rate | 25 sym/s (128 samples/symbol) |
| Raw bits/symbol | 8 (2 bits × 4 tones: amplitude + phase) |
| Pilot | Configurable (default 62.5 Hz), decoder discovers via FFT scan |
| Tones | pilotFreq + [437.5, 637.5, 837.5, 1037.5] Hz |
| ECC | BCH(31,16) — corrects 3 bits/codeword, rate 0.52 |
| Block framing | [0xE79F][TYPE][LEN][DATA][CRC16] — 7 bytes overhead |
| Squawk interval | Every 32 data symbols (~1.3s), 8 symbols per squawk |
| Effective throughput | ~8-12 byte/s (text), ~8 byte/s (binary) |
| Dictionary compression | ~30-50% reduction on text |

## Documentation

See the `docs/` directory:

| Document | Description |
|----------|-------------|
| `ARCHITECTURE.md` | System architecture, signal flow, module dependency graph |
| `MODEM.md` | Full modem specification (pilot, tones, framing, ECC, block types) |
| `DEBUG.md` | Debug and diagnostics guide (log events, LLM format, stage filters) |
| `CHANNEL_SIM.md` | Channel simulator reference (noise models, batch sweeps) |
| `API.md` | Public API reference for all modules |
| `LLM_PROMPT.md` | Guide for LLM analysis of compressed debug output |

## Development

### Branch Structure

- `main` — stable, tagged releases
- `pilot-relative-refactor` — current development branch

### Implementation Phases

| Phase | Description | Status |
|-------|-------------|--------|
| A | Foundation (pilot-relative, FFT scanner, PLL, BPSK) | ✅ |
| B | Self-framing block protocol | ✅ |
| C | Debug & diagnostics | 📝 |
| D | Squawk calibration | 📝 |
| E | Channel simulator + robust self-test | 📝 |
| F | BCH(31,16) error correction | 📝 |
| G | Dictionary compression | 📝 |
| H | Noise cancellation | 📝 |
| I | React debug UI | 📝 |
| J | Polish & integration | 📝 |
| K | Documentation | 📝 |

## License

MIT

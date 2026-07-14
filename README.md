# 🦻 Eardrop

**File transfer over audio** — speaker to mic, no network, no radio, sound only.

One-directional broadcast: a sender plays a file as sound, any listening receiver collects it into a download list. Set it running and forget — the receiver never talks back.

## Quick Start

```bash
npm install
npm run dev      # → http://localhost:5173
```

1. Open in two browser tabs (or two devices)
2. Press **🎙 Start Listening** on the receiver
3. Drag a file onto the sender → **Send as Audio**
4. File appears as a download link on the receiver

Press **Ctrl+Shift+D** for the debug panel.

## How it works

BPSK on 2/4/8 configurable data tones with a continuous pilot tone as the phase/amplitude reference — magnitudes and phases are decoded *relative* to the pilot, giving echo and drift immunity. A 620 ms preamble (warble code correlation → 16-frame Gray-code calibration → guard) locks the receiver before data starts.

An experimental **OFDM/QPSK mode** (native-rate, 40 ms symbol + 5 ms CP, Goertzel/toneIQ demodulation with per-tone equalization, 16 tones default at 2000-2750 Hz) is toggleable in the UI — solid in-memory, acoustic testing pending (see Known issues).

## Modem specs

| Parameter | Value |
|-----------|-------|
| Sample rate (modem) | Hardware rate (48 kHz / 44.1 kHz); OFDM uses native rate, BPSK uses Hann-sinc AudioWorklet downsampler to 3200 Hz |
| Symbol rate | 25 sym/s (BPSK) · ~40 sym/s (OFDM, 20 ms + 5 ms CP) |
| Data tones | 2 / 4 / 8, configurable |
| Pilot frequency | Configurable via UI slider (default 600 Hz for BPSK, 1900 Hz for OFDM) |
| Framing | 79-byte atomic frames, Hamming-distance sentinel scanning |
| ECC | BCH(63,30) × 3 header + RS(52,40) payload, soft-decision |
| Diversity ("hail mary") mode | Optional 3× frame repetition for noisy channels |
| Effective throughput | BPSK: ~5–6 byte/s acoustic; OFDM: 1280 bps raw (16 tones), 2560 bps raw (32 tones). Native-rate OFDM uses absolute frequencies in the 2-4 kHz band |

Audio capture force-disables AGC, noise suppression, and echo cancellation; mic gain (1–20×) and playback volume sliders compensate manually.

## Features

- **Self-test + channel simulator** — clean loopback plus AWGN, echo, Doppler, amplitude drift, phase noise
- **Sweep suite** — Audio Check, Full 100–1500 Hz frequency response, Multi-Tone overlap, Fine 10 Hz, Speed/combo benchmark; used to find per-setup optimal pilot/tones
- **Debug panel** — constellation/IQ plots, in/out/diff spectrum, waterfall, VU meters (raw/RMS/decoder), bit tables, sentinel scanner, per-category log toggles, LLM-compressed log copy
- **Knobs panel** — pilot frequency, thresholds, tone count, symbols/s exposed as live controls; settings persist across reloads
- **Raw-mic dump & replay** — record real captures to disk, replay them as regression tests
- **React UI** — light/dark, device pickers with persistence

## Architecture

```
src/
├── lib/       ← math, encoding, crc, ecc, scan, protocol, debug, channel utilities
├── modem/
│   ├── modulation/    demodulation/   ← BPSK + OFDM/QPSK mod/demod
│   ├── protocol/      ← txEngine, rxEngine, ofdmEngine, atomicFrame, preamble, framing
│   ├── dsp/  ecc/  pilot/  receiver/  channel/  debug/  test/
├── audio/     ← recorder (Hann-sinc worklet), player, device handling
├── workers/   ← encoder + broadcast workers
└── ui/        ← MainApp, Store, components, controllers, debug panels
```

Tests: `npm test` — 124 pass, 3 fail out of 127 total (3 pre-existing failures: Doppler ±Hz, Full Stress — BPSK-only, do not chase).

## Known issues

- **OFDM acoustic status** — All OFDM tests pass in-memory (modulation, demodulation, loopback, sync, cross-rate, hum immunity, channel drift, frame geometry V2, tuning invariants, pilot level, throughput benchmark). Acoustic testing with live mic/speaker pending. See `STATE.md`.
- **Throughput** — BPSK: ~5–6 byte/s acoustic; OFDM benchmark (48 kHz): 87 B/s net (16 tones), 167 B/s net (32 tones). Acoustic OFDM throughput not yet measured.

Fragile files — don't touch without careful testing: `src/modem/protocol/preamble.ts`, `src/modem/protocol/rxEngine.ts`, `src/modem/pilot.ts`, `src/audio/recorder.ts`.

## Documentation

| Document | Description |
|----------|-------------|
| `STATE.md` | Current state, known issues, OFDM continuation notes |
| `docs/ARCHITECTURE.md` | System architecture, signal flow |
| `docs/MODEM.md` | Full modem spec (tones, framing, phase contract, ECC) |
| `docs/API.md` | Public API reference |

## License

MIT

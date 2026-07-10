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

An experimental **OFDM/QPSK mode** (256-point FFT, 16-sample cyclic prefix, QPSK per subcarrier) is toggleable in the UI — solid in-memory, intermittent acoustically (see Known issues).

## Modem specs

| Parameter | Value |
|-----------|-------|
| Sample rate (modem) | 3200 Hz (Hann-sinc AudioWorklet downsampler from 48 kHz) |
| Symbol rate | 25 sym/s (BPSK) · ~11.76 sym/s (OFDM, 272-sample symbols) |
| Data tones | 2 / 4 / 8, configurable |
| Pilot frequency | Configurable via UI slider (default 487.5 Hz, ~600 Hz measured optimal) |
| Framing | 79-byte atomic frames, Hamming-distance sentinel scanning |
| ECC | BCH(63,30) × 3 header + RS(52,40) payload, soft-decision |
| Diversity ("hail mary") mode | Optional 3× frame repetition for noisy channels |
| Effective throughput | ~5–6 byte/s acoustic (≈9.5 kbit/s in-memory benchmark ceiling) |

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

Tests: `npm test` — 90 tests, 87 passing (3 pre-existing failures: Doppler ±Hz, Full Stress).

## Known issues

- **OFDM acoustic instability** — 13/13 OFDM tests pass in-memory, but over real audio frequency-selective per-tone phase rotation lands symbols in the wrong QPSK quadrant; pilot-phase correction and the cyclic prefix don't fix it. Candidate fixes: per-tone channel equalization trained on the sync burst, differential QPSK, or CP-autocorrelation timing recovery. See `STATE.md`.
- **8-tone mode** — implemented in OFDMEngine, untested acoustically; sentinel byte-packing still assumes 4 tones.
- **Throughput** — ~5 byte/s acoustic is the current floor-to-ceiling reality; fixed 3200 Hz modem rate is the bandwidth bottleneck.

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

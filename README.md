# 🦻 Eardrop

Eardrop is a browser-based file-transfer system that sends files over audio from a speaker to a microphone without a network. The current implementation uses a unified modem worker so the UI can stay responsive while encoding and decoding happen off the main thread.

## Quick start

```bash
npm install
npm run dev      # http://localhost:5173
```

1. Open the app in two browser tabs or on two devices.
2. Press the receive/start button on the receiver side.
3. Drag a file onto the sender and choose Send as Audio.
4. The receiver assembles the file and exposes it as a download.

Press Ctrl+Shift+D to open the debug panel.

## What the app does today

- Supports file transfer over two modem paths:
  - BPSK for the more mature acoustic path
  - OFDM/QPSK for native-rate, higher-throughput transfers
- Uses a single worker entrypoint, `modem.worker.ts`, backed by `ModemService`.
- Exposes live telemetry, tone meters, spectrum views, constellation plots, and frame/debug logs in the UI.
- Includes a self-test and channel-simulator path for loopback and impairment testing.

## Current architecture

- UI: React-based app, stores, controllers, and debug panels in `src/ui/`.
- Worker: `src/workers/modem.worker.ts` and `src/workers/modemService.ts` handle modem commands and emit telemetry.
- Modem core: `src/modem/` contains modulation, demodulation, protocol, DSP, ECC, pilot tracking, and receiver code.
- Audio: `src/audio/` contains recorder/player/device handling, including the AudioWorklet-based mic path.

## Current modem status

- BPSK remains the production-tested acoustic path.
- OFDM/QPSK is implemented and exercised through the same TxEngine/RxEngine pipeline, with native hardware-rate timing and per-tone equalization.
- The current test suite reports 127 tests total, with 124 passing and 3 known failing cases in the existing BPSK Doppler/stress coverage.

## Development commands

```bash
npm run dev
npm run build
npm run test
npm run lint
```

## Documentation

- `STATE.md` — current state, known issues, and follow-up notes
- `docs/ARCHITECTURE.md` — runtime architecture and signal flow
- `docs/MODEM.md` — modem configuration, tone layout, protocol behavior, and OFDM tuning
- `docs/API.md` — API surface for the core modem and worker components

## Notes

Fragile files should be changed carefully and verified with loopback or acoustic tests before and after edits:
- `src/modem/protocol/preamble.ts`
- `src/modem/protocol/rxEngine.ts`
- `src/modem/pilot.ts`
- `src/audio/recorder.ts`

## License

MIT

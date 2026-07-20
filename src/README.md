# src

The `src/` tree contains the browser app, the modem core, and the audio pipeline.

## Top-level areas

- `audio/` — device enumeration, playback, recording, and the AudioWorklet-based mic path.
- `lib/` — shared math, CRC, ECC, scan, protocol, and debug helpers.
- `modem/` — transmitter/receiver engines, modulation/demodulation, pilot tracking, channel simulation, ECC, and tests.
- `ui/` — React shell, stores, controllers, telemetry, and debug panels.
- `workers/` — the unified modem worker and its schema/service glue.

## Current coding conventions

- Prefer small helpers from `lib/` when the logic is reusable outside the modem core.
- Keep UI state and config assembly in `src/ui/` rather than embedding modem settings inline in the components.
- The worker entrypoint is `src/workers/modem.worker.ts`; the worker logic itself lives in `src/workers/modemService.ts`.

## Notes

See `AGENTS.md` and `STATE.md` for fragile-file guidance and the current verification expectations before touching the live audio path.

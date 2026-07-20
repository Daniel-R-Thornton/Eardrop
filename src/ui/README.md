# ui

The React UI for the app, including the main transfer screen, controls, telemetry panels, and debug views.

## Main pieces

- `MainApp.tsx` — the main screen and tabbed layout.
- `Store.ts` and `telemetryStore.ts` — state and live telemetry storage.
- `controllers/` — config building, modem lifecycle glue, and self-test helpers.
- `components/` — reusable cards, meters, plots, and status widgets.
- `debug/` — debug hooks used by the UI panels.

## Current flow

The UI sends modem commands to the unified worker and consumes the resulting telemetry and file-complete events. The config passed to the worker is assembled centrally in `controllers/buildModemConfig.ts`.

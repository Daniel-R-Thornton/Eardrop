# workers

The worker layer for the app now centers on a single modem worker and service wrapper.

## Current modules

- `modem.worker.ts` — worker entrypoint that hosts the modem service.
- `modemService.ts` — creates and coordinates `TxEngine` and `RxEngine`, handles commands, and emits telemetry.
- `modemSchema.ts` — shared request/response event types for the main thread and worker.

## Notes

The older separate `encoder.worker.ts` and `broadcast.worker.ts` flow is no longer the active architecture. The current UI uses the unified worker path described above.

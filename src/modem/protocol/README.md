# modem/protocol

Protocol-level framing and helpers for the atomic-frame file transfer protocol.

Reusable bits
- `preamble.ts` — preamble generator (warble, calibration, sweep). Used by transmitters to create the sync burst.
- `framing.ts` / `atomicFrame.ts` — frame packing/unpacking, BCH/RS protection helpers.
- `encoder.ts` / `decoder.ts` — high-level encode/decode wrappers around frames.

Notes
- `preamble.ts` timing and calibration are fragile — do not change without replay + acoustic verification (see AGENTS.md and STATE.md).
- Use `modem/test/*` for examples of producing and consuming frames.

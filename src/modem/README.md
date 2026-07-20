# modem

The modem package contains the core file-transfer implementation used by the UI worker and by the headless tests.

## Main modules

- `protocol/` — production transfer path (`TxEngine`, `RxEngine`, `OFDMEngine`, `atomicFrame`) plus the older self-test encoder/decoder stack.
- `modulation/` — BPSK and OFDM/QPSK modulation backends.
- `demodulation/` — OFDM/QPSK demodulation and related helpers.
- `pilot.ts` — pilot discovery (`PilotScanner`), PLL tracking (`PilotPLL`), and `toneIQ()`.
- `ecc/` and `channel/` — ECC, channel simulation, and related utilities.

## Current usage

- The browser app uses `TxEngine` and `RxEngine` through the unified worker.
- The self-test path still exists for the older loopback and channel-simulation tests.
- OFDM-specific code is exercised with native-rate timing and the current tuning constants from `src/modem/types.ts`.

## Fragile files

The live audio and timing-sensitive paths should be changed carefully and verified before and after edits:
- `protocol/preamble.ts`
- `protocol/rxEngine.ts`
- `pilot.ts`
- `demodulation/OFDMQPSKDemodulator.ts`

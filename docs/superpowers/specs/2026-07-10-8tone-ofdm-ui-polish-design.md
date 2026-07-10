# 8-Tone OFDM Packing + UI Polish — Design

Date: 2026-07-10. Approved by Daniel in-session.

## Scope

Quick wins only: (A) 8-tone OFDM byte packing, (B) light UI polish.
Out of scope: sample-rate decoupling from 3200 Hz, FFT-64/50-sym-per-sec wiring,
UI layout redesign.

## A. 8-tone OFDM packing

Generalize by **4-tone blocks**: each block carries one byte per OFDM symbol
(upper nibble on the b0 bit lane, lower nibble on b1 — identical to the current
4-tone scheme). 8 tones = 2 blocks = 2 bytes/symbol, doubling raw throughput at
the same symbol rate (~188 bit/s at 11.76 sym/s).

- TX `ofdmEngine.modulateFrame`: consume frame bytes blockCount at a time;
  block k carries byte k. Odd tail byte padded with 0x00 in the final symbol's
  second block (scanner/frame length logic is byte-exact from the sentinel, so
  trailing pad bits are inert).
- RX `rxEngine` OFDM branch: use `result.bits` (length 2N) directly; per block
  assemble fbUpper/fbLower → byte → `scanner.feedByte`. Byte order = block
  order. SentinelScanner unchanged.
- toneCount for OFDM: 4 or 8. 2 is rejected with a warn-level dlog (previously
  silently dropped bits).
- Frequencies: `makeToneOffsets(8, 100, 100)`; top tone ≈ pilot + 900 Hz —
  under Nyquist (1600 Hz) for pilots up to ~600 Hz.

Tests (failing first): packing round-trip unit test for 4 and 8 tones;
8-tone case added to `ofdm_acoustic_path.test.ts` (misaligned grid + delay).

## B. UI polish (light)

Keep MainApp layout; restyle only:
- CSS design tokens; per-tone colors consistent across constellation/VU/spectrum.
- Tuned typography and spacing; header with live status pill driven by
  `decoderState` (idle → listening → synced → decoding → complete).
- Pipeline strip: TX `file → frames → OFDM → speaker`, RX `mic → align → train
  → demod → scan → file`, live stage highlighted from existing state.
- Debug panel: titled section cards, dlog-tag color chips, **Copy log** button
  wired to `dlogDump()`.

## Error handling

- OFDM + toneCount 2 → dlog warn + fall back to 4 tones (TX and RX agree).
- 8-tone RX with 4-tone TX (config mismatch): decodes garbage; sentinel scanner
  simply never locks — same behaviour class as today's mismatched settings.

## Verification

Vitest suite (round-trip + acoustic-path), tsc, eslint on changed files.
Real acoustic 8-tone check is a user action (single-frame test in the UI).

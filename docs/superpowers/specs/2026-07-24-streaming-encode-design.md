# Streaming encode + play — design

Date: 2026-07-24
Branch: `perf/streaming-encode`

## Problem

File send encodes the **entire** waveform up front (`TxEngine.transmitFile`) then
plays it as one `AudioBuffer` (`AudioPlayer.play`). Throughput is ~213 B/s, so a
6 MB file → ~8 h of audio → ~6 GB per buffer copy (×3 copies live in
`transmitFile` + `AudioBuffer`) → the tab OOMs before it can play. Encode CPU is
*not* the limiter — it runs ~230× realtime after the tone-table fix.

## Approach

Stream: encode a few frames at a time in the worker, hand chunks to the main
thread, schedule them back-to-back through Web Audio. Memory bounded to a small
look-ahead window instead of the whole file.

Chosen mechanism: **scheduled buffer chunks** (not AudioWorklet) — no
COOP/COEP headers, no SharedArrayBuffer, reuses the existing `AudioContext`.
Chosen scope: **new path alongside batch**, wired only to the file-send buttons.
All other `play()` callsites (WAV export, demo, presentation) stay on batch.

## Components

### `TxEngine` (src/modem/protocol/txEngine.ts)
- `*frameSegments(fileName, data)` — generator yielding each audio segment in
  order (preamble → header×repeats → data frames×repeats → tail×repeats → tail
  silence). Single source of truth for transmission layout.
- `transmitFile` refactored to `concat(frameSegments) + global peak-normalize`.
  Behaviourally **byte-identical** to today.
- `*streamChunks(fileName, data, chunkSamples)` — groups `frameSegments` output
  into ≈0.5 s chunks. **No global normalize** (each OFDM symbol is already
  peak-normed to 0.95 inside `generateSymbol`; BPSK path unchanged).
- `estimateStreamSamples(dataLen)` — cheap total-sample estimate for the
  progress bar (approximate; drives % only, never correctness).

### `ModemService` (src/workers/modemService.ts) — pull protocol
- `encodeStreamStart{id,fileName,data}` → build + store the `streamChunks`
  generator; reply `streamStart{id,sampleRate,totalSamples}`.
- `encodeStreamPull{id}` → `gen.next()` → `streamChunk{id,samples}` (transferable)
  or `streamEnd{id}`.

### `ModemController` (src/ui/controllers/modemController.ts)
- `startFileStream(fileName,data) → {sampleRate,totalSamples,pull()}`.
  `pull()` posts one `encodeStreamPull`, resolves the next chunk or `null` at end.
  One pull in flight at a time.

### `AudioPlayer` (src/audio/player.ts)
- `playStream(pull, sampleRate, deviceId) → Promise<void>`.
  Cursor `nextTime`; pump keeps ~2 s scheduled ahead, `src.start(nextTime)`
  back-to-back (gapless — contiguous slices at contiguous times). Fixed unity
  gain (samples already ≈0.95). Tracks scheduled sources; `stopPlayback`
  cancels all and aborts the pull loop. Resolves when the last chunk ends.

### UI (src/ui/app.ts)
- `eardrop-send` + `eardrop-send-test` → new `playFileStreaming()`; progress from
  `ctx.currentTime / totalDuration`. WAV export and every other path untouched.

## Backpressure / memory
Main pulls only to keep ~2 s buffered; worker produces one chunk per pull. Peak
resident audio ≈ a handful of chunks (single-digit MB) regardless of file size.

## Correctness anchor (test)
`concat(streamChunks(f,d)) === transmitFile(f,d)` **before** the global
normalize step — byte-identical — proving the generator refactor preserves the
waveform. Plus an OFDM round-trip decode of a streamed-then-concatenated signal.

## Assumptions / risks
- `AudioContext.sampleRate === encode sampleRate` (same assumption batch `play`
  already relies on; app configures the modem at `audioCtx.sampleRate`).
- `stopPlayback` must abort the in-flight `pull()` so the worker generator is
  dropped and no further chunks schedule.

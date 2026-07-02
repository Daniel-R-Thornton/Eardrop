# Eardrop — Acoustic File Transfer

## Overview

Eardrop transfers files over audio using an OFDM-style multi-tone modem. The encoder modulates data into 4 simultaneous tones (500/700/900/1100 Hz), and the decoder recovers data by correlating mic input against those same frequencies. Data is transmitted acoustically: speaker → mic, no network needed.

## Architecture

```
┌─ Main Thread ──────────────────────────────────────────┐
│  Debug view (visualizer, canvases, stats)              │
│  AudioRecorder (mic capture → AudioWorklet → downsample)│
│  AudioPlayer   (playback via shared AudioContext)       │
│  UI controls (send/receive buttons, status)             │
└──────────────┬───────────────────────────▲─────────────┘
               │ encode task               │ decoded frames
               ▼                           │
┌─ EncoderWorker ───────┐   ┌─ BroadcastWorker ────────┐
│  Encoder.encode()     │   │  Decoder state            │
│  encodeToOutputRate() │   │  feedSample() → Decoder   │
└───────────────────────┘   └──────────────────────────┘
```

**Shared AudioContext** (critical): The AudioPlayer and AudioRecorder use a single shared AudioContext. Chrome suspends secondary contexts, so separate contexts for player and recorder would cause one to pause when the other is used.

**Web Workers**: Encoding runs in `encoder.worker.ts`, decoding in `broadcast.worker.ts` — both off the main thread so the debug UI never lags.

## Key Files

- `src/ui/app.ts` — UI logic, worker management, send/receive flow
- `src/modem/encoder.ts` — Multi-tone OFDM encoder
- `src/modem/decoder.ts` — Multi-tone decoder with noise-adaptive thresholds
- `src/modem/types.ts` — Modem config (sample rate, tone frequencies, etc.)
- `src/audio/recorder.ts` — Mic capture via AudioWorklet, downsampling
- `src/audio/player.ts` — Audio playback via shared AudioContext
- `src/workers/encoder.worker.ts` — Encoder in web worker
- `src/workers/broadcast.worker.ts` — Decoder in web worker
- `src/protocol.ts` — Preamble packet format (file name, size, CRC)
- `src/crc32.ts` — CRC-32 for payload integrity

## Protocol

Every file is wrapped in a preamble before encoding:
```
[nameLen:2B LE][fileName:nameLen B UTF8][totalSize:4B LE][crc32:4B LE][payload]
```

The receiver parses the preamble, extracts file metadata, buffers `totalSize` bytes of payload, and verifies the CRC.

## Modem

- **Sample rate**: 3200 Hz
- **Symbol rate**: 25 symbols/sec (128 samples/symbol)
- **Tones**: 500, 700, 900, 1100 Hz (4 bits per symbol)
- **Pilot**: 62.5 Hz at 0.125 amplitude (always present)
- **Frame**: leader (~0.5s) → sync (3 symbols, all 4 tones ON) → data → done

### Encoder (`encoder.ts`)
- Normalizes output to [-1, 1] after generation
- Resamples from 3200 Hz to output device rate for playback

### Decoder (`decoder.ts`)

**Noise profiling** (Phase 1, ~1 second):
- Collects 25 frames of ambient noise
- Builds per-frequency running average (noiseFloor[t]) and max (noiseMax[t])
- During this phase, noise profiling runs on every frame regardless of `isBurst`
- No data mode entry allowed during profiling

**Sync detection** (Phase 2, after profiling):
- `isBurst = avg > Math.max(noiseAvg * 2.0, 5e-9)`
- Requires **3 consecutive** sync frames (`consecutiveSync >= 3`) to enter data mode
- This matches the encoder's 3 sync symbols and prevents false positives

**Data mode**:
- Skips `syncSymbols` frames (avoids decoding sync as data)
- Per-tone adaptive threshold: `Math.max(noiseFloor[t] * 1.5, noiseMax[t] * 1.1, 0.000005)`
- End detection uses SNR: `signalToNoise = avg / noiseAvg`. When it drops below 2.0 for 4 frames, file is emitted.
- After emitting, returns to ready state (noise floor is preserved for next file)

### Thresholds (critical for acoustic path)

Through speaker+mic, tone energies are ~1e-7 to 1e-6 vs 0.25 in direct digital. All thresholds must account for this:

| Threshold | Value | Purpose |
|-----------|-------|---------|
| Sync detection | `max(noiseAvg*2.0, 5e-9)` | 5e-9 absolute floor, well below 2e-7 signal |
| Bit detection | `max(noiseFloor*1.5, noiseMax*1.1, 5e-6)` | 5e-6 absolute for tone-on detection |
| End-of-signal | `signalToNoise < 2.0` for 4 frames | Uses tone energy ratio, not raw amplitude |
| Noise floor adaptation | α=1/N for N<25, α=0.03 after | 25 frames = ~1s calibration |

## Current State / What Works

- ✅ Encoder produces normalized multi-tone audio
- ✅ Microphone capture via AudioWorklet (modern ScriptProcessorNode replacement)
- ✅ Shared AudioContext for simultaneous play+record
- ✅ Noise floor profiling (25 frames, ~1s)
- ✅ Sync detection (3 consecutive frames, noise-adaptive thresholds)
- ✅ Data mode with adaptive per-tone bit thresholds
- ✅ End-of-signal detection via SNR
- ✅ Preamble protocol (file name, size, CRC32)
- ✅ Web Workers for encode/decode (UI stays responsive)
- ✅ Debug panel with waveform, spectrogram, tone energy, TX/RX payloads
- ✅ Send Test button (hello.txt)
- ✅ Loopback Self-Test (🧪 button, digital-only)

## What Needs Work / Known Issues

1. **Acoustic path reliability**: The demo works — sync is detected, data is decoded — but the decoded bytes are zeros or garbled. The tone energies through speaker+mic (~1e-7) are near the noise floor (~3e-10) × thresholds. Bit errors result in CRC mismatch. Options:
   - Increase speaker volume
   - Use a cable/headphone jack direct connection
   - Add error correction (ECC/Reed-Solomon)
   - Use frequency-shift keying for stronger signal
   - Increase symbol duration (lower symbol rate)

2. **Single-file protocol**: Can only send one file per transmission. No multi-file or streaming.

3. **No retransmission**: If CRC fails, file is silently dropped.

4. **No forward error correction**: Bit errors are unrecoverable.

5. **Chrome extension noise**: `(index):1 Uncaught Error: A listener indicated...` — harmless, from browser extensions, not app code.

6. **No UI for noise profiling state**: "Checking noise floor..." / "Ready" display not yet implemented.

## Debug Panel (Ctrl+Shift+D)

Shows: Waveform, Spectrogram, Tone Energy (4 frequency bars), Split Carriers, Mic Level meter, Decoder State (real-time with noise floor, sync count, energies, thresholds), TX/RX payload hex dumps.

## Testing

- **🧪 Loopback Self-Test**: Digital-only — encodes "Hello World", decodes in-memory. Confirms modem pipeline works without speaker/mic.
- **📤 Send Test (hello.txt)**: Plays "Hello World\n" through speaker. Use with 🎙 Start Listening to test acoustic path.
- **File send**: Drop any file in the drop zone and click Send as Audio.
- Expect `[DEC] SYNC DETECTED` in console when acoustic sync works.

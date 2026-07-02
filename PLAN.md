# Plan: Pilot-Relative Modem with Phase Encoding & React Debug UI

## Current Architecture Summary

```
Encoder (encoder.worker.ts → Encoder.encode())
  raw bytes → nibbles → Hamming(7,4) → 8 bits/nibble → 4 tones × 1 bit/symbol
  Frame: leader → sync (8 symbols, all tones ON) → guard (2 symbols) → data → done
  Pilot: disabled (pilotAmplitude: 0)
  Sample rate: 3200 Hz, 128 samples/symbol, 25 sym/s

Decoder (broadcast.worker.ts → Decoder.feedSample())
  Absolute energy detection per tone (Goertzel-style sin/cos correlation)
  Per-tone adaptive threshold: noiseFloor[t] * 4
  Noise profiling: 25 frames (~1s) before accepting sync
  Sync: 8 consecutive strong frames with all 4 tones dominant
  End detection: SNR < 2.0 for 8 frames
  Hamming(7,4) decode with 1-bit correction per codeword

Debug UI (app.ts → canvas-based Visualizer)
  Waveform, spectrogram, tone energy bars, split carriers
  Tone energy meter per freq, decoder state log
  TX/RX payload hex dumps
```

## What We're Building

**A pilot-relative, phase-aware, highly robust modem** with React-based debugging tools.

### Key Innovations

| Feature | Current | New |
|---------|---------|-----|
| Pilot | Disabled | Always-on, **configurable frequency** (default 62.5 Hz), amplitude 0.125 |
| Pilot lock | None | **Decoder scans to discover pilot frequency**, locks onto whatever it finds |
| Pilot config | Hardcoded (disabled) | `pilotFreqHz` in ModemConfig — encoder picks, decoder discovers via Goertzel scan + PLL tracking |
| Tone frequencies | Fixed absolute: 500, 700, 900, 1100 Hz | **Relative to pilot**: pilotFreq + offsets [437.5, 637.5, 837.5, 1037.5] → same default freqs, but shift with pilot |
| Bit detection | Absolute energy > floor*4 | Energy/phase relative to pilot |
| Bits per symbol | 4 (1 per tone, amplitude only) | 8 (1 amplitude + 1 phase per tone) |
| Error correction | Hamming(7,4), rate 1/2 | Hamming(15,11) + interleaving, rate ~0.69 |
| Noise handling | Basic floor profiling | Spectral subtraction + pilot-referenced AGC |
| Doppler/echo | None | Cancelled by pilot-relative measurement |
| Debug UI | Canvas-based, limited | React-based: constellation, FFT, band breakdown, bit I/O |

---

## Files to Change / Create

### New Files

| File | Purpose |
|------|---------|
| `src/modem/pilot.ts` | Pilot tracking — PLL for phase lock + amplitude normalization |
| `src/modem/ecc.ts` | Enhanced ECC: Hamming(15,11), interleaver/deinterleaver |
| `src/modem/noise.ts` | Adaptive noise canceller — spectral subtraction, AGC |
| `src/ui/debug/panels/ConstellationPanel.tsx` | React: I/Q scatter plot per tone |
| `src/ui/debug/panels/FFTPanel.tsx` | React: live FFT spectrum |
| `src/ui/debug/panels/BandBreakdownPanel.tsx` | React: per-band energy, phase, bits |
| `src/ui/debug/panels/BitStreamPanel.tsx` | React: raw bits in, decoded bytes, errors |
| `src/ui/debug/panels/DecoderStatePanel.tsx` | React: noise floor, SNR, sync state |
| `src/ui/debug/DebugContainer.tsx` | React: layout/dashboard container |
| `src/ui/debug/hooks/useDecoderState.ts` | React hook: subscribe to decoder state updates |
| `src/ui/debug/hooks/useAudioStream.ts` | React hook: live audio samples for FFT |
| `src/ui/debug/components/ScatterCanvas.tsx` | Reusable canvas component for constellation |
| `src/ui/debug/components/SpectrumCanvas.tsx` | Reusable canvas component for FFT |
| `src/ui/react.ts` | React mount point, root component |
| `package.json` additions | react, react-dom, @types/react, @types/react-dom |

### Modified Files

| File | Changes |
|------|---------|
| `index.html` | Add React mount point `<div id="react-debug">` alongside existing UI |
| `src/modem/types.ts` | New config: pilotEnabled, pilotFreqHz (configurable!), toneOffsets (relative to pilot), eccScheme, interleaveDepth, squawkIntervalSymbols, payloadBlockSymbols, sentinel (16-bit pattern) |
| `src/modem/encoder.ts` | Enable pilot, add phase modulation (BPSK per tone), Hamming(15,11), interleaver |
| `src/modem/decoder.ts` | Pilot-relative energy+phase detection, PLL tracking, spectral subtraction, deinterleaver |
| `src/modem/visualizer.ts` | Keep for backward compat or remove once React panels cover all |
| `src/workers/broadcast.worker.ts` | Pipe richer debug info (I/Q per tone, constellation points) to main thread |
| `src/workers/encoder.worker.ts` | Support new config fields |
| `src/ui/app.ts` | Keep vanilla UI for main controls, mount React debug panel, pipe decoder state to React |
| `tsconfig.json` | Add `"jsx": "react-jsx"` |

---

## Detailed Design

### 1. Configurable Pilot — Encoder Sets, Decoder Discovers

Pilot frequency is **not hardcoded**. The encoder selects a pilot frequency at encode time (default 62.5 Hz, configurable via `ModemConfig.pilotFreqHz`). The decoder **discovers** it by scanning the spectrum during the leader phase.

> Squawk interval and payload block size are also configurable via `ModemConfig` (defaults: squawk every 32 symbols, payload block 32 symbols) and sent in the Config header block so the decoder knows what to expect.

Why this matters:
- Different environments have different noise profiles at specific frequencies
- A pilot at 60 Hz cancels poorly in regions with 60 Hz mains hum — bump to 62.5 Hz or 75 Hz
- The decoder doesn't need to know the frequency in advance — it finds the dominant continuous tone
- The same decoder hardware can work with any transmitter configuration

#### Encoder (encoder.ts)

```typescript
// Config:
//   pilotFreqHz: number (default 62.5) — encoder picks whatever works for this environment
//   pilotAmplitude: number (default 0.125)
//   dataToneAmplitude: number (0.2 — leaves headroom for pilot + 4 tones < 1.0)
//
// In generateSample():
//   pilot = sin(2π * pilotFreq * phaseAccum) * pilotAmplitude
//   Pilot runs continuously from leader start to done — never drops
//
// Data tones are modulated *relative to the pilot*:
//   phase reference = pilot's current phase at this sample
//   amplitude bit: tone ON = dataToneAmplitude, OFF = 0
//   phase bit: same phase as pilot = 0°, inverted = 180°
//
// So each tone symbol carries 2 bits:
//   bit 0 (amplitude): 0 = OFF, 1 = ON
//   bit 1 (phase):    0 = 0° (pilot-aligned), 1 = 180° (pilot-inverted)
//
// The data tone frequencies are at fixed offsets *from* the pilot, not fixed absolute freqs.
//   dataToneFreq[t] = pilotFreqHz + TONE_OFFSETS[t]
//   where TONE_OFFSETS = [437.5, 637.5, 837.5, 1037.5]
//   This ensures consistent pilot-relative spacing regardless of pilot frequency.
```

#### Pilot Scanner & Tracker (new: pilot.ts)

This is the decoder's pilot discovery system, split into two phases:

**Phase 1: Frequency Scan** (during leader, ~0.5s of continuous pilot)

```typescript
export class PilotScanner {
  // Config:
  //   scanRange: [minHz, maxHz] — default [40, 120] (covers common pilot candidates)
  //   scanResolution: number — e.g. 5 Hz steps
  //   candidateFreqs: number[] — optional explicit list if encoder tells decoder where to look
  //
  // Algorithm:
  //   1. Collect up to 0.5s of audio (leader phase — just pilot, no data)
  //   2. Run Goertzel at each candidate frequency in scanRange
  //   3. Pick the frequency with the highest sustained energy
  //   4. Validate: the chosen bin must have energy > 3× the noise floor
  //      AND must be stable (variance across frames < 20%)
  //   5. Return: { pilotFreq: number, pilotPhase: number, pilotAmplitude: number }
  //
  // If no valid pilot found after 0.5s, keep scanning until one appears
  // (i.e., the transmitter hasn't started yet).
  //
  // Methods:
  //   feedSample(sample: number): void
  //   discover(): { pilotFreq: number; amplitude: number } | null
}
```

**Phase 2: Phase Tracking PLL** (after discovery, through entire transmission)

```typescript
export class PilotPLL {
  // Second-order PLL locked to the discovered pilot frequency.
  //   - Tracks phase continuously (not frame-by-frame like Goertzel)
  //   - Outputs phase and amplitude estimates every sample
  //   - Bandwidth narrow (~10 Hz) — rejects modulation from data tones
  //
  // Methods:
  //   update(sample: number): void  — feed each mic sample, updates internal state
  //   getPhase(): number            — current pilot phase (0..2π)
  //   getAmplitude(): number        — smoothed pilot amplitude for AGC
  //   getFrequency(): number        — tracked pilot frequency (may drift slightly)
  //
  // PLL design:
  //   phaseDetector = atan2(qCorrelation, iCorrelation)
  //   loopFilter = proportional + integral (Kp=0.1, Ki=0.01)
  //   nco produces sin/cos at tracked frequency
  //
  // The PLL runs continuously and updates on every sample.
  // During data mode, the pilot is always present, so the PLL stays locked.
}
```

#### Decoder Phase Detection (decoder.ts)

```typescript
// For each data tone at (pilotFreq + TONE_OFFSETS[t]):
//   Compute I/Q correlation over one symbol window:
//     I = Σ sample[n] * sin(2π * toneFreq * n / rate)
//     Q = Σ sample[n] * cos(2π * toneFreq * n / rate)
//
// Rotate by the pilot's *current tracked phase* (from PilotPLL) to get
// pilot-relative I'/Q' — this is the **constellation point**:
//   I' =  I*cos(θ_pilot) + Q*sin(θ_pilot)
//   Q' = -I*sin(θ_pilot) + Q*cos(θ_pilot)
//
// Bit decisions from the pilot-relative point:
//   amplitude bit = |I' + jQ'| > pilotAmplitude * amplitudeThresholdRatio
//   phase bit     = 1 if I' > 0 else 0   (BPSK: right half-plane = 1, left = 0)
//
// The amplitudeThresholdRatio is adaptive (default 0.3):
//   tone is ON if its energy > 30% of the tracked pilot amplitude
//   This is the key pilot-relative mechanism — threshold adapts to volume automatically.
```

#### Pilot Config in Types

```typescript
export interface ModemConfig {
  sampleRate: number;          // 3200
  symbolsPerSec: number;       // 25
  bitsPerFrame: number;        // 8 (was 4)
  
  // Pilot
  pilotEnabled: boolean;       // true
  pilotFreqHz: number;         // 62.5 (configurable!)
  pilotAmplitude: number;      // 0.125
  
  // Data tones are at pilotFreq + TONE_OFFSETS[t]
  // This keeps spacing consistent regardless of pilot frequency
  toneOffsets: [number, number, number, number];  // [437.5, 637.5, 837.5, 1037.5]
  
  // Squawk
  squawkIntervalSymbols: number; // 32
  squawkSymbols: number;         // 8 (or 11 with framing)
  
  // ECC
  eccScheme: 'hamming74' | 'bch3116'; // bch3116
  interleaveDepth: number;      // 8
}
```

If we keep the standard tone frequencies but make them pilot-relative:
- Pilot at 62.5 Hz
- Tone 0 at 62.5 + 437.5 = **500 Hz** (same as before!)
- Tone 1 at 62.5 + 637.5 = **700 Hz**
- Tone 2 at 62.5 + 837.5 = **900 Hz**
- Tone 3 at 62.5 + 1037.5 = **1100 Hz**

Change the pilot to say 75 Hz and tones shift to 512.5 / 712.5 / 912.5 / 1112.5 Hz — still evenly spaced, still within the same acoustic band. The decoder discovers 75 Hz as pilot and computes offsets accordingly.

### 2. Enhanced Error Correction (new: ecc.ts)

```typescript
// Hamming(15,11): 11 data bits + 4 parity = 15-bit codeword
//   Corrects 1 error, detects 2
//   Rate = 11/15 ≈ 0.73 (vs current 4/8 = 0.5)
//
// Interleaver: block interleave of depth 4-8
//   Spreads burst errors across multiple codewords
//   At 25 sym/s, a 100ms burst = 2.5 symbols = 20 bits = ~1.3 codewords
//   Interleave depth 8 spreads this across 8 codewords → each has at most ~3 errors
//   Hamming(15,11) corrects 1 — so we need repeats or outer code
//
// Option: Hamming(15,11) + repetition (send each codeword 3x, majority vote)
//   Effective rate = 11/45 ≈ 0.24, but very robust
//
// Even better: BCH(31,16) — corrects 3 errors, rate 0.52, ~Hamming(7,4) efficiency
//   with far more correction power
```

**Decision**: BCH(31,16). Corrects 3 bits per 31-bit codeword, rate 0.52 (same as current), but far more robust than Hamming(7,4).

### 3. Adaptive Noise Cancellation (new: noise.ts)

```typescript
export class NoiseCanceller {
  // Spectral subtraction: maintain per-bin noise estimate
  //   noiseBin[b] = α * noiseBin[b] + (1-α) * magBin[b] (only during silence)
  //
  // AGC: scale input so pilot amplitude = target
  //   gain = targetPilotAmp / trackedPilotAmp
  //
  // Adaptive threshold: threshold[t] = max(noiseFloor[t] * safetyMargin, pilotEnergy[t] * minRel)
  //
  // Methods:
  //   feedSample(s: number): void  — update noise estimate during silence
  //   cancel(frame: Float32Array): Float32Array  — spectral subtraction
  //   getThreshold(toneIdx: number): number  — per-tone adaptive threshold
}
```

### 4. Pilot-Relative AGC

```
gain = targetPilotAmplitude / measuredPilotAmplitude
```

The `measuredPilotAmplitude` comes from the **PilotPLL** — it's running estimate of the pilot's amplitude, updated every sample. Since the PLL tracks the discovered pilot frequency, it naturally adapts to whatever pilot the encoder chose.

This single normalization cancels everything without any per-transmission tuning:
- Speaker volume differences
- Mic sensitivity differences  
- Distance between speaker and mic
- Frequency response (when done per-tone)
- **Pilot frequency differences** — doesn't matter if the encoder used 62.5 Hz or 75 Hz or 100 Hz

Per-tone application:
```
normalizedToneEnergy[t] = rawToneEnergy[t] / measuredPilotAmplitude
threshold[t] = max(noiseFloor[t] * safetyMargin, amplitudeThresholdRatio)
```

`amplitudeThresholdRatio` is typically 0.3 — a tone is ON if its pilot-normalized energy is ≥30% of the pilot's own normalized energy.

### 5. React Debug UI

**Package dependencies** (add to `package.json`):

```json
{
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0"
  }
}
```

**React mount** (`src/ui/react.ts`):

```typescript
import React from 'react';
import { createRoot } from 'react-dom/client';
import { DebugContainer } from './debug/DebugContainer';

// Mount into its own div in index.html
const container = document.getElementById('react-debug');
if (container) {
  const root = createRoot(container);
  root.render(React.createElement(DebugContainer));
}
```

**State Flow**: Main thread holds a `DecoderState` object (updated via broadcast worker messages). React components subscribe via a simple pub/sub or React context.

```typescript
interface DecoderSnapshot {
  timestamp: number;
  inFrame: boolean;
  bitsCollected: number;
  consecutiveSync: number;
  pilotAmplitude: number;
  pilotPhase: number;
  // Per-tone (4 tones × 2 axes)
  constellation: Array<{ i: number; q: number; freq: number; }>;
  noiseFloor: [number, number, number, number];
  thresholds: [number, number, number, number];
  signalToNoise: number;
  // Audio buffer for FFT
  audioBuffer: Float32Array;
  // Bit stream
  bitsIn: number[];
  decodedBytes: Uint8Array;
  errors: number;  // corrected error count
}
```

**Panel Layout**: Floating sub-windows (like Blender/DAW workspace). Each debug panel is an independent draggable, resizable window. User can position them anywhere, close ones they don't need, arrange their own layout.

Each panel is a small React component mounted into its own portal.

**Mounting**: The existing canvas debug panel stays for backward compat (hidden by default). A new toggle in the toolbar opens the React panel manager, which spawns the floating sub-windows.

```
┌──────────────────────────────────────────────────┐
│ Constellations (4 canvases, one per tone)        │
│   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐          │
│   │ I/Q  │ │ I/Q  │ │ I/Q  │ │ I/Q  │          │
│   │500Hz │ │700Hz │ │900Hz │ │1100Hz│          │
│   └──────┘ └──────┘ └──────┘ └──────┘          │
├──────────────────────────────────────────────────┤
│ FFT Spectrum (live waterfall + current frame)    │
│   ┌──────────────────────────────────────┐       │
│   │  magnitude vs frequency              │       │
│   └──────────────────────────────────────┘       │
├──────────────────────────────────────────────────┤
│ Band Breakdown (per-tone: energy, phase, bits)   │
│   500Hz: ████████  -12 dB   phase:  32°  bits:10│
│   700Hz: ████      -18 dB   phase: 178°  bits:01│
│   900Hz: ██████████ -8 dB   phase:  15°  bits:11│
│  1100Hz: ██        -24 dB   phase: 195°  bits:00│
├──────────────────────────────────────────────────┤
│ Bit Stream I/O                                    │
│   TX: 01001010 01011101 10100101                  │
│   RX: 01001010 01011101 10100101                  │
│   ERR: ········ ········ ········                │
│   Err count: 0 | BER: 0.000% | Corrected: 0      │
├──────────────────────────────────────────────────┤
│ Decoder State (live)                              │
│   Phase: DATA | SNR: 18.5 dB | Pilot: 0.121     │
│   Sync: 0 | Bits: 256 | Flr: 3.2e-10 2.1e-10 ...│
└──────────────────────────────────────────────────┘
```

**Canvas rendering via React**: Use `useRef` + `useEffect` to draw on `<canvas>` elements. The `ScatterCanvas` and `SpectrumCanvas` components wrap canvas drawing logic in React lifecycle.

```typescript
// ScatterCanvas.tsx
interface Props {
  points: Array<{ i: number; q: number; bit: number }>;
  width: number;
  height: number;
}

function ScatterCanvas({ points, width, height }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    // Draw I/Q grid, axes, scatter points colored by bit value
    drawConstellation(ctx, points, width, height);
  }, [points, width, height]);
  return <canvas ref={ref} width={width} height={height} />;
}
```

### 6. Squawk Packets — Periodic Calibration Beacons

**Problem**: Channel conditions drift during transmission (temperature changes speaker impedance, mic moves, someone walks between devices). Static calibration at preamble is insufficient.

**Solution**: Insert short **squawk** packets at regular intervals. Each squawk is a known reference pattern that the decoder uses to recalibrate its pilot lock, AGC gain, phase offset, and per-tone thresholds.

#### Squawk Packet Design

```
[sync 3 sym] [squawk_id 1 sym] [reference_data 4 sym]
Total: 8 symbols = 320 ms at 25 sym/s
```

- **Sync**: Same as transmission sync (all 4 tones ON) — decoder already detects this
- **Squawk ID**: Encodes which squawk (0=initial, 1..N=periodic). Built from known constellation points
- **Reference data**: 4 symbols of known I/Q points (all possible phase/amplitude combinations) — the decoder measures what it receives vs what was sent, computes correction

#### Squawk Schedule

| Position | Purpose |
|----------|---------|
| **Preamble squawk** (before file header) | Set initial AGC gain, pilot lock, phase reference, per-tone noise floor |
| **Header squawk** (after file name, before payload) | Confirm decoder is still locked after reading variable-length filename |
| **Data squawks** (every 32 payload symbols ≈ 1.3s) | Recalibrate: fine-tune pilot phase, adjust AGC for volume drift, recompute per-tone thresholds |
| **Final squawk** (after payload, before done) | Confirm end-of-file, provide SNR measurement for confidence |

#### Decoder Squawk Processing

```typescript
// PilotTracker processes squawk symbols:
//   1. During squawk sync, lock PLL to pilot with tighter bandwidth
//   2. During squawk reference, measure actual I/Q vs expected I/Q
//   3. Compute correction matrices for this transmission burst:
//      phaseCorrection = atan2(expectedI * actualQ - expectedQ * actualI,
//                             expectedI * actualI + expectedQ * actualQ)
//      amplitudeCorrection = expectedAmp / actualAmp
//   4. Apply correction to all subsequent data symbols until next squawk
//
// The decoder also tracks squawk-to-squawk drift. If a single squawk
// deviates >30° phase or >50% amplitude from the previous, flag a burst
// error and apply extra interleaving margin to the next data block.
```

#### Debug View for Squawks

```
Squawk #3  |  Phase corr: +2.1°  |  Amp corr: 0.97×  |  Pilot SNR: 24.3 dB
Squawk #4  |  Phase corr: -1.8°  |  Amp corr: 1.02×  |  Pilot SNR: 23.8 dB
```

Shown in the DecoderState panel so the user can see channel stability.

#### Encoder Changes

```typescript
// Encoder.squawkInterval = 32 symbols (≈1.3s)
// After every squawkInterval data symbols, inject 8 squawk symbols.
// The decoder must know the schedule — it's fixed in ModemConfig:
//
// export interface SquawkConfig {
//   intervalSymbols: number;  // 32 = every ~1.3s at 25 sym/s
//   squawkSymbols: number;    // 8 symbols per squawk
//   referencePattern: Array<{ amplitude: number; phase: number }[]>;
// }
//
// Total throughput cost: 8 squawk sym / (32 data sym + 8 squawk sym) = 20% overhead
// But this keeps the link rock-solid through channel variation.
```

#### Adaptive Squawk Rate

If the decoder detects rapid channel change (large corrections between consecutive squawks), it requests a faster squawk rate via an **out-of-band signaling tone** (a 9th frequency no longer used for data — e.g., 1300 Hz, pulsed at a specific cadence to encode integers). The encoder can modulate this tone briefly after playback to signal "increase squawk rate to every 16 symbols".

For now, implement fixed squawk rate first. Adaptive rate is Phase G.

---

### 7. Dictionary-Based Compression for Known File Types

**Problem**: Raw bit slinging wastes throughput for structured data like text (ASCII is 7 bits/byte but we send 8) or headers (repeated patterns like HTTP headers, PNG magic bytes).

**Solution**: A shared dictionary on both encoder and decoder sides that maps common byte patterns to short codewords. The dictionary is file-type-aware, selected by the preamble's metadata (`fileType` field).

#### Dictionary Architecture

```
┌─ File Type ─────────────────────────────────────────────────────┐
│  txt:  ASCII-specific compression (7-bit packing, common words) │
│  bin:  No dictionary — raw bit stream (fallback)                │
│  html, js, css:  LZ-style on common tokens                     │
│  png, jpg, gif:  Header pattern matching (magic bytes)         │
│  json, xml:      Structural token compression                  │
│  custom:         Hash-based adaptive dictionary (built on fly)  │
└─────────────────────────────────────────────────────────────────┘
```

#### How It Works

1. **At encode time** (before preamble):
   - Detect file type from extension in the file name
   - If a dictionary exists for that type, compress payload with it
   - Set `dictScheme` byte in the preamble to identify which dictionary was used
   - Encode with the modem as usual

2. **At decode time** (after preamble parsed):
   - Read `dictScheme` byte
   - Apply inverse dictionary to decompress payload
   - Fall through to normal CRC verification

3. **Dictionary mismatch safety**:
   - CRC is computed on the *uncompressed* payload (pre-compression)
   - If dictionary decompression fails (e.g., decoder missing dictionary), CRC will fail
   - **Fallback**: If the receiver doesn't recognize `dictScheme`, it silently falls back to raw mode — sends uncompressed payload. The transmission succeeds, just without compression.
   - If decompression produces garbage, CRC will mismatch and the receiver requests retransmit with `dictScheme=0x00` (no compression, explicit)

#### Built-in Dictionaries

##### ASCII Text (.txt, .md, .csv) — Primary Dictionary

```
ASCII bytes are 7-bit, but stored as 8. The dictionary:
  - Strips the MSB (always 0 for standard ASCII) → 7 bits/byte
  - Common ASCII words mapped to short tokens:
    'the '    → 0x00
    ' and '   → 0x01
    'that '   → 0x02
    ' with '  → 0x03
    ' from '  → 0x04
    ' this '  → 0x05
    ' is '    → 0x06
    ' in '    → 0x07
    'a '      → 0x08  (common single-char word)
    'to '     → 0x09
    'of '     → 0x0A
    'for '    → 0x0B
    '\r\n'    → 0x0C
    '\n'      → 0x0D
    ' '       → 0x0E  (single space — very high frequency)
    EOF       → 0x0F
  
  - Longer common words via multi-token sequences
  - Fallback: 7-bit packed bytes if not in dictionary
  
  Expected compression ratio: ~60-70% for English text
  (i.e., 100 bytes of text → ~60-70 compressed bytes)
```

##### Structured Text (.html, .json, .xml)

```
Repeated structural tokens:
  '<'     → 0x00
  '>'     → 0x01
  '</'    → 0x02
  '/>'    → 0x03
  '="'    → 0x04
  '">'    → 0x05
  '<html' → 0x06
  '<head' → 0x07
  '<body' → 0x08
  '<div'  → 0x09
  '<span' → 0x0A
  '<a '   → 0x0B
  '<img'  → 0x0C
  '<p>'   → 0x0D
  'class' → 0x0E
  'id'    → 0x0F
  ...
  Expected: ~50-60% for markup-heavy content
```

##### Binary Headers (.png, .jpg, .gif, .pdf)

```
Detect magic bytes, compress known header structures:
  PNG: 8-byte signature → 1 byte token
  PNG chunk types (IHDR, IDAT, IEND) → 1-2 byte tokens
  JPEG SOI+APP0 markers → tokens
  Expected: negligible for small files, ~10-20% for large with many chunks
```

##### Adaptive Dictionary (future)

For unknown types or when the encoder detects patterns in the data:

1. **Encoder scans payload** for repeating byte sequences >2 bytes long
2. **Builds a frequency-ordered dictionary** of the top 16-64 patterns
3. **Transmits the dictionary** as part of the preamble: `[dictEntries:2B][entry0_len:1B][entry0_data...][entry1_len:1B][entry1_data...]...`
4. **Decoder stores the dictionary** for this transmission, uses it to decompress
5. This adapts to any file type without prior knowledge

Cost: ~200 bytes to transmit a 16-entry dictionary, but pays off for payloads >1KB.

#### Self-Framing Block Format

Every logical structure (squawk, config header, dictionary, payload data, EOF marker) is wrapped in a self-framing block. This is the key mechanism that prevents the decoder from misinterpreting data when it enters sync at the wrong symbol boundary.

```
┌─ Frame Block ──────────────────────────────────────────────┐
│  SENTINEL: 16-bit magic number (0xE7 0x9F)                │
│    → bit pattern: 11100111 10011111                       │
│    → Chosen for high autocorrelation distance — Hamming    │
│      distance ≥ 4 from any shifted version of itself.     │
│    → Decoder scans bitstream for this pattern to find      │
│      block boundaries, even without symbol alignment.      │
│                                                            │
│  BLOCK_TYPE:  8 bits                                      │
│    0x01 = Squawk (calibration beacon)                     │
│    0x02 = Config Header (file metadata)                   │
│    0x03 = Dictionary Data (adaptive dictionary entries)   │
│    0x04 = Payload Data (compressed file chunks)           │
│    0xFF = EOF (end of transmission marker)                │
│                                                            │
│  BLOCK_LEN: 16 bits (little-endian, length of DATA only)  │
│    → decoder reads exactly this many bytes for the data   │
│    → if block_len exceeds max_block, decoder discards     │
│      (safety against bit errors making an insane length)  │
│                                                            │
│  DATA: BLOCK_LEN bytes of payload (BCH-encoded)           │
│    → Squawk:   [squawk_id:1B][ref_i:2B][ref_q:2B] = 5B   │
│    → Config:   [nameLen:2B][name:L][totalSize:4B]         │
│                 [dictScheme:1B][crc32:4B] = 11+L B       │
│    → Dict:     [entries:2B][entry0_len:1B][entry0...]...  │
│    → Payload:  compressed bytes (typically 13-16B)        │
│    → EOF:      (empty)                                    │
│                                                            │
│  BLOCK_CRC: 16-bit CRC of (TYPE | LEN | DATA)             │
│    → If CRC fails, decoder discards this block and scans   │
│      for next SENTINEL in the bit stream.                 │
│    → This is why it's self-framing: even if the decoder    │
│      locks onto garbage that looks like SENTINEL, the CRC  │
│      will fail and it keeps scanning — it never emits      │
│      corrupted dict info to the decompressor.             │
└────────────────────────────────────────────────────────────┘
```

```
Total block overhead: 2 (sentinel) + 1 (type) + 2 (len) + 2 (crc) = 7 bytes per block
For a 13-byte payload block: 7/20 = 35% framing overhead (acceptable for reliability)

At 8 bits/sym × 0.52 (ECC): 1 block = 7+13 = 20 encoded bytes = 40 raw symbols ÷ 8 bits/sym = 5 symbols framing + ~3 payload symbols
```

#### Sentinel Detection (Bit-Level Scanning)

**Decision**: 16-bit sentinel (0xE79F) + 16-bit CRC guard. False positives are harmlessly discarded by CRC mismatch.

The decoder does **not** rely on symbol alignment to find blocks. Instead:

1. Every decoded frame produces 8 raw bits (the per-symbol bit pattern)
2. Bits are fed into a **sliding 16-bit shift register**
3. After every new bit, the register is compared against the sentinel pattern (0xE79F)
4. On match, the decoder reads the next 5 bytes (type + len + len) from the bit stream
5. It then reads `block_len` bytes of data
6. Then reads 2 bytes of CRC
7. Computes CRC over (type + len + data) and compares
8. If match: process the block. If not: discard, resume scanning for next sentinel

This means the decoder can start reading from **any bit position** and will find the first valid block within at most `2^16 / (block_size)` attempts. In practice, at 25 sym/s = 200 bits/s, the scan takes at most ~300ms to find a block.

#### Why This Prevents the Dictionary Problem

Scenario: Decoder enters data mode 1 symbol late (misaligned by 8 bits).

- **Without sentinels**: `dictScheme` byte is read from bits 8-15 of the wrong symbol. Decoder picks wrong dictionary. CRC on payload fails. Whole transmission wasted.
- **With sentinels**: The 16-bit shift register shifted by 8 bits will **not** match 0xE79F (Hamming distance >4 means even a 1-bit mismatch fails). The decoder keeps scanning. After ~3-5 symbols it finds the real sentinel, reads the correct `dictScheme`, processes the block correctly. Any symbol consumed during the scan that didn't match sentinel is simply discarded.

#### DictScheme Values

| Value | Meaning |
|-------|---------|
| 0x00  | No compression (raw bytes) — fallback |
| 0x01  | ASCII text dictionary (common words + 7-bit packing) |
| 0x02  | HTML/XML/SGML dictionary |
| 0x03  | JSON dictionary |
| 0x04  | Binary header dictionary (magic bytes + chunk types) |
| 0x10-0x1F | Adaptive dictionary index 0-15 (dictionary data follows in separate Type=0x03 block) |
| 0xFF  | Reserved (no compression, explicit) |

If `dictScheme !== 0x00`, the decoder decompresses the payload before final CRC verification.

#### Squawk-Gated Block Reading

Even with sentinels, the decoder only **processes** (acts on) blocks when the decoder is in a confirmed sync state:

| Decoder State | Blocks Accepted | Blocks Ignored |
|---------------|-----------------|----------------|
| NOISE_PROFILING | None | All (discard) |
| SYNC_PENDING (consecutiveSync ≥ 3 but < 8) | Type=0x01 (Squawk) only — uses squawk to confirm lock | Type=0x02/0x03/0x04/0xFF discarded |
| LOCKED (consecutiveSync ≥ 8 + squawk verified) | All types accepted | — |
| IN_FRAME (data mode) | Type=0x01 (Squawk — recalibrate) + Type=0x04 (Payload) + Type=0xFF (EOF) | Type=0x02/0x03 ignored (already processed) |

This dual gate (sentinel + state machine) ensures no dictionary data is ever read without proper synchronization.

#### Decoder Block Processing Flow

```typescript
// In broadcast.worker.ts Decoder:

private shiftRegister = 0;  // 16-bit sliding window
private scanForSentinel = true;
private pendingBlock: { type: number; len: number; data: number[] } | null = null;
private blockBytes: number[] = [];
private blockPhase: 'SCAN' | 'HEADER' | 'DATA' | 'CRC' = 'SCAN';

feedBit(bit: number) {
  this.shiftRegister = ((this.shiftRegister << 1) | bit) & 0xFFFF;
  
  if (this.blockPhase === 'SCAN') {
    if (this.shiftRegister === SENTINEL_0xE79F) {
      this.blockPhase = 'HEADER';
      this.blockBytes = [];
      this.expectedBytes = 3; // type(1) + len(2)
    }
    return;
  }
  
  if (this.blockPhase === 'HEADER') {
    this.blockBytes.push(bit);
    if (this.blockBytes.length >= 8 * this.expectedBytes) {
      const type = this.blockBytes[0];
      const len = (this.blockBytes[1] << 8) | this.blockBytes[2];
      if (len > MAX_BLOCK_LEN) { this.blockPhase = 'SCAN'; return; }
      this.pendingBlock = { type, len, data: [] };
      this.blockPhase = 'DATA';
      this.expectedBytes = len;
      this.blockBytes = [];
    }
    return;
  }
  
  if (this.blockPhase === 'DATA') {
    this.blockBytes.push(bit);
    if (this.blockBytes.length >= 8 * this.expectedBytes) {
      this.pendingBlock!.data = this.blockBytes;
      this.blockPhase = 'CRC';
      this.expectedBytes = 2;
      this.blockBytes = [];
    }
    return;
  }
  
  if (this.blockPhase === 'CRC') {
    this.blockBytes.push(bit);
    if (this.blockBytes.length >= 16) {
      const crc = (this.blockBytes[0] << 8) | this.blockBytes[1];
      this.blockPhase = 'SCAN';
      
      // Verify CRC
      const computed = this.blockCRC(this.pendingBlock!);
      if (crc === computed) {
        this.processBlock(this.pendingBlock!);
      }
      // CRC fail → silently discard, resume scan
      this.pendingBlock = null;
    }
    return;
  }
}
```

This is the **only** path where dictionary config enters the system. No sync = no sentinel match = no block processing = no dictionary read.

#### Implementation Order

1. First: **No compression by default** (dictScheme=0x00) — get the modem working, prove squawk + self-framing
2. Second: **ASCII text dictionary** — easiest win, C-like string processing
3. Third: **Adaptive dictionary** — runtime scan + transmit
4. Last: **Structured text dictionaries** — HTML/JSON/XML

---

### 8. Revised Frame Layout (with Self-Framing Blocks)

Putting it all together, the new transmission frame uses self-framing blocks throughout:

```
┌─ Frame ─────────────────────────────────────────────────────────────┐
│  Leader (~0.5s pilot only)                                          │
│  ┌─ Block: Squawk 0 (Type=0x01, Initial Calibration) ──────────┐   │
│  │  SENTINEL(2) | TYPE=0x01(1) | LEN=4(2)                       │   │
│  │  | squawk_id(1) | reference_iq(3) | BLOCK_CRC(2) = 11 sym   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌─ Block: Config Header (Type=0x02) ──────────────────────────┐   │
│  │  SENTINEL(2) | TYPE=0x02(1) | LEN=8+nameLen(2)              │   │
│  │  | nameLen(2) | fileName(L) | totalSize(4) | dictScheme(1)  │   │
│  │  | BLOCK_CRC(2)                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌─ Block: Adaptive Dict (Type=0x03, only if dictScheme≥0x10) ─┐   │
│  │  SENTINEL(2) | TYPE=0x03(1) | LEN=N(2)                       │   │
│  │  | dict_entries... | BLOCK_CRC(2)                             │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌─ Block: Squawk 1 (Type=0x01, Post-Preamble) ───────────────┐   │
│  │  SENTINEL(2) | TYPE=0x01(1) | LEN=4(2) | ... | CRC(2)      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌─ Block: Payload Data 0 (Type=0x04) ────────────────────────┐   │
│  │  SENTINEL(2) | TYPE=0x04(1) | LEN=payloadLen(2)            │   │
│  │  | 32 symbols of compressed payload | BLOCK_CRC(2)         │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌─ Block: Squawk 2 (Type=0x01, Mid-Transmission) ───────────┐   │
│  │  SENTINEL(2) | TYPE=0x01(1) | LEN=4(2) | ... | CRC(2)      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ┌─ Block: Payload Data 1 (Type=0x04) ────────────────────────┐   │
│  │  SENTINEL(2) | TYPE=0x04(1) | LEN=payloadLen(2) | ...      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  ... repeat payload+squawk until data exhausted ...                │
│  ┌─ Block: EOF (Type=0xFF) ───────────────────────────────────┐   │
│  │  SENTINEL(2) | TYPE=0xFF(1) | LEN=0(2) | CRC(2) = 7 sym    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│  Done (pilot off after brief tail)                                 │
└────────────────────────────────────────────────────────────────────┘
```

**Timing at 25 sym/s** (with framing):
- Leader: 0.5s
- Per squawk block: 11 symbols = 0.44s
- Per config block: 7+fixed fields symbols
- Per data block: 7+32 = 39 symbols = 1.56s (32 payload + 7 framing)
- Per EOF block: 7 symbols = 0.28s
- Overall throughput (32 data sym per block, one squawk per block):
  - Data per block: 32 sym × 8 bits/sym × 0.52 (ECC) × 0.8 (squawk) = ~106 effective data bits = ~13 bytes
  - Block duration: 11 (squawk) + 39 (data) = 50 sym = 2.0s
  - Throughput: ~6.5 byte/s = ~52 bit/s (conservative, includes all overhead)
  - With dictionary compression (1.3-1.5× on text): ~8-10 byte/s



---

## Implementation Order (Revised)

### Phase A — Foundation (Critical Path)

1. **Add React dependencies**
2. **Update `tsconfig.json`** — add `"jsx": "react-jsx"`
3. **Enable pilot in encoder** — `pilotAmplitude: 0.125`  ✅ DONE
4. **Build `PilotTracker`** — PLL-based pilot phase/amplitude tracking  ✅ DONE (now `pilot.ts`)
5. **Change decoder to pilot-relative** — use PilotTracker for all tone measurements  ✅ DONE

### Phase B — Self-Framing Block Protocol

6. **Define block format** — sentinel (0xE79F), type, length, data, CRC in `types.ts`
7. **Build `framing.ts`** — block encoder (wraps raw bytes in sentinel+type+len+crc) and bit-level sentinel scanner for decoder
8. **Build `blockProcessor.ts`** — dispatches decoded blocks by type: config→preamble parser, payload→byte buffer, EOF→flush
9. **Wire framing into decoder** — replace raw bit collector with FramedBlockDecoder state machine
10. **Wire framing into encoder** — wrap every logical unit (config, payload chunk) in sentinel+type+len+CRC before ECC

### Phase C — Comprehensive Debug & Diagnostics

11. **Build `debugger.ts`** — centralized debug logging system:
    - **Per-stage pipeline logging**: every encoder/decoder stage emits structured log events
      - `PILOT_SCAN` — candidate freqs, magnitudes, noise floor, selected freq + confidence
      - `PILOT_LOCK` — PLL frequency, phase, amplitude, loop filter state
      - `SYNC_DETECT` — frame energies, consecutive count, burst threshold, all-four-strong check
      - `BLOCK_SENTINEL` — sentinel match position, block type, length, CRC pass/fail
      - `BLOCK_PROCESS` — block type dispatch, data length, handler result
      - `FRAME_BITS` — per-tone relI, relQ, amplitude decision, phase decision, raw bit pattern (8 bits)
      - `ECC_DECODE` — codeword bits, syndrome, corrected errors, final nibble
      - `SQUAWK_CAL` — pre/post phase correction, amplitude correction, drift since last
      - `END_DETECT` — SNR, frames-since-strong, bits trimmed, emit trigger
    - **Ring buffer**: keeps last N events per stage (configurable, default 500)
    - **Log levels**: `DEBUG`, `INFO`, `WARN`, `ERROR` — each stage has a minimum level
    - **Filterable by stage**: e.g. `debugger.enable('SYNC_DETECT')` or `debugger.disable('FRAME_BITS')`

12. **Build `diag.ts`** — diagnostics tools:
    - **State snapshot**: one-shot dump of full decoder state (all fields, all config, ring buffer tail)
    - **Timing profiler**: per-stage wall-clock timing (min/max/avg over last N calls)
    - **BER tracker**: running bit error count (expected vs received) per symbol, per byte, per block
    - **Constellation sampler**: captures last N I/Q points per tone (for scatter plot data)

13. **Build `compressForLLM.ts`** — compressed output formatter for LLM context:
    ```
    Input: Full debug ring buffer (500 events × 50 bytes = ~25KB raw)
    Output: ~2-3KB structured summary:
    [PILOT] freq=62.5Hz amp=0.121 conf=0.92 N=1024
    [SYNC] frames=8/10 strong=t peak_ratio=0.31/0.08/0.16/0.21 burst_thr=2.1e-11
    [BLK] 3/12 OK crc_fail=0 type_dist={01:2,02:1,04:9,FF:1}
    [BER] raw=0.023 corr=0.004 total_bits=4096 err_raw=94 err_corr=16
    [ECC] codewords=512 syndrome_fix=78/512 (15.2%) double_err=2/512 (0.4%)
    [SQWK] n=4 avg_drift=0.8deg max_drift=2.1deg amp_recovery=0.97x
    [PLL] phase_std=0.032 amp_std=0.004 lock_quality=0.97
    ```
    - Level-based compression:
      - `brief`: 1 line per stage, key metrics only (~500 bytes)
      - `normal`: 2-3 lines per stage, includes warnings and anomalies (~2KB)
      - `verbose`: full ring buffer with filters applied (~5-10KB)
    - Anomaly highlighting: any value exceeding configurable thresholds gets `⚠️` prefix
    - Designed for direct paste into LLM context with zero explanation needed

14. **Wire debugger into all stages**:
    - `PilotScanner` → `debugger.log('PILOT_SCAN', ...)`
    - `PilotPLL` → `debugger.log('PILOT_LOCK', ...)`
    - `Decoder.feedSample()` → `debugger.log('SYNC_DETECT', ...)` and `debugger.log('FRAME_BITS', ...)`
    - `FramedBlockDecoder` → `debugger.log('BLOCK_SENTINEL', ...)`
    - `BlockProcessor` → `debugger.log('BLOCK_PROCESS', ...)`
    - `emitFrame()` → `debugger.log('ECC_DECODE', ...)`
    - `SquawkProcessor` → `debugger.log('SQUAWK_CAL', ...)`
    - End detection → `debugger.log('END_DETECT', ...)`
15. **Wire diagnostics into UI**: "🛠 Debug" area gets:
    - "📋 Dump State" button → copies full diagnostic snapshot to clipboard
    - "🤖 Compress for LLM" button → copies compressed summary to clipboard
    - Level selector: Brief / Normal / Verbose
    - Stage filter toggles: which stages produce console output
    - Live BER display in status bar
16. **Document the compressed format** so LLM analysis prompts can reference the field layout

### Phase D — Squawk System

17. **Build `squawk.ts`** — reference pattern generation + decoder processing
18. **Add squawk injection to encoder** — framed blocks (Type=0x01) at fixed interval
19. **Add squawk processing to decoder** — recalibrate pilot lock, AGC, phase offset via sentinel-guarded blocks
20. **Wire squawk events** → `debugger.log('SQUAWK_CAL', ...)` (leveraging Phase C)
21. **Demonstrate squawk effect** — debug view shows correction values per squawk

### Phase E — Robust Self-Test System (Channel Simulator)

22. **Build `channel.ts`** — acoustic channel simulator:
    - **AWGN** at configurable SNR (-10 to +40 dB)
    - **Multi-path / echo**: configurable delay (0-50ms) + attenuation (0-100%)
    - **Frequency offset** (Doppler): ±0.1-10 Hz shift
    - **Amplitude modulation**: simulate volume drift (slow sine or ramp)
    - **Phase noise**: random jitter per sample (configurable stddev)
    - **Band-limiting**: low-pass filter at configurable cutoff (simulates speaker/mic FR)
    - **Impulse noise**: random pops/clicks at configurable rate
23. **Build `testHarness.ts`** — full pipeline test harness:
    - **Clean mode**: encode → decode (no channel, tests basic pipeline integrity)
    - **Simulated mode**: encode → channel.simulate(samples, options) → decode
    - **Batch mode**: sweep SNR -10 to +40 dB, report BER per stage
    - **All metrics pulled from debugger + diag** (leveraging Phase C ring buffer)
24. **Wire test harness into UI**: "🧪 Self-Test" dropdown:
    - "Clean Loopback" | "Noisy SNR=5dB" | "Noisy SNR=15dB"
    - "Multi-path (20ms echo)" | "Doppler +3Hz"
    - "Sweep SNR → BER plot" | "Full Stress (all effects)"
25. **Self-test result display** — React panel:
    - Pass/fail, BER (raw+corrected), pilot confidence, sync time
    - Constellation scatter plot, bit error map, timing breakdown
    - **Compressed LLM summary inline** (leveraging Phase C's compressForLLM)

### Phase F — Error Correction

21. **Build `ecc.ts`** — BCH(31,16) encoder/decoder + interleaver depth 8
22. **Wire ECC events** → `debugger.log('ECC_DECODE', ...)` (leveraging Phase C)
23. **Update encoder/decoder** to use new ECC through framed blocks
24. **Update frame structure** — guard symbols aligned to codeword boundaries

### Phase G — Dictionary Compression

25. **Build `dictionary_data.ts`** — static ASCII text dictionary tables
26. **Build `dictionary.ts`** — compress/decompress functions, file-type detection, dictionary selection
27. **Update encoder** — compress payload before wrapping in framed blocks
28. **Update decoder** — decompress after block extraction + CRC verify
29. **Add adaptive dictionary** — runtime scan + transmit in Type=0x03 blocks (lower priority)

### Phase H — Noise Cancellation

30. **Build `noise.ts`** — spectral subtractor, AGC based on pilot amplitude
31. **Integrate noise canceller** into decoder pipeline (test via channel simulator in Phase E)
32. **Adaptive fallback** — if high BER, drop to amplitude-only mode (4 bits/sym)

### Phase I — React Debug UI (Floating Windows)

33. **Build `FloatingWindow` React component** — draggable, resizable, closeable window shell (portaled, z-index managed, mouse-drag header, resize handle)
34. **Create React mount** + root component with window manager
35. **Build hooks** — `useDecoderState`, `useAudioStream`
36. **Build canvas components** — `ScatterCanvas`, `SpectrumCanvas`
37. **Build all panels as FloatingWindow children** — constellation, FFT, band breakdown, bit stream, decoder state, squawk history, self-test results, diagnostics log, LLM compress output
38. **Wire broadcast worker** to emit all debug data (including block decode status, sentinel scan state, constellation I/Q)
39. **Wire debug toggle** — Ctrl+Shift+D opens the floating window manager

### Phase J — Polish & Integration

40. **Update `index.html`** — add mount point, update debug panel structure
41. **Update `app.ts`** — pipe decoder state to React, handle debug toggle, wire test harness
42. **Acoustic path tuning** — tune PLL bandwidth, squawk interval, AGC response using channel simulator

### Phase K — Documentation & Developer Guide

43. **Write `docs/ARCHITECTURE.md`** — high-level system architecture:
    - Signal flow diagram (bits → ECC → block framing → pilot+tones → audio → speaker → mic → FFT → PLL → I/Q → bits → block scan → ECC → file)
    - Data flow through encoder, channel, decoder
    - Module dependency graph
44. **Write `docs/MODEM.md`** — deep modem specification:
    - Pilot: configurable frequency, FFT discovery, PLL tracking, pilot-relative I/Q
    - Tone encoding: 4 tones at pilotFreq + offsets, BPSK (amplitude + phase bits)
    - Frame layout: leader → sync → framed blocks → done
    - Block format: [SENTINEL 0xE79F][TYPE][LEN][DATA][CRC16]
    - Block types: SQUAWK(0x01), CONFIG(0x02), DICT(0x03), PAYLOAD(0x04), EOF(0xFF)
    - Squawk calibration: interval, reference data, correction computation
    - ECC: BCH(31,16) codeword structure, interleaving
45. **Write `docs/DEBUG.md`** — debug and diagnostics guide:
    - Per-stage log events and their fields
    - Compressed LLM output format specification
    - Stage filter toggles and log levels
    - How to interpret constellation I/Q scatter
    - BER tracking and what it means
46. **Write `docs/CHANNEL_SIM.md`** — channel simulator reference:
    - All noise/impairment models and their config parameters
    - How to run batch SNR sweeps
    - Interpreting BER vs SNR curves
47. **Write `docs/API.md`** — public API reference:
    - `ModemConfig` fields and defaults
    - `Encoder.encode()` / `Encoder.encodeToOutputRate()`
    - `Decoder.feedSample()` / `Decoder` options
    - `encodeBlock()` / `FramedBlockDecoder` / `BlockProcessor`
    - `PilotScanner` / `PilotPLL`
    - UI workers: `encoder.worker.ts`, `broadcast.worker.ts`
    - Message protocol between main thread and workers
48. **Update `README.md`** — project overview:
    - New feature summary (pilot-relative, phase encoding, framing, ECC, dictionary)
    - Quick start (dev server, self-test, acoustic test)
    - Current limitations and known issues
    - Link to all docs in `docs/`
49. **Write `docs/LLM_PROMPT.md`** — guide for LLM analysis of debug output:
    - How to prompt an LLM with compressed debug output
    - Example: "Here's a debug dump from a noisy transmission. What's the bottleneck?"
    - Example: "Compare these two BER sweeps — what does the difference in ECC correction rate tell us?"
    - Field-by-field explanation of the compressed format

---

## Updated Key Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Pilot scanner picks wrong frequency | Validate: candidate must have stable energy (variance <20%) over 0.3s and energy >3× noise floor. If no valid pilot found, keep scanning indefinitely. |
| Two transmitters with different pilot freqs overlap | Decoder picks the dominant one (highest sustained energy). Squawk contains pilot freq in its block header — if squawk says a different freq, the decoder re-scans. |
| Pilot tracking loses lock | Squawk every 1.3s re-locks PLL; if 2 consecutive squawks show >45° drift, force re-scan. The PLL has a 10 Hz bandwidth — rejects data-tone modulation. |
| Frequency discovery takes too long | Leader phase is 0.5s of pure pilot — more than enough for Goertzel scan. If no signal present, scanner keeps running and will find pilot as soon as transmission starts. |
| Squawk overhead too high | 20% overhead for rock-solid link; can reduce to 10% (every 64 symbols) if channel is stable |
| Dictionary mismatch (sender has dict, receiver doesn't) | CRC is on uncompressed data — decompression failure ⇒ CRC mismatch ⇒ receiver requests retransmit with dictScheme=0x00 |
| Phase detection noisy at low SNR | BPSK inherently 3dB more robust; fall back to amplitude-only per-tone if decoder sees squawk corrections >20° |
| BCH(31,16) too slow in JS | Precomputed lookup tables for encoding (16×31 matrix) and syndrome decode (2^5 table) — target <0.5ms per codeword |
| Dictionary decompression error | CRC mismatch triggers fallback; user sees "corrupted transfer" and resends with raw mode |
| React panel slows audio | Decoder runs in worker, React snapshot every 200ms — no audio pipeline involvement |

---

## Summary

```
Current:     4 bits/sym, rate 1/2 ECC →  2 data bits/sym    @ 25 sym/s = 50 data bit/s
New:         8 bits/sym, rate 0.52 ECC → ~4 data bits/sym   @ 25 sym/s = 100 data bit/s
              × 0.80 (squawk overhead)  → ~3.2 data bits/sym @ 25 sym/s = 80 data bit/s
              × 1.3-1.6× (dictionary)   → ~4-5 effective data bits/sym = 100-125 effective bit/s

Squawk calibration:  every 32 data symbols (~1.3s), 8-symbol recalibration beacon
  → phase correction, AGC gain, per-tone threshold refresh
  → 20% overhead for vastly improved reliability

Dictionary compression:
  ASCII text:  ~60-70% of original size (1.4-1.5× throughput gain)
  HTML/JSON:   ~50-60% of original size (1.6-1.8× throughput gain)
  Raw binary:  No compression (1.0×) — falls through to raw bit slinging

End-to-end throughput:
  Text files:  ~100-125 bit/s = ~12-15 byte/s  (10KB file ≈ 11-14 min)
  Binary:      ~80 bit/s = ~10 byte/s           (10KB file ≈ 17 min)
  Both with vastly better reliability than current.
```

---

## Debug View: Squawk & Dictionary Panels

Two additional panels in the React debug UI:

### Squawk Status Panel
```
┌─ Squawk History ──────────────────────────────────┐
│ # │ Type  │ Phase Δ │ Amp Δ │ Pilot SNR │ Drift  │
│ 0 │ INIT  │  0.0°   │ 1.00× │  18.2 dB  │ —      │
│ 1 │ POST  │ +2.1°   │ 0.97× │  21.5 dB  │ 0.03°  │
│ 2 │ MID   │ -1.8°   │ 0.99× │  22.1 dB  │ 0.02°  │
│ 3 │ MID   │ +0.5°   │ 1.01× │  23.0 dB  │ 0.01°  │
│ 4 │ FINAL │ +1.2°   │ 1.00× │  24.8 dB  │ 0.01°  │
│ Total drift: 2.3° │ Avg correction: 1.4° │       │
└────────────────────────────────────────────────────┘
```

### Dictionary Status Panel
```
┌─ Dictionary ───────────────────────────────────────┐
│ Scheme:     ASCII Text (0x01)                      │
│ Original:   1,024 bytes                            │
│ Compressed: 691 bytes  (67.5% of original)         │
│ Saved:      333 bytes  (32.5% reduction)           │
│                                                     │
│ Top tokens hit:                                     │
│   'the '     → 0x00  (12 hits)                     │
│   ' and '    → 0x01  ( 8 hits)                     │
│   ' is '     → 0x06  ( 6 hits)                     │
│   '\r\n'     → 0x0C  (18 hits)                     │
└─────────────────────────────────────────────────────┘
```

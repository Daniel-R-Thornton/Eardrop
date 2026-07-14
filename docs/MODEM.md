# Modem Specification

## Overview

The Eardrop modem has two physical layers sharing the same codebase:

| Layer | Modulation | Use | Status |
|-------|-----------|-----|--------|
| **BPSK** | 4 data tones, BPSK, continuous pilot | Production file transfer, legacy | Acoustic-confirmed working |
| **OFDM/QPSK** | N-tone QPSK (8/16/32), continuous pilot | High-throughput (native-rate) | All in-memory tests pass |

The pilot tone runs continuously throughout a transmission as a phase/amplitude reference. In BPSK mode, data tones are at offsets from the pilot (configurable; default 100 Hz spacing). In OFDM mode, data tones are on a 50 Hz absolute grid (2000+ Hz), independent of pilot.

There are two protocol stacks sharing the same physical modulation layer:

| Stack | Use | SPS | Framing | ECC |
|-------|-----|-----|---------|-----|
| **Encoder/Decoder** | Self-test, loopback tests | 128 | Self-framing blocks (sentinel scanner) | BCH(31,16) |
| **TxEngine/RxEngine** | Production file transfer | 256 (BPSK) / native-rate (OFDM) | Atomic frames V2 (BCH header + RS payload) | BCH(63,30) + RS(52,40)×4 |

## Configuration (`ModemConfig` in `types.ts`)

| Field | Default | Description |
|-------|---------|-------------|
| `sampleRate` | 3200 | Modem sample rate (Hz). OFDM uses native hardware rate (48000/44100). |
| `symbolsPerSec` | 25 | Symbol rate |
| `bitsPerFrame` | 8 | Bits per symbol (amplitude + phase, 2 per tone) |
| `pilotEnabled` | true | Enable pilot tone |
| `pilotFreqHz` | 600 | Pilot frequency (Hz). Tones at 700/800/900/1000 Hz. |
| `musical` | false | Use musical-mode tone intervals |
| `pilotAmplitude` | 0.4 | Pilot amplitude (0.125 for BPSK-scale in txEngine) |
| `dataToneAmplitude` | 0.5 | Data tone amplitude |
| `amplitudeThresholdRatio` | 0.3 | Tone ON threshold ratio (legacy) |
| `toneCount` | 4 | Active tones (2, 4; also sets OFDM tone count default when OFDM enabled) |
| `diversityMode` | false | 3× frame repetition for robustness |
| `syncSymbols` | 10 | Sync burst symbols (Encoder path only) |
| `sentinel` | unused | Replaced by `getSentinel()` in framing.ts |
| `squawkIntervalSymbols` | 32 | Legacy |
| `squawkSymbols` | 8 | Legacy |
| `eccScheme` | `bch3116` | ECC scheme (Encoder path) |
| `interleaveDepth` | 8 | Interleaver depth |
| `payloadBlockSymbols` | 32 | Legacy |

## Tone Layout (BPSK Mode)

Offsets from pilot (600 Hz default):

```
TONE_OFFSETS = [100, 200, 300, 400]

Tone 0: 600 + 100  =  700 Hz
Tone 1: 600 + 200  =  800 Hz
Tone 2: 600 + 300  =  900 Hz
Tone 3: 600 + 400  = 1000 Hz
```

All tone frequencies are multiples of 25 Hz — every 128-sample window (3200/25) contains an integer number of cycles, eliminating spectral leakage.

Musical offsets (when `musical: true`): `[87.5, 162.5, 287.5, 487.5]` — producing B4, D5, F5, A5 from a 412.5 Hz pilot.

## Phase Contract (Critical)

Both encoder and decoder use `sin(ωn)` as their phase reference. This is enforced by the shared `PhaseAcc` oscillator (`src/modem/dsp/oscillator.ts`):

```typescript
advance(freqHz, sampleRate): number {
    const v = Math.sin(2 * Math.PI * this.phase);  // sin at OLD phase
    this.phase += freqHz / sampleRate;              // then increment
    return v;
}
```

The decoder's `toneIQ()` correlates with `sin(ωn)` at `idx = 0`. Since both sides use the same reference origin:
- **0° BPSK → positive I** for all tones
- **180° BPSK → negative I** for all tones

No per-tone phase calibration is needed — a single global sign flip during the sync/calibration preamble handles any π ambiguity.

---

## Protocol Stack 1: Encoder/Decoder (Self-Test Path)

Used in loopback tests and the UI self-test. SPS = 128.

### Transmission Structure

```
┌─ Transmission ───────────────────────────────────────────────────┐
│  Leader: ~0.5s of pure pilot                                     │
│  Sync:   10 symbols, all 4 tones ON at 0° BPSK                   │
│  Calibrate: 16 symbols (4 per tone), one tone at a time, 0° BPSK │
│  ┌─ Framed Block 1 (CONFIG) ──────────────────────────────────┐  │
│  │  ECC-encoded file metadata                                  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌─ Framed Block 2 (PAYLOAD) ─────────────────────────────────┐  │
│  │  ECC-encoded file data                                      │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌─ Framed Block 3 (EOF) ─────────────────────────────────────┐  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Self-Framing Block Format

```
[0xE79FE7: 3B] [TYPE: 1B] [LEN: 2B LE] [DATA: N B] [CRC16: 2B]
```

Sentinel: 0xE79FE7 (24 bits). The `FramedBlockDecoder` scans incoming bits with a 24-bit sliding shift register and triggers collection on exact sentinel match.

Block types: SQUAWK(0x01), CONFIG(0x02), DICT(0x03), PAYLOAD(0x04), EOF(0xFF).

CRC: CRC-16-CCITT over TYPE + LEN + DATA.

### BPSK Bit Decision (Decoder)

```typescript
const correctedI = calPhaseFlip[t] < 0 ? -relI[t] : relI[t];
const bit = correctedI < 0 ? 1 : 0;
```

Calibration computes a **global** `calPhaseFlip` (same sign for all 4 tones) during the sync + calibrate phases. With the sin-then-increment phase contract, 0° BPSK gives positive I for all tones, so `calPhaseFlip = 1` is always correct in clean conditions.

---

## Protocol Stack 2: TxEngine/RxEngine (Production Path)

Used for actual file transfer via the encoder/broadcast workers. SPS = 256 (BPSK) or native-rate (OFDM).

### BPSK Transmission Structure

```
┌─ Preamble (generatePreamble in preamble.ts) ────────────────────┐
│  Warble:    1280 samples (40 × 32-sample intervals)             │
│             Encodes 16-bit warble code 0xAC94 via ±50 Hz FSK    │
│                                                                  │
│  Marker:    256 samples — all 4 tones ON full blast              │
│                                                                  │
│  Calibration: 16 frames × 256 samples = 4096 samples            │
│              Gray code sequence through all 16 BPSK permutations │
│              Gray code: [0,1,3,2,6,7,5,4,12,13,15,14,10,11,9,8] │
│                                                                  │
│  Guard:     512 samples — pilot only (2 frames at SPS=256)      │
└──────────────────────────────────────────────────────────────────┘
│
┌─ Header frame (type=0x01) × (1 or 3 with diversity) ───────────┐
│  Payload: [fileID:4B][totalSize:4B][nameLen:1B][fileName...]    │
└──────────────────────────────────────────────────────────────────┘
│
┌─ Data frames (type=0x02) × N × (1 or 3 with diversity) ────────┐
│  Payload: 40-byte file data chunks                               │
└──────────────────────────────────────────────────────────────────┘
│
┌─ Tail frame (type=0x03) × (1 or 3 with diversity) ─────────────┐
│  Signals end of file                                             │
└──────────────────────────────────────────────────────────────────┘
│
  Tail silence: 768 samples
```

### OFDM Transmission Structure

```
┌─ Preamble ──────────────────────────────────────────────────────┐
│  Sync burst: 24 symbols, all tones QPSK 0° (I=+1, Q=0)         │
│  ~600 ms at any hardware rate (symbol = 20ms + 5ms CP)          │
│                                                                  │
│  RX uses first 32 symbols for:                                  │
│    Phase 1: Energy detection (threshold: total tone energy)      │
│    Phase 2: CP correlation for symbol-boundary alignment         │
│    Phase 3: Channel estimation (12-symbol per-tone equalizer)    │
└──────────────────────────────────────────────────────────────────┘
│
┌─ Data frames (235 bytes each) ──────────────────────────────────┐
│  V2 format: [SENTINEL 3B][BCH 24B][RS(52,40)×4 = 208B] = 235B  │
│  Carries 160 payload bytes per frame (68% payload density)      │
└──────────────────────────────────────────────────────────────────┘
│
  Tail silence: 6 symbols
```

### Atomic Frame Format V2 (235 bytes)

```
[SENTINEL: 3B 0xE79FE7] [BCH_HEADER: 24B] [RS_PAYLOAD: 208B (52×4)]
```

- **Sentinel**: 3 bytes, same 0xE79FE7 pattern
- **BCH Header**: 3 × BCH(63,30) codewords protecting 9 header bytes (type, seqNum, totalFrames, CRC-32)
- **RS Payload**: 4 × RS(52,40) blocks — 160 data bytes + 48 parity bytes (corrects up to 6 byte errors per block)

### RxEngine Demodulation (BPSK)

**Warble Detection**: Scans for sustained energy at pilotFreq ± 50 Hz. Cross-correlates against the 16-bit warble code 0xAC94. Threshold: ≥12 matching bits out of 16.

**Preamble State Machine**: WAITING → PREAMBLE → FRAMES → (optional timeout) → COMPLETE or ERROR

**Marker Detection**: Total tone energy > 0.15 triggers calibration start.

**Gray Code Calibration**: 16 consecutive frames, each encoding a different 4-bit Gray code value. The RxEngine computes per-tone I/Q centroids for bit=0 and bit=1 reference vectors via direct averaging:

```
ref0I[t] = mean(I values from frames where tone t had bit=0)
ref1I[t] = mean(I values from frames where tone t had bit=1)
```

**Guard**: 2 frames × 256 samples of pilot-only. RxEngine waits 2 guard frames before entering FRAMES state.

**DBPSK Demodulation**: Differential BPSK using dot product of consecutive frames:
```
dot = prevI * currI + prevQ * currQ
diffBit = dot < 0 ? 1 : 0
```

With centroid fallback when confidence is high (`separation > 1.3`):
```
centBit = nearest_neighbor(currIQ, ref0IQ, ref1IQ)
```

**Sentinel Scanner**: 24-bit sliding shift register with Hamming distance threshold ≤2 for sentinel matching. On match, collects remaining bytes and emits the 235-byte (OFDM) or 79-byte (BPSK) atomic frame for BCH/RS decoding.

### RxEngine Demodulation (OFDM/QPSK)

**Sync Detection**: Total tone energy at OFDM tone frequencies compared against an adaptive threshold (3× noise floor EMA). Must exceed threshold for `syncMinFrames` (8) consecutive windows.

**Symbol-Boundary Alignment**: On sync detection, a CP-based correlation search finds the exact symbol start:
```
findOfdmBlockStart(recent):
  for each offset 0..sps-1:
    score = corr(x[o..o+cp], x[o+fft..o+fft+cp])
  pick offset with max score
```
Sharpness metric (peak/mean correlation) rejects false triggers from periodic hum.

**Channel Training**: 12 sync symbols used to train per-tone amplitude + phase equalizers. Running average of I/Q at the known QPSK 0° constellation point.

**Per-Tone Equalization**: Each data symbol's I/Q is rotated by the negative of the trained channel phase per tone, correcting frequency-selective phase rotation independently.

**Pilot-Referenced Phase Drift Correction**: The pilot tone provides a common-phase-error reference. Phase drift per Hz is computed as `pilotDrift / pilotFreqHz` and applied as a frequency-proportional rotation per tone. This corrects residual oscillator drift without an FLL.

**Decision-Directed Channel Tracking** (configurable, `trackingAlpha = 0.003`): After each hard decision, the per-tone channel estimate is leaky-integrated toward the observed I/Q divided by the nearest QPSK constellation point. Very small alpha ensures wrong decisions don't accumulate.

**Timing Architecture — No Rolling Sync**: The OFDM receiver uses a **sync-once-then-coast** model:
- Initial sync aligns the window grid via CP correlation (single shot)
- No per-symbol timing error detector or FLL for sample-timing adjustment
- The 5 ms CP (240 samples at 48 kHz) provides ~20% guard against clock drift
- At 50 ppm worst-case drift (~2.4 samples/s), ~100 seconds before the window drifts out of the CP
- A sync-loss watchdog resets to WAITING if no frame is seen for ~15 seconds

### Diversity Mode

When `diversityMode: true`, every frame is transmitted 3 times consecutively:
```
header ×3, payload1 ×3, payload2 ×3, ..., tail ×3
```

The RxEngine deduplicates:
- **Headers**: Skip duplicate headers with same fileID
- **Payloads**: Skip duplicate sequence numbers via `receivedPayloadSeqs` set
- **Tails**: Skip after file already completed

This provides 3× redundancy at the cost of 3× transmission time. No voting/consensus — just repetition with first-copy-wins.

---

## Pilot Handling

**Encoder/Decoder path**: Pilot frequency is set from `ModemConfig.pilotFreqHz` (600 Hz default). A second-order PLL (`PilotPLL` in `modem/pilot.ts`) tracks pilot phase for amplitude estimation, but the data path uses raw I/Q directly — no pilot-relative rotation is needed because the phase contract ensures consistent signs.

**TxEngine/RxEngine path**: Same pilot frequency. PLL is initialized on first sample and updated continuously for amplitude tracking.

**OFDM path**: Pilot at 1900 Hz (below the data band). Used for phase-drift correction per symbol. Pilot amplitude is 2.0 (fixed in OFDM_TUNING, separate from the BPSK pilot amplitude).

---

## Error Correction

| Path | Scheme | Correction Power |
|------|--------|-----------------|
| Encoder/Decoder | BCH(31,16) + interleave depth 8 | 3 bit errors per 31-bit codeword |
| TxEngine/RxEngine | BCH(63,30) × 3 + RS(52,40) × 4 | 3 bit errors per BCH codeword + 6 byte errors per RS block |

---

## OFDM/QPSK Mode (Native-Rate)

Time-domain OFDM with QPSK per subcarrier. Symbols are defined in milliseconds rather than samples, so the protocol adapts automatically to any hardware sample rate (48000 Hz, 44100 Hz, etc.).

### Architecture

- **Symbol length**: 20 ms + 5 ms cyclic prefix = 25 ms total (~40 sym/s)
- **Modulation**: Direct cosine synthesis at exact tone frequencies (no IFFT)
- **Demodulation**: Goertzel / toneIQ bank at exact tone frequencies (no FFT)
- **Tone grid**: Multiples of 50 Hz (1000 / 20 ms), guaranteeing orthogonality at any sample rate
- **Pilot**: Continuous pilot at 1900 Hz, used for per-tone channel equalization and phase drift correction

### Protocol Constants

| Parameter | Value |
|-----------|-------|
| `OFDM_SYMBOL_MS` | 20 ms |
| `OFDM_CP_MS` | 5 ms |
| `pilotFreqHz` | 1900 Hz |
| `pilotAmplitude` | 2.0 |
| `toneSpacingHz` | 50 Hz |
| `toneStartHz` | 2000 Hz |
| `toneCount` default | 32 |
| Sync burst | 24 symbols (~600 ms) |
| Training symbols | 12 |
| Sync detection windows | 8 consecutive above-threshold |
| Raw bitrate (16 tones) | 1280 bps |
| Raw bitrate (32 tones) | 2560 bps |
| Net payload rate (32 tones) | ~1707 bps (166 B/s) |
| Frame format V2 | [SENTINEL 3B][BCH 24B][RS(52,40)×4 = 208B] = 235B carrying 160 payload B |
| Payload density | 68% |
| Symbol alignment | CP correlation (single-shot, no rolling tracking) |
| Channel tracking | Decision-directed per-tone equalization (α = 0.003) |
| Phase drift correction | Pilot-referenced, frequency-proportional |

### Tone Grid

Tones are at `2000 + n * 50` Hz for n = 0 … toneCount-1. With default 32 tones: 2000, 2050, 2100, …, 3550 Hz. The pilot is at 1900 Hz, below the data band. All frequencies — pilot and tones — are exact multiples of 50 Hz for orthogonality with the 20 ms symbol.

### Throughput Benchmark (2000-byte file, 48 kHz)

| Config | 16 tones | 32 tones |
|--------|----------|----------|
| Baseline (45ms symbol, 79B frame) | 41.5 B/s | 80.8 B/s |
| + 4 RS blocks (235B frame) | 48.6 B/s | 92.6 B/s |
| + 20ms symbol (25ms total) | **87.4 B/s** | **166.7 B/s** |
| Overall gain vs baseline | ×2.1 | ×2.1 |

### Sample Rate Adaptivity

Symbol length in samples is `Math.round(sampleRate * OFDM_SYMBOL_MS / 1000)` and CP in samples is `Math.round(sampleRate * OFDM_CP_MS / 1000)`. At 48000 Hz: 960-sample symbol + 240-sample CP = 1200 samples. At 44100 Hz: 882 + 221 = 1103 samples. The Goertzel/toneIQ bank operates at the exact tone frequencies regardless of sample rate.

### Timing Recovery: Sync-Once-Then-Coast

The OFDM receiver currently lacks a rolling timing tracking loop. After initial acquisition:

1. **CP correlation** determines the symbol boundary at sync time
2. All subsequent windows are consumed at a fixed stride (`sps` samples)
3. **Pilot phase drift correction** handles sub-carrier rotation but does **not** adjust the window stride
4. **Decision-directed channel tracking** adjusts per-tone phase/amplitude estimates symbol-by-symbol
5. A **sync-loss watchdog** resets to WAITING if no frames arrive within ~15 seconds

The 5 ms CP provides a 240-sample timing guard at 48 kHz. At 50 ppm clock drift between devices (~2.4 samples/s), the system has ~100 seconds before the window drifts outside the CP — sufficient for typical file transfers. Future work could add a timing error detector + FLL for indefinite transmission.

---

## Test Coverage

| Test File | Path | Status |
|-----------|------|--------|
| `loopback.test.ts` | Encoder→Decoder | ✓ |
| `pipeline.test.ts` | Encoder→Decoder + channel sim | 3 known failures (Doppler ±2Hz, Full Stress) |
| `production.test.ts` | TxEngine→RxEngine | ✓ |
| `diversity.test.ts` | TxEngine→RxEngine + 3× repetition | ✓ |
| `ofdm_loopback.test.ts` | OFDM modulation→demodulation | ✓ |
| `ofdm_sync.test.ts` | OFDM sync detection/training | ✓ |
| `ofdm_endtoend.test.ts` | Full OFDM encode→decode | ✓ |
| `ofdm_native_rate.test.ts` | Cross-rate (48kHz→44.1kHz) | ✓ |
| `ofdm_pilot_level.test.ts` | Pilot amplitude in OFDM | ✓ |
| `ofdm_acoustic_path.test.ts` | Simulated acoustic channel | ✓ |
| `ofdm_channel_drift.test.ts` | Frequency drift tolerance | ✓ |
| `ofdm_training.test.ts` | Channel estimation training | ✓ |
| Atomic frame V2 | Frame geometry tests | ✓ |
| Tuning invariants | OFDM tuning constraint checks | ✓ |

**Total**: 127 tests (124 pass, 3 pre-existing BPSK pipeline failures).

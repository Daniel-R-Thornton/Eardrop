# Modem Specification

## Overview

The Eardrop modem uses BPSK on 4 data tones with a continuous pilot reference. A pilot tone runs throughout the transmission at a fixed frequency. Data tones are at fixed offsets from the pilot. 1 phase bit per tone × 4 tones = 4 data bits per symbol (amplitude bits are hardcoded ON — always active BPSK).

There are two protocol stacks sharing the same physical modulation layer:

| Stack | Use | SPS | Framing | ECC |
|-------|-----|-----|---------|-----|
| **Encoder/Decoder** | Self-test, loopback tests | 128 | Self-framing blocks (sentinel scanner) | BCH(31,16) |
| **TxEngine/RxEngine** | Production file transfer | 256 | Atomic frames (BCH header + RS payload) | BCH(63,30) + RS(52,40) |

Both use the shared `PhaseAcc` oscillator (`oscillator.ts`) with a strict **sin-then-increment** phase contract matching the decoder's `toneIQ()` reference.

## Configuration (`ModemConfig` in `types.ts`)

| Field | Default | Description |
|-------|---------|-------------|
| `sampleRate` | 3200 | Modem sample rate (Hz) |
| `symbolsPerSec` | 25 | Symbol rate |
| `bitsPerFrame` | 8 | Bits per symbol (amplitude + phase, 2 per tone) |
| `pilotEnabled` | true | Enable pilot tone |
| `pilotFreqHz` | 412.5 | Pilot frequency (Hz) |
| `musical` | false | Use musical-mode tone intervals |
| `pilotAmplitude` | 0.4 | Pilot amplitude |
| `dataToneAmplitude` | 0.5 | Data tone amplitude |
| `amplitudeThresholdRatio` | 0.3 | Tone ON threshold ratio (legacy) |
| `toneCount` | 4 | Active tones (2 or 4) |
| `diversityMode` | false | 3× frame repetition for robustness |
| `syncSymbols` | 10 | Sync burst symbols (Encoder path only) |
| `sentinel` | unused | Replaced by `getSentinel()` in framing.ts |
| `squawkIntervalSymbols` | 32 | Legacy |
| `squawkSymbols` | 8 | Legacy |
| `eccScheme` | `bch3116` | ECC scheme (Encoder path) |
| `interleaveDepth` | 8 | Interleaver depth |
| `payloadBlockSymbols` | 32 | Legacy |

## Tone Layout

Offsets from pilot (412.5 Hz):

```
TONE_OFFSETS = [237.5, 487.5, 737.5, 1087.5]

Tone 0:  412.5 + 237.5  =  650 Hz
Tone 1:  412.5 + 487.5  =  900 Hz
Tone 2:  412.5 + 737.5  = 1150 Hz
Tone 3:  412.5 + 1087.5 = 1500 Hz
```

All tone frequencies are multiples of 25 Hz — every 128-sample window (3200/25) contains an integer number of cycles, eliminating spectral leakage.

## Phase Contract (Critical)

Both encoder and decoder use `sin(ωn)` as their phase reference. This is enforced by the shared `PhaseAcc` oscillator (`src/modem/oscillator.ts`):

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

Used for actual file transfer via the encoder/broadcast workers. SPS = 256.

### Transmission Structure

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

### Atomic Frame Format (79 bytes)

```
[SENTINEL: 3B 0xE79FE7] [BCH_HEADER: 24B] [RS_PAYLOAD: 52B]
```

- **Sentinel**: 3 bytes, same 0xE79FE7 pattern
- **BCH Header**: 3 × BCH(63,30) codewords protecting 9 header bytes (type, seqNum, totalFrames, CRC-32)
- **RS Payload**: RS(52,40) — 40 data bytes + 12 parity bytes (corrects up to 6 byte errors)

### RxEngine Demodulation

**Warble Detection**: Scans for sustained energy at pilotFreq ± 50 Hz. Cross-correlates against the 16-bit warble code 0xAC94. Threshold: ≥9 matching bits out of 16.

**Preamble State Machine**: WAITING → PREAMBLE → FRAMES → (optional timeout)

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

With centroid fallback when confidence is high (`max(d0,d1) > 3 × min(d0,d1)`):
```
centBit = nearest_neighbor(currIQ, ref0IQ, ref1IQ)
```

**Sentinel Scanner**: 24-bit sliding shift register with Hamming distance threshold ≤2 for sentinel matching. On match, collects 76 bytes (frame minus sentinel), prepends sentinel, and emits the 79-byte atomic frame for BCH/RS decoding.

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

**Encoder/Decoder path**: Pilot frequency is set from `ModemConfig.pilotFreqHz` (412.5 Hz). A second-order PLL (`PilotPLL` in `pilot.ts`) tracks pilot phase for amplitude estimation, but the data path uses raw I/Q directly — no pilot-relative rotation is needed because the phase contract ensures consistent signs.

**TxEngine/RxEngine path**: Same pilot frequency. PLL is initialized on first sample and updated continuously for amplitude tracking.

---

## Error Correction

| Path | Scheme | Correction Power |
|------|--------|-----------------|
| Encoder/Decoder | BCH(31,16) + interleave depth 8 | 3 bit errors per 31-bit codeword |
| TxEngine/RxEngine | BCH(63,30) × 3 + RS(52,40) | 3 bit errors per BCH codeword + 6 byte errors per RS block |

---

## OFDM/QPSK Mode (Native-Rate)

Time-domain OFDM with QPSK per subcarrier. Symbols are defined in milliseconds rather than samples, so the protocol adapts automatically to any hardware sample rate (48000 Hz, 44100 Hz, etc.).

### Architecture

- **Symbol length**: 40 ms + 5 ms cyclic prefix = 45 ms total
- **Modulation**: Direct cosine synthesis at exact tone frequencies (no IFFT)
- **Demodulation**: Goertzel / toneIQ bank at exact tone frequencies (no FFT)
- **Tone grid**: Multiples of 25 Hz (1000 / 40 ms), guaranteeing orthogonality at any sample rate
- **Pilot**: Continuous pilot at a fixed absolute frequency, used for per-tone channel equalization

### Protocol Constants

| Parameter | Value |
|-----------|-------|
| `OFDM_SYMBOL_MS` | 40 ms |
| `OFDM_CP_MS` | 5 ms |
| `ofdmPilotFreqHz` | 1900 Hz |
| `ofdmPilotAmplitude` | 2.0 |
| `ofdmToneSpacingHz` | 50 Hz |
| `ofdmToneStartHz` | 2000 Hz |
| `ofdmToneCount` default | 16 |
| Sync burst | 24 symbols (~1.08 s) |
| Raw bitrate (16 tones) | 711 bps |
| Raw bitrate (32 tones) | 1422 bps |

### Tone Grid

Tones are at `2000 + n * 50` Hz for n = 0 … toneCount-1. With 16 tones: 2000, 2050, 2100, …, 2750 Hz. The pilot is at 1900 Hz, below the data band. All frequencies — pilot and tones — are exact multiples of 25 Hz for orthogonality with the 40 ms symbol.

### Sync Burst

24 identical symbols, all tones at QPSK 0° (I=+1, Q=0). The receiver detects the burst via total tone energy threshold and uses it to train per-tone channel equalization coefficients (amplitude + phase).

### Frame Encoding

Each OFDM symbol carries 2 bits per tone (QPSK) → `toneCount × 2` frame bits per symbol. Bit packing uses the same nibble-based scheme as BPSK (every 2 frame bits map to 1 byte), preserving sentinel scanner compatibility.

### Demodulation & Equalization

1. **Sync detection**: Total tone energy exceeds threshold → sync burst found
2. **Training**: During the 24-symbol sync burst, measure per-tone complex response (I/Q centroid at the expected QPSK 0° constellation point)
3. **Per-tone equalization**: For each data symbol, rotate the received I/Q by the negative of the trained phase and scale by inverse amplitude — this corrects frequency-selective phase rotation independently per tone
4. **Hard decision**: Nearest QPSK constellation point after equalization

### Sample Rate Adaptivity

Symbol length in samples is `ceil(sampleRate * OFDM_SYMBOL_MS / 1000)` and CP in samples is `ceil(sampleRate * OFDM_CP_MS / 1000)`. At 48000 Hz: 1920-sample symbol + 240-sample CP = 2160 samples. At 44100 Hz: 1764 + 221 = 1985 samples. The Goertzel/toneIQ bank operates at the exact tone frequencies regardless of sample rate.

---

## Test Coverage

| Test File | Path | Tests |
|-----------|------|-------|
| `loopback.test.ts` | Encoder→Decoder | 12/12 |
| `pipeline.test.ts` | Encoder→Decoder + channel sim | 17/20 |
| `production.test.ts` | TxEngine→RxEngine | 4/4 |
| `diversity.test.ts` | TxEngine→RxEngine + 3× repetition | 3/3 |

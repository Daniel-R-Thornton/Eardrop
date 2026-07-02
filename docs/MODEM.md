# Modem Specification

## Overview

The Eardrop modem uses a pilot-relative multi-tone scheme. A continuous pilot tone runs throughout the transmission. Data is encoded across 4 tones whose frequencies are at fixed offsets from the pilot. 2 bits per tone (amplitude + phase BPSK) = 8 bits per symbol.

## Configuration (`ModemConfig` in `types.ts`)

| Field | Default | Description |
|-------|---------|-------------|
| `sampleRate` | 3200 | Modem sample rate (Hz) |
| `symbolsPerSec` | 25 | Symbol rate → 128 samples/symbol |
| `bitsPerFrame` | 8 | 2 bits × 4 tones (amplitude + phase) |
| `pilotEnabled` | true | Enable pilot tone |
| `pilotFreqHz` | 62.5 | Pilot frequency (configurable! decoder discovers) |
| `pilotAmplitude` | 0.125 | Pilot amplitude (leaves headroom for 4 tones) |
| `dataToneAmplitude` | 0.2 | Data tone amplitude |
| `amplitudeThresholdRatio` | 0.3 | Tone ON if energy > pilotAmp × this |
| `syncSymbols` | 10 | Number of sync symbols in burst |
| `sentinel` | 0xE79F | 16-bit block sentinel pattern |
| `squawkIntervalSymbols` | 32 | Data symbols between squawks |
| `squawkSymbols` | 8 | Symbols per squawk |
| `eccScheme` | `bch3116` | Error correction scheme |
| `interleaveDepth` | 8 | Block interleaver depth |
| `payloadBlockSymbols` | 32 | Symbols per payload block |

## Tone Layout

```
pilotFreq + 437.5 Hz  →  Tone 0  (default: 500 Hz)
pilotFreq + 637.5 Hz  →  Tone 1  (default: 700 Hz)
pilotFreq + 837.5 Hz  →  Tone 2  (default: 900 Hz)
pilotFreq + 1037.5 Hz →  Tone 3  (default: 1100 Hz)
```

Changing the pilot frequency shifts all tones proportionally. Spacing is preserved.

## Frame Structure

```
┌─ Transmission ───────────────────────────────────────────────────┐
│  Leader: ~0.5s of pure pilot (decoder discovers frequency here)  │
│  Sync:   10 symbols, all 4 tones ON (phase-aligned with pilot)   │
│  ┌─ Framed Block 1 ───────────────────────────────────────────┐  │
│  │  0xE79F | TYPE=0x02 | LEN | CONFIG_DATA | CRC16            │  │
│  │  (file name, size, dict scheme)                            │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌─ Framed Block 2..N ────────────────────────────────────────┐  │
│  │  0xE79F | TYPE=0x04 | LEN | PAYLOAD_DATA | CRC16           │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌─ EOF Block ────────────────────────────────────────────────┐  │
│  │  0xE79F | TYPE=0xFF | LEN=0 | CRC16                        │  │
│  └────────────────────────────────────────────────────────────┘  │
│  Tail: brief silence                                              │
└──────────────────────────────────────────────────────────────────┘
```

## Block Format

```
Wire format (little-endian):
┌─────────┬──────┬──────┬──────┬──────────┐
│ SENTINEL│ TYPE │ LEN  │ DATA │ CRC16    │
│ 2 bytes │ 1 B  │ 2 B  │ N B  │ 2 bytes  │
└─────────┴──────┴──────┴──────┴──────────┘
Overhead: 7 bytes per block
```

**Sentinel**: 0xE79F (16 bits). Chosen for Hamming distance ≥4 from all shifted versions — minimizes false positives during bit-level scanning.

**Block Types**:

| Value | Name | Content |
|-------|------|---------|
| 0x01 | SQUAWK | `[squawkId:1B][refI:2B][refQ:2B]` — calibration beacon |
| 0x02 | CONFIG | `[nameLen:2B][fileName:L][totalSize:4B][dictScheme:1B]` — file metadata |
| 0x03 | DICT | `[entries:2B][entry0_len:1B][entry0...]...` — adaptive dictionary |
| 0x04 | PAYLOAD | Compressed file chunk bytes |
| 0xFF | EOF | Empty — end of transmission |

**CRC**: CRC-16-CCITT (poly 0x1021) over (TYPE + LEN + DATA). Initial 0xFFFF, final XOR 0xFFFF.

## Bit Encoding Per Symbol

Each symbol carries 8 bits from 4 tones:

```
Symbol bits: [amp0 phase0 amp1 phase1 amp2 phase2 amp3 phase3]
                 ↓       ↓       ↓       ↓       ↓       ↓       ↓       ↓
Tone 0: ────┬───┬─── , Tone 1: ────┬───┬─── , Tone 2: ────┬───┬─── , Tone 3: ────┬───┬───
            │   │                   │   │                   │   │                   │   │
         ON/OFF 0°/180°          ON/OFF 0°/180°          ON/OFF 0°/180°          ON/OFF 0°/180°
```

**Amplitude bit**: Tone ON if pilot-relative energy > `pilotAmplitude × amplitudeThresholdRatio` (default 0.3). This is the key pilot-relative mechanism — threshold adapts to volume automatically.

**Phase bit**: BPSK — `relI > 0` → bit 1 (right half-plane), `relI < 0` → bit 0 (left half-plane).

## Pilot Discovery

The decoder discovers the pilot frequency during the leader phase (pure pilot, ~0.5s):

1. Buffer at least 1024 audio samples
2. Zero-pad to 2048 and run radix-2 FFT (~1.56 Hz bin spacing)
3. Scan bins 26-77 (40-120 Hz range)
4. Find peak magnitude bin
5. Parabolic interpolation on (peak-1, peak, peak+1) for <0.1 Hz accuracy
6. Validate: peak-to-median ratio > 5.0 (otherwise keep scanning)
7. Initialize PilotPLL with discovered frequency

## PilotPLL

A second-order phase-locked loop runs continuously on every audio sample:

```
Input → phase detector (sin multiply) → loop filter (Kp=0.1, Ki=0.01) → NCO → sin/cos refs
                                                                          ↓
                                                                     amplitude estimator (α=0.01)
```

- Tracks phase at the discovered pilot frequency
- Amplitude estimate: low-pass filter on instantaneous envelope
- `rotateToPilotRef(rawI, rawQ)`: rotates I/Q by tracked pilot phase → pilot-relative coordinates

## Self-Test / Channel Simulator

The channel simulator (`channel.ts`) applies configurable impairments to test robustness:

| Effect | Config | Default |
|--------|--------|---------|
| AWGN | SNR (-10 to +40 dB) | ∞ (clean) |
| Echo | delay (0-50ms), attenuation (0-100%) | 0 |
| Doppler | freq offset (±0.1-10 Hz) | 0 |
| Amp drift | rate, depth | 0 |
| Phase noise | stddev (radians) | 0 |
| Band-limit | cutoff (Hz) | ∞ (none) |
| Impulse noise | rate (clicks/s), amplitude | 0 |

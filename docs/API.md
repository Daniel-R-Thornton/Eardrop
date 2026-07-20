# API Reference

This document summarizes the main interfaces that the current UI and worker use.

## `ModemConfig` (`src/modem/types.ts`)

```ts
interface ModemConfig {
  sampleRate: number;
  symbolsPerSec: number;
  bitsPerFrame: number;
  pilotEnabled: boolean;
  pilotFreqHz: number;
  musical: boolean;
  pilotAmplitude: number;
  dataToneAmplitude: number;
  amplitudeThresholdRatio: number;
  toneCount: number;
  diversityMode: boolean;
  syncSymbols: number;
  sentinel: number;
  squawkIntervalSymbols: number;
  squawkSymbols: number;
  eccScheme: 'hamming74' | 'bch3116';
  interleaveDepth: number;
  payloadBlockSymbols: number;
}
```

Key helpers and constants:

- `DEFAULT_CONFIG` — BPSK-era defaults used as the base config.
- `TONE_OFFSETS` — `[100, 200, 300, 400]` for the default BPSK layout.
- `OFDM_SYMBOL_MS` / `OFDM_CP_MS` — 20 ms and 5 ms for the native-rate OFDM path.
- `OFDM_DEFAULTS` — `pilotFreqHz: 1900`, `pilotAmplitude: 2.0`, `toneCount: 32`.
- `OFDM_TUNING` — sync burst, training, threshold, and tail-silence tuning values.
- `ofdmSamples(sampleRate)` — returns `{ fftSamples, cpSamples, symSamples }`.
- `ofdmToneFrequencies(...)` — returns the absolute OFDM tone frequencies.

## `buildModemConfig` (`src/ui/controllers/buildModemConfig.ts`)

```ts
function buildModemConfig(ui: ModemUiConfig): ModemConfig & { useOFDM: boolean }
```

This is the single UI-to-worker config builder. It snaps the OFDM pilot to the hardware-rate bin grid and sets the sample rate to the hardware rate when OFDM is enabled.

## `toneIQ` / `PilotPLL` (`src/modem/pilot.ts`)

```ts
function toneIQ(samples: readonly number[], toneFreq: number, sampleRate: number)
```

Computes the complex I/Q correlation of a window against a single tone frequency. The current OFDM demodulator uses this in its tone-energy and channel-estimation logic.

```ts
class PilotPLL {
  update(sample: number): void
  getAmplitude(): number
  getPhase(): number
  getFrequency(): number
  rotateToPilotRef(rawI: number, rawQ: number): { i: number; q: number }
}
```

Used by the BPSK receive path for pilot tracking and phase reference maintenance.

## `TxEngine` (`src/modem/protocol/txEngine.ts`)

```ts
class TxEngine {
  constructor(cfg?: Partial<ModemConfig> & { useOFDM?: boolean })
  transmitFile(fileName: string, data: Uint8Array): Float32Array
  reset(): void
  isOFDM(): boolean
}
```

The production transmitter. It builds the preamble, atomic frames, and the appropriate waveform for either BPSK or OFDM.

## `RxEngine` (`src/modem/protocol/rxEngine.ts`)

```ts
class RxEngine {
  constructor(cfg?: Partial<ModemConfig> & { useOFDM?: boolean })
  feedSample(sample: number): void
  feedChunk(chunk: Float32Array): void
  getFile(): ReceivedFile | null
  getProgress(): { state; framesReceived; totalFrames; fileName; fileSize; bytesAssembled }
  reset(): void
}
```

The production receiver. It supports the BPSK preamble/calibration path and the OFDM sync/training/frame-decoding path.

## `OFDMEngine` (`src/modem/protocol/ofdmEngine.ts`)

```ts
class OFDMEngine {
  constructor(cfg: { sampleRate: number; toneCount?: number; pilotFreqHz?: number; pilotAmplitude?: number })
  generateSyncBurst(count?: number): Float32Array
  modulateFrame(frame: Uint8Array): Float32Array
}
```

Creates the native-rate OFDM sync burst and modulates atomic frames into audio.

## `OFDMQPSKModulator` / `OFDMQPSKDemodulator`

```ts
class OFDMQPSKModulator {
  constructor(config: { sampleRate: number; toneFrequencies: Float32Array; pilotFreqHz: number; pilotAmplitude: number })
  setSymbols(symbols: number[]): void
  generateSymbol(): Float32Array
}
```

```ts
class OFDMQPSKDemodulator {
  constructor(config: { sampleRate: number; toneFrequencies: Float32Array; pilotFreqHz: number; trackingAlpha?: number })
}
```

These two classes are the OFDM transmit and receive backend used by the production path.

## `ModemService` / worker schema (`src/workers/modemService.ts`, `src/workers/modemSchema.ts`)

```ts
type ModemCommand =
  | { type: 'configure'; config: ModemConfig & { useOFDM?: boolean } }
  | { type: 'startRx' }
  | { type: 'stopRx' }
  | { type: 'feedChunk'; samples: ArrayBuffer }
  | { type: 'encodeFile'; id: number; fileName: string; data: ArrayBuffer }
  | { type: 'dumpBuffer'; id: number; seconds: number }
  | { type: 'setVerboseLogging'; enabled: boolean };
```

```ts
type ModemEvent =
  | { type: 'configured' }
  | { type: 'rxStarted' }
  | { type: 'rxStopped' }
  | { type: 'telemetry'; telemetry: ModemTelemetry }
  | { type: 'fileComplete'; fileName: string; data: ArrayBuffer }
  | { type: 'encoded'; id: number; samples: ArrayBuffer; sampleRate: number }
  | { type: 'bufferDump'; id: number; samples: ArrayBuffer; rms: number; peak: number }
  | { type: 'dlog'; line: string }
  | { type: 'error'; id?: number; error: string };
```

These are the worker-facing message types used by the UI and the browser worker.
  })

  resetTraining(): void
  isTraining(): boolean
  trainOnSyncSymbol(window: Float32Array | number[]): void
  demodulate(window: Float32Array | number[]): OFDMQPSKResult
}

interface OFDMQPSKResult {
  bits: number[];
  frameBits: number;
  pilotAmplitude: number;
  pilotPhase: number;
  toneIQ: Array<{ i: number; q: number }>;
}
```

Goertzel/toneIQ-based OFDM demodulator. No FFT. Per-tone channel equalization (trained on sync burst) with decision-directed tracking. Pilot-referenced phase drift correction.

---

## `generatePreamble` (`src/modem/protocol/preamble.ts`)

```typescript
function generatePreamble(cfg: PreambleConfig): Float32Array

interface PreambleConfig {
  pilotFreqHz: number
  pilotAmplitude: number
  dataToneAmplitude: number
  sampleRate: number
  toneOffsets: [number, number, number, number]
}
```

Generates BPSK warble (1280 samples, 16-bit code FSK) → marker (256 samples, all tones ON) → Gray code calibration (16 × 256 samples) → guard (512 samples, pilot only).

---

## Atomic Frame V2 (`src/modem/protocol/atomicFrame.ts`)

```typescript
const FRAME_SIZE = 235         // V2: 3 + 24 + 208
const PAYLOAD_DATA_SIZE = 160  // V2: 40 × 4
const RS_BLOCK_DATA = 40
const RS_BLOCK_SIZE = 52
const PAYLOAD_BLOCKS = 4
const SENTINEL_SIZE = 3
const BCH_HEADER_SIZE = 24
const RS_PAYLOAD_SIZE = 208

function encodeFrame(header: AtomicHeader, payload: Uint8Array): Uint8Array
function decodeFrame(frame: Uint8Array): DecodedFrame

interface AtomicHeader {
  type: number        // 0x01=HEADER, 0x02=PAYLOAD, 0x03=TAIL
  seqNum: number      // 0-based sequence number
  totalFrames: number
  crc: number         // CRC-32 of header fields
}

interface DecodedFrame {
  header: AtomicHeader | null
  payload: Uint8Array  // 160 bytes (V2)
  valid: boolean       // CRC verified AND BCH+RS decode succeeded
}
```

Wire format (V2): `[SENTINEL:3B][BCH_HEADER:24B][RS_PAYLOAD:208B]`. BCH(63,30) × 3 protects the 9-byte header. RS(52,40) × 4 protects 160 payload bytes (corrects up to 6 byte errors per block = 24 total).

Legacy V1 frame (BPSK): `FRAME_SIZE = 79`, `PAYLOAD_DATA_SIZE = 40`, single RS block.

---

## Self-Framing Blocks (`src/modem/protocol/framing.ts`)

```typescript
function encodeBlock(type: BlockType, data: Uint8Array, sentinel?: number): EncodedBlock
function decodeBlock(bytes: Uint8Array, sentinel?: number): { type: BlockType; data: Uint8Array } | null
function getSentinel(toneCount: number): number  // 0xE79FE7 (4-tone) or 0xC48CC4 (2-tone)

class FramedBlockDecoder {
  totalBits: number
  blocksDecoded: number
  blocksCrcFailed: number
  onBlock: ((event: BlockEvent) => void) | null

  feedBit(bit: number): void
  feedBytes(bytes: Uint8Array): void
  reset(): void
}

interface BlockEvent {
  type: number
  data: Uint8Array
  bitOffset: number
}
```

24-bit sentinel scanner (0xE79FE7). Wire format: `[SENTINEL:3B][TYPE:1B][LEN:2B LE][DATA:NB][CRC16:2B]`. CRC-16-CCITT over TYPE+LEN+DATA.

Block types: SQUAWK(0x01), CONFIG(0x02), DICT(0x03), PAYLOAD(0x04), EOF(0xFF).

---

## Error Correction

| Module | Function | Description |
|--------|----------|-------------|
| `src/modem/ecc/ecc.ts` | `bch3116Encode/Decode` | BCH(31,16) — 3 bit errors per codeword, rate 0.52 |
| `src/modem/ecc/bch63.ts` | `bch63Encode/Decode` | BCH(63,30) — 3 bit errors per codeword, rate 0.48 |
| `src/modem/ecc/reedsolomon.ts` | `rsEncode/Decode` | RS(52,40) — 6 byte errors per block, rate 0.77 |

---

## `ModemService` (`src/workers/modemService.ts`) — Worker API

The unified worker service that manages both TxEngine and RxEngine in a web worker.

```typescript
class ModemService {
  constructor()

  // Messaging
  postMessage(msg: Message): void
  onMessage: ((msg: Message) => void) | null

  // Commands
  configure(config: ModemConfig): void
  setOfdmEnabled(enabled: boolean): void
  feedAudio(samples: Float32Array): void
  startTransmit(fileName: string, data: ArrayBuffer): void
  cancelTransmit(): void
  reset(): void
}
```

Message protocol (see `src/workers/modemSchema.ts`):

```
Main → Worker:
  { type: 'configure', config: ModemConfig }
  { type: 'setOfdmEnabled', enabled: boolean }
  { type: 'feedAudio', samples: Float32Array }
  { type: 'startTransmit', fileName, data: ArrayBuffer }
  { type: 'cancelTransmit' }
  { type: 'reset' }

Worker → Main:
  { type: 'ready' }
  { type: 'transmitBuffer', samples: Float32Array, sampleRate }
  { type: 'fileComplete', fileName, data: ArrayBuffer }
  { type: 'transferState', ... }
  { type: 'error', error }
  { type: 'log', tag, line }
```

## Debug Logging (`src/lib/debug/dlog.ts`)

```typescript
function dlog(tag: string, fields: Record<string, any>, opts?: { level?: 'warn' | 'info'; every?: number }): void
function dlogDump(count?: number): string
function dlogSetTagEnabled(tag: string, enabled: boolean): void
function dlogSetMode(mode: 'redraw' | 'forward' | 'lines'): void
function dlogInject(line: string): void
```

One-line-per-event structured logging. See `docs/DEBUG-OUTPUT.md` for the full tag reference and healthy value ranges.

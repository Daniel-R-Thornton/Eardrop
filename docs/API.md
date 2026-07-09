# API Reference

## `ModemConfig` (`types.ts`)

```typescript
interface ModemConfig {
  sampleRate: number;                // 3200
  symbolsPerSec: number;             // 25
  bitsPerFrame: number;              // 8

  pilotEnabled: boolean;             // true
  pilotFreqHz: number;               // 412.5
  musical: boolean;                  // false
  pilotAmplitude: number;            // 0.4

  dataToneAmplitude: number;         // 0.5
  amplitudeThresholdRatio: number;   // 0.3
  toneCount: number;                 // 4 (2 or 4)
  diversityMode: boolean;            // false (3× repetition)

  syncSymbols: number;               // 10
  sentinel: number;                  // unused

  squawkIntervalSymbols: number;     // 32
  squawkSymbols: number;             // 8

  eccScheme: 'hamming74' | 'bch3116'; // 'bch3116'
  interleaveDepth: number;           // 8

  payloadBlockSymbols: number;       // 32
}
```

Constants:
- `TONE_OFFSETS`: `[237.5, 487.5, 737.5, 1087.5]`
- `MUSICAL_OFFSETS`: `[87.5, 162.5, 287.5, 487.5]`
- `WARBLE_CODE`: `0xAC94` (16-bit preamble detection code)
- `DEFAULT_CONFIG`: All defaults above

Helpers:
- `getToneFreqs(pilotFreqHz, musical?) → [f0, f1, f2, f3]`
- `getDataToneFreqs(pilotFreqHz, musical?) → [f0, f1, f2, f3]`
- `getOffsets(musical?) → [o0, o1, o2, o3]`

---

## `PhaseAcc` (`modem/oscillator.ts`)

```typescript
class PhaseAcc {
  advance(freqHz: number, sampleRate: number): number
  reset(): void
}
```

Shared sin-then-increment oscillator. `advance()` returns `sin(2π · phase)` at the current phase, then increments. Used by all tone generation paths (Encoder, TxEngine, preamble).

---

## `toneIQ` (`modem/pilot.ts`)

```typescript
function toneIQ(
  samples: readonly number[],
  toneFreq: number,
  sampleRate: number
): { i: number; q: number }
```

Goertzel-style sin/cos correlation over a sample window. Computes raw I/Q at a single frequency. Matches the `sin(ωn)` reference of `PhaseAcc`.

---

## `PilotPLL` (`modem/pilot.ts`)

```typescript
class PilotPLL {
  constructor(freq: number, initialPhase: number, initialAmplitude: number, cfg?: Partial<PLLConfig>)

  update(sample: number): void
  getAmplitude(): number
  getPhase(): number
  getFrequency(): number
  getSinRef(): number
  getCosRef(): number
  rotateToPilotRef(rawI: number, rawQ: number): { i: number; q: number }
  setFrequency(f: number): void
}

interface PLLConfig {
  Kp: number          // 0.1
  Ki: number          // 0.01
  sampleRate: number  // 3200
}
```

Second-order PLL. Used for amplitude tracking; phase rotation is not needed since the phase contract ensures consistent I signs across all tones.

---

## `Encoder` (`modem/encoder.ts`) — Self-Test Path

```typescript
class Encoder {
  constructor(cfg?: Partial<ModemConfig>)
  encode(data: Uint8Array): Float32Array
  encodeFramedBlocks(blockBytes: Uint8Array): Float32Array
  encodeToOutputRate(data: Uint8Array, outputRate: number): Float32Array
  onDone(cb: () => void): void
}
```

Generates leader (pilot-only) → sync (all tones ON) → calibrate (one tone at a time) → data (self-framing blocks). Uses `PhaseAcc` oscillator. SPS=128. BCH(31,16) ECC applied via `encode()`; `encodeFramedBlocks()` accepts pre-ECC bytes.

## `Decoder` (`modem/decoder.ts`) — Self-Test Path

```typescript
class Decoder {
  constructor(cfg?: Partial<ModemConfig>)

  feedSample(sample: number): void
  reset(): void
  flush(): Uint8Array

  hasData(): boolean
  getProgress(): number
  getNoiseFloor(): [number, number, number, number]
  getPilotFreq(): number
  getPilotAmplitude(): number

  onFrame: ((data: Uint8Array) => void) | null

  // Debug
  debugLog: DecoderDebugInfo[]
  logging: boolean
  fastSync: boolean
  framedDecoder: FramedBlockDecoder
  blockProcessor: BlockProcessor
}
```

Preamble detection via frame counting (leader → sync → calibrate → data). BPSK bit detection via raw I sign with global calibration flip. `FramedBlockDecoder` scans bits for sentinel patterns and emits validated blocks.

---

## `TxEngine` (`modem/txEngine.ts`) — Production Path

```typescript
class TxEngine {
  constructor(cfg?: Partial<ModemConfig>)
  transmitFile(fileName: string, data: Uint8Array): Float32Array
  transmitFrame(header: AtomicHeader, payload: Uint8Array): Float32Array
  reset(): void
}
```

Generates warble preamble + atomic frames. Supports diversity mode (3× repetition). SPS=256.

## `RxEngine` (`modem/rxEngine.ts`) — Production Path

```typescript
class RxEngine {
  constructor(cfg?: Partial<ModemConfig>)
  feedSample(sample: number): void
  getFile(): ReceivedFile | null
}

interface ReceivedFile {
  fileName: string
  data: Uint8Array
  totalBytes: number
}
```

State machine: WAITING (warble detection) → PREAMBLE (marker, Gray code calibration, guard) → FRAMES (DBPSK + sentinel scanning) → COMPLETE (file ready). SPS=256.

---

## `generatePreamble` (`modem/preamble.ts`)

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

Generates warble (1280 samples, 16-bit code FSK) → marker (256 samples, all tones ON) → Gray code calibration (16 × 256 samples) → guard (512 samples, pilot only).

---

## Atomic Frame (`modem/atomicFrame.ts`)

```typescript
const FRAME_SIZE = 79
const PAYLOAD_DATA_SIZE = 40

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
  payload: Uint8Array  // 40 bytes
  valid: boolean       // CRC verified AND BCH+RS decode succeeded
}
```

79-byte wire format: `[SENTINEL:3B][BCH_HEADER:24B][RS_PAYLOAD:52B]`. BCH(63,30) × 3 protects the 9-byte header. RS(52,40) protects the 40-byte payload (corrects up to 6 byte errors).

---

## Self-Framing Blocks (`modem/framing.ts`)

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
| `ecc.ts` | `bch3116Encode/Decode` | BCH(31,16) — 3 bit errors per codeword, rate 0.52 |
| `bch63.ts` | `bch63Encode/Decode` | BCH(63,30) — 3 bit errors per codeword, rate 0.48 |
| `reedsolomon.ts` | `rsEncode/Decode` | RS(52,40) — 6 byte errors per block, rate 0.77 |

---

## Worker Message Protocol

### `encoder.worker.ts` (uses TxEngine)

```
Main → Worker:
  { type: 'encode', id, fileName, data: ArrayBuffer, config? }

Worker → Main:
  { type: 'encoded', id, samples: ArrayBuffer, sampleRate }
  { type: 'error', id, error: string }
```

### `broadcast.worker.ts` (uses RxEngine)

```
Main → Worker:
  { type: 'startListening', config? }
  { type: 'feedSample', sample: number }
  { type: 'stopListening' }

Worker → Main:
  { type: 'listening' }
  { type: 'fileComplete', fileName, data: ArrayBuffer }
```

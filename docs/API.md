# API Reference

## `ModemConfig` (`src/modem/types.ts`)

```typescript
interface ModemConfig {
  sampleRate: number;                // 3200 (modem native; OFDM uses hardware rate)
  symbolsPerSec: number;             // 25
  bitsPerFrame: number;              // 8

  pilotEnabled: boolean;             // true
  pilotFreqHz: number;               // 600
  musical: boolean;                  // false
  pilotAmplitude: number;            // 0.4

  dataToneAmplitude: number;         // 0.5
  amplitudeThresholdRatio: number;   // 0.3
  toneCount: number;                 // 4 (2, 4; also sets default OFDM tone count)
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
- `TONE_OFFSETS`: `[100, 200, 300, 400]` (100 Hz spacing)
- `MUSICAL_OFFSETS`: `[87.5, 162.5, 287.5, 487.5]`
- `WARBLE_CODE`: `0xAC94` (16-bit preamble detection code)
- `WARBLE_CODE_THRESHOLD`: `12` (minimum matching bits out of 16)
- `DEFAULT_CONFIG`: All defaults above

Helpers:
- `getToneFreqs(pilotFreqHz, musical?) → [f0, f1, f2, f3]`
- `getDataToneFreqs(pilotFreqHz, musical?) → [f0, f1, f2, f3]`
- `getOffsets(musical?) → [o0, o1, o2, o3]`

### OFDM Constants (`src/modem/types.ts`)

```typescript
const OFDM_SYMBOL_MS = 20;    // ms per OFDM symbol (no CP)
const OFDM_CP_MS = 5;         // ms cyclic prefix

const OFDM_DEFAULTS = {
  pilotFreqHz: 1900,
  pilotAmplitude: 2.0,
  toneStartHz: 2000,
  toneSpacingHz: 50,
  toneCount: 32,
};

const OFDM_TUNING = {
  syncBurstSymbols: 24,
  trainingSymbols: 12,
  syncMinFrames: 8,
  tailSilenceSymbols: 6,
};
```

Helpers:
- `ofdmSamples(sampleRate) → { fftSamples, cpSamples, symSamples }` — compute integer window sizes for any hardware rate
- `ofdmToneFrequencies({ toneCount, startHz?, spacingHz? }) → Float32Array` — compute absolute tone frequencies on the 50 Hz grid

---

## `PhaseAcc` (`src/modem/dsp/oscillator.ts`)

```typescript
class PhaseAcc {
  advance(freqHz: number, sampleRate: number): number
  reset(): void
}
```

Shared sin-then-increment oscillator. `advance()` returns `sin(2π · phase)` at the current phase, then increments. Used by all tone generation paths (BPSKModulator, OFDMQPSKModulator, preamble).

---

## `toneIQ` (`src/modem/pilot.ts`)

```typescript
function toneIQ(
  samples: readonly number[],
  toneFreq: number,
  sampleRate: number
): { i: number; q: number }
```

Goertzel-style sin/cos correlation over a sample window. Computes raw I/Q at a single frequency. Matches the `sin(ωn)` reference of `PhaseAcc`.

Also exported from `src/modem/pilot/index.ts` along with:
- `getDataToneFreqs(pilotFreqHz, musical?) → [f0, f1, f2, f3]`

---

## `PilotPLL` (`src/modem/pilot.ts`)

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

Second-order PLL. Used for amplitude tracking in the BPSK path; phase rotation is not needed since the phase contract ensures consistent I signs across all tones.

---

## `Encoder` (`src/modem/protocol/encoder.ts`) — Self-Test Path

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

## `Decoder` (`src/modem/protocol/decoder.ts`) — Self-Test Path

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

## `TxEngine` (`src/modem/protocol/txEngine.ts`) — Production Path

```typescript
class TxEngine {
  constructor(cfg?: Partial<ModemConfig>)
  transmitFile(fileName: string, data: Uint8Array): Float32Array
  transmitFrame(header: AtomicHeader, payload: Uint8Array): Float32Array
  reset(): void
}
```

Generates BPSK warble preamble + atomic frames. Supports diversity mode (3× repetition). SPS=256. For OFDM, wraps `OFDMEngine` internally when `useOFDM: true` in config — generates sync burst + V2 atomic frames at native sample rate.

## `RxEngine` (`src/modem/protocol/rxEngine.ts`) — Production Path

```typescript
class RxEngine {
  constructor(cfg?: Partial<ModemConfig>)
  feedSample(sample: number): void
  feedChunk(chunk: Float32Array): void
  getFile(): ReceivedFile | null
  getState(): RxState
  getProgress(): { state, framesReceived, totalFrames, fileName, fileSize, bytesAssembled }
  reset(): void
  getDebugSnapshot(): DebugSnapshot
  getDebugByteLog(): Array<{ byte, phase, bitOffset }>
  getShiftRegHistory(): Array<{ bit, shiftReg, matched, phase }>
}

interface ReceivedFile {
  fileName: string
  data: Uint8Array
  totalBytes: number
}

enum RxState {
  WAITING, PREAMBLE, FRAMES, COMPLETE, ERROR
}
```

**BPSK mode**: State machine: WAITING (warble detection) → PREAMBLE (marker, Gray code calibration, guard) → FRAMES (DBPSK + sentinel scanning) → COMPLETE (file ready). SPS=256.

**OFDM mode**: WAITING (tone energy sync detection + CP correlation alignment) → FRAMES (OFDMQPSKDemodulator training → QPSK decode → nibble packing → sentinel scanner) → COMPLETE.

---

## `OFDMEngine` (`src/modem/protocol/ofdmEngine.ts`) — OFDM TX

```typescript
class OFDMEngine {
  constructor(cfg: { sampleRate: number; toneCount?: number; pilotFreqHz?: number; pilotAmplitude?: number })

  generateSyncBurst(count?: number): Float32Array
  modulateFrame(frame: Uint8Array): Float32Array
}
```

Native-rate OFDM transmitter. All timing derived from `OFDM_SYMBOL_MS` + `OFDM_CP_MS` via `ofdmSamples()`. Uses direct cosine synthesis (`OFDMQPSKModulator`). Tones grouped into 4-tone blocks — each block carries one byte per symbol.

---

## `OFDMQPSKModulator` (`src/modem/modulation/OFDMQPSKModulator.ts`)

```typescript
class OFDMQPSKModulator {
  constructor(config: { sampleRate: number; toneFrequencies: Float32Array; pilotFreqHz: number; pilotAmplitude: number })

  setSymbols(symbols: number[]): void
  generateSymbol(): Float32Array
}
```

Direct cosine synthesis for one OFDM symbol. Each tone is modulated by `cos(φ)` — QPSK mapped to 2-bit symbols (b0=I, b1=Q). The symbol includes the cyclic prefix (last CP samples prepended).

---

## `OFDMQPSKDemodulator` (`src/modem/demodulation/OFDMQPSKDemodulator.ts`)

```typescript
class OFDMQPSKDemodulator {
  constructor(config: {
    sampleRate: number;
    toneFrequencies: Float32Array;
    pilotFreqHz: number;
    trackingAlpha?: number;  // 0.003 default
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

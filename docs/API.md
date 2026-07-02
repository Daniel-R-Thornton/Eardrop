# API Reference

## `ModemConfig` (`types.ts`)

```typescript
interface ModemConfig {
  sampleRate: number;                // 3200
  symbolsPerSec: number;             // 25
  bitsPerFrame: number;              // 8

  pilotEnabled: boolean;             // true
  pilotFreqHz: number;               // 62.5 (configurable)
  pilotAmplitude: number;            // 0.125

  dataToneAmplitude: number;         // 0.2
  amplitudeThresholdRatio: number;   // 0.3

  syncSymbols: number;               // 10
  sentinel: number;                  // 0xE79F

  squawkIntervalSymbols: number;     // 32
  squawkSymbols: number;             // 8

  eccScheme: 'hamming74' | 'bch3116'; // 'bch3116'
  interleaveDepth: number;           // 8

  payloadBlockSymbols: number;       // 32
}
```

Helpers:
- `getToneFreqs(pilotFreqHz) → [f0, f1, f2, f3]`
- `getDefaultToneFreqs() → [f0, f1, f2, f3]`
- `TONE_OFFSETS`: `[437.5, 637.5, 837.5, 1037.5]`
- `TONE_COLORS`: `["#4a9eff", "#ff6b4a", "#5eead4", "#f472b6"]`

---

## `Encoder` (`modem/encoder.ts`)

```typescript
class Encoder {
  constructor(cfg?: Partial<ModemConfig>)
  encode(data: Uint8Array): Float32Array        // → audio samples at modem rate
  encodeToOutputRate(data: Uint8Array, outputRate: number): Float32Array
  onDone(cb: () => void): void
}
```

The encoder generates a continuous pilot tone at `pilotFreqHz` plus 4 data tones at `pilotFreq + TONE_OFFSETS[t]`. Each symbol carries 8 bits (2 bits per tone: amplitude + BPSK phase).

Frame structure: leader (0.5s pilot only) → sync (10 symbols, all tones ON) → framed data blocks → done.

---

## `Decoder` (`modem/decoder.ts`)

```typescript
class Decoder {
  constructor(cfg?: Partial<ModemConfig>)

  feedSample(sample: number): void              // feed one audio sample
  reset(): void
  flush(): Uint8Array

  hasData(): boolean
  takeBytes(): Uint8Array
  getProgress(): number

  getNoiseFloor(): [number, number, number, number]
  getNoiseMax(): [number, number, number, number]
  getPilotFreq(): number
  getPilotAmplitude(): number

  onFrame: ((data: Uint8Array) => void) | null  // called per completed file

  // Debug
  debugLog: DecoderDebugInfo[]
  logging: boolean
  fastSync: boolean
  framedDecoder: FramedBlockDecoder
  blockProcessor: BlockProcessor
}
```

The decoder runs two phases:
1. **Pilot discovery** (leader): FFT scan 40-120 Hz → find pilot frequency → init PLL
2. **Data mode** (after sync): per-frame I/Q → pilot-relative rotation → bit extraction → FramedBlockDecoder → BlockProcessor

---

## `PilotScanner` (`modem/pilot.ts`)

```typescript
class PilotScanner {
  constructor(cfg?: Partial<PilotScannerConfig>)
  feedSample(sample: number): PilotDiscovery | null
  forceDiscover(): PilotDiscovery | null
  isDone(): boolean
  getResult(): PilotDiscovery | null
  reset(): void
}

interface PilotDiscovery {
  freq: number        // discovered pilot frequency (Hz)
  amplitude: number   // estimated amplitude
  confidence: number  // 0-1
}

interface PilotScannerConfig {
  scanRange: [number, number]  // [40, 120]
  sampleRate: number           // 3200
  fftSize: number              // 2048
  minSamples: number           // 1024
  minSignalRatio: number       // 5.0
}
```

Uses FFT with zero-padding (2048-pt) and parabolic peak interpolation for <0.1 Hz accuracy.

---

## `PilotPLL` (`modem/pilot.ts`)

```typescript
class PilotPLL {
  constructor(freq: number, initialPhase: number, initialAmplitude: number, cfg?: Partial<PLLConfig>)

  update(sample: number): void                  // feed one sample
  getPhase(): number                            // tracked phase (cycles, 0..1)
  getAmplitude(): number                        // smoothed amplitude
  getFrequency(): number                        // tracked frequency
  getSinRef(): number                           // sin(2π * phase)
  getCosRef(): number                           // cos(2π * phase)
  rotateToPilotRef(rawI: number, rawQ: number): { i: number; q: number }
  setFrequency(f: number): void
}

interface PLLConfig {
  Kp: number          // 0.1 (proportional gain)
  Ki: number          // 0.01 (integral gain)
  sampleRate: number  // 3200
}
```

Second-order PLL. Loop bandwidth ~10 Hz (rejects data tone modulation). Amplitude estimated via low-pass filter (α=0.01).

---

## `toneIQ` (`modem/pilot.ts`)

```typescript
function toneIQ(samples: readonly number[], toneFreq: number, sampleRate: number): { i: number; q: number }
```

Computes raw sin/cos correlation for a single frequency over a sample buffer. Returns I/Q components.

---

## Block Framing (`modem/framing.ts`)

### `encodeBlock`

```typescript
function encodeBlock(type: BlockType, data: Uint8Array): EncodedBlock

interface EncodedBlock {
  bytes: Uint8Array     // [SENTINEL|TYPE|LEN|DATA|CRC16]
  bitLength: number
}
```

Wraps raw data in a self-framing block with sentinel (0xE79F), type, length, data, and CRC-16-CCITT.

### `decodeBlock`

```typescript
function decodeBlock(bytes: Uint8Array): { type: BlockType; data: Uint8Array } | null
```

Verifies sentinel and CRC, returns block contents. Returns null on CRC failure.

### `FramedBlockDecoder`

```typescript
class FramedBlockDecoder {
  totalBits: number
  blocksDecoded: number
  blocksCrcFailed: number
  blocksLenRejected: number

  onBlock: ((event: BlockEvent) => void) | null

  feedBit(bit: number): void                    // one bit at a time
  feedSymbol(symbolBits: number, count: number): void  // MSB-first
  feedBits(bits: readonly number[]): void
  feedBytes(bytes: Uint8Array): void
  reset(): void
  getPhase(): BlockScanPhase
}
```

Bit-level sentinel scanner state machine: `SCAN → HEADER → DATA → CRC`. Emits validated blocks via `onBlock` callback. CRC failures are silently discarded.

---

## `BlockProcessor` (`modem/blockProcessor.ts`)

```typescript
class BlockProcessor {
  stats: {
    blocksReceived: number
    configBlocks: number
    dictBlocks: number
    payloadBlocks: number
    eofBlocks: number
    squawkBlocks: number
    bytesAssembled: number
    resets: number
  }

  constructor(cfg: BlockProcessorConfig)
  processBlock(type: number, data: Uint8Array): string
  reset(): void
  getProgress(): { fileName: string; bytesSoFar: number; totalBytes: number } | null
}

interface BlockProcessorConfig {
  onFileComplete: (file: { name: string; data: Uint8Array }) => void
  onPayloadProgress: (bytesSoFar: number, fileSize: number) => void
  onSquawk?: (squawkId: number, refI: number, refQ: number) => void
}
```

Expected block sequence: `CONFIG → [DICT] → (PAYLOAD)* → EOF`. Out-of-order blocks cause a reset.

---

## Error Correction (`modem/ecc.ts`) — Phase F

```typescript
function bch3116Encode(data: Uint8Array): Uint8Array
function bch3116Decode(data: Uint8Array): { data: Uint8Array; errors: number }

function interleave(data: Uint8Array, depth: number): Uint8Array
function deinterleave(data: Uint8Array, depth: number): Uint8Array
```

---

## Worker Message Protocol

### `encoder.worker.ts`

```
Main → Worker:
  { type: 'encode',         id, data: Uint8Array, config? }
  { type: 'encodeToOutput', id, data: Uint8Array, outputRate, config? }

Worker → Main:
  { type: 'encoded', id, samples: ArrayBuffer, sampleRate }
  { type: 'error',   id, error: string }
```

### `broadcast.worker.ts`

```
Main → Worker:
  { type: 'startListening', config?, fastSync? }
  { type: 'feedSample', sample: number }
  { type: 'stopListening' }
  { type: 'flush' }

Worker → Main:
  { type: 'listening' }
  { type: 'stopped' }
  { type: 'frame', data: ArrayBuffer }           // completed file bytes
  { type: 'decoderState', bitsCollected, hasData, debugInfo, recentLog, rawBytes }
```

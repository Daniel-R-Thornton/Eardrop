/** One labeled field within a wire frame, for the FrameAnatomy view. */
export interface FrameField {
  name: string;      // e.g. 'sentinel', 'bch-header', 'rs-payload'
  offset: number;    // byte offset into the wire frame
  length: number;    // byte length
  bytes: number[];   // the actual bytes (plain array for structured-clone)
}

/** All captured stages for a single frame of a transmission. */
export interface StageBundle {
  frameKind: 'header' | 'data' | 'eof';
  frameIndex: number;
  payloadBytes: number[];        // pre-frame payload slice for this frame
  frameFields: FrameField[];     // wire-frame field map
  eccBefore: number[];           // bytes before ECC expansion (raw header/payload)
  eccAfter: number[];            // bytes after ECC (wire frame)
  eccScheme: string;             // 'bch3116' | 'rs' | ...
  correctionCapacity: number;    // correctable bytes/bits (informational)
  symbols: { i: number; q: number }[];
  pilotFreqHz: number;           // pilot tone frequency
  toneFreqsHz: number[];         // absolute data-tone frequencies (pilot + offsets)
  toneWaves: Float32Array[];     // one per data tone
  pilotWave: Float32Array;
  combined: Float32Array;
  preamble: Float32Array;        // empty for non-first frames
  txFinal: Float32Array;         // this frame's audio segment
  sampleRate: number;
}

export interface Run {
  fileName: string;
  totalSamples: number;
  sampleRate: number;
  frames: StageBundle[];
}

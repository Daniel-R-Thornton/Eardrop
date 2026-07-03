/**
 * Encoder — Pilot-Relative Multi-Tone Modem
 *
 * 8 bits per symbol: 4 amplitude bits + 4 phase bits (BPSK)
 * All tones are at frequencies relative to the pilot (pilotFreq + TONE_OFFSETS[t]).
 * Frame: leader → sync → data → done.
 *
 * The pilot runs continuously from leader start to done. Data tones are
 * phase-synchronous with the pilot (their phases are measured relative to
 * the pilot's tracked phase at the decoder).
 */

import { ModemConfig, TONE_OFFSETS, DEFAULT_CONFIG } from "./types";
import { encodeBlock, BLOCK_TYPE } from "./framing";
import { encodeSquawkPayload } from "./squawk";

enum Phase { kLeader, kSync, kData, kDone }

export class Encoder {
  private cfg: ModemConfig;
  private sps = 128;                 // samples per symbol
  private leaderSamps = 0;
  private phase = Phase.kDone;
  private samplesInPhase = 0;

  // Continuous phase accumulators (cycles 0..1)
  private pilotPhase = 0;
  /** Phase accumulator for each data tone (cycles 0..1) */
  private tonePhases = new Float32Array(0);

  // Per-symbol BPSK multiplier: +1 (bit=0) or -1 (bit=1)
  private bpskMul = new Float32Array(0);

  private bitPos = 0;
  private bitstream: number[] = [];
  private onDoneCb: (() => void) | null = null;

  // Tone frequencies (computed from pilotFreq + offsets)
  private toneFreqs: Float32Array = new Float32Array(0);

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.sps = this.cfg.sampleRate / this.cfg.symbolsPerSec;

    // Compute absolute tone frequencies from pilot + offsets
    this.toneFreqs = new Float32Array(this.cfg.bitsPerFrame / 2);
    for (let t = 0; t < this.toneFreqs.length; t++) {
      this.toneFreqs[t] = this.cfg.pilotFreqHz + TONE_OFFSETS[t];
    }
  }

  onDone(cb: () => void) { this.onDoneCb = cb; }

  /** Encode raw bytes → float32 audio samples [-1, 1] */
  encode(data: Uint8Array): Float32Array {
    this.resetState();
    this.bitstream = [];
    const framedPayload = encodeBlock(BLOCK_TYPE.PAYLOAD, data);
    this.buildBitstream(framedPayload.bytes);
    return this.generateAudioInternal();
  }

  /** Encode pre-framed block bytes → audio (no extra framing layer) */
  encodeFramedBlocks(blockBytes: Uint8Array): Float32Array {
    this.resetState();
    this.bitstream = [];
    this.buildBitstream(blockBytes);
    return this.generateAudioInternal();
  }

  /** Build bitstream: initial squawk → data segments → final squawk */
  private buildBitstream(dataBytes: Uint8Array): void {
    // Emit initial squawk
    this.emitBlockBits(encodeBlock(BLOCK_TYPE.SQUAWK, encodeSquawkPayload(0)).bytes);

    // Emit data in segments with squawks between
    // No segment splitting — all data sent in one contiguous block
    const bytesPerSegment = Infinity;
    let bytePos = 0;
    let squawkId = 0;

    while (bytePos < dataBytes.length) {
      const len = Math.min(bytesPerSegment, dataBytes.length - bytePos);
      this.emitBlockBits(dataBytes.slice(bytePos, bytePos + len));
      bytePos += len;

      if (bytePos < dataBytes.length) {
        squawkId++;
        this.emitBlockBits(encodeBlock(BLOCK_TYPE.SQUAWK, encodeSquawkPayload(squawkId)).bytes);
      }
    }

    // Final squawk
    squawkId++;
    this.emitBlockBits(encodeBlock(BLOCK_TYPE.SQUAWK, encodeSquawkPayload(squawkId)).bytes);
  }

  private resetState(): void {
    this.phase = Phase.kLeader;
    this.samplesInPhase = 0;
    this.pilotPhase = 0;
    const numTones = this.cfg.bitsPerFrame / 2;
    this.tonePhases = new Float32Array(numTones);
    this.bpskMul = new Float32Array(numTones);
    for (let t = 0; t < numTones; t++) this.bpskMul[t] = 1;
    this.bitPos = 0;
    this.bitstream = [];
  }

  /** Emit raw bytes -> bits in [amp0,amp1,amp2,amp3] format (4 data bits/symbol)
   *  Each input byte is split into two 4-bit nibbles, each becomes one frame.
   *  The frame byte format [a0,0,a1,0,a2,0,a3,0] is reconstructed by the encoder's
   *  BPSK modulation (phase bits always 0 for reliability). */
  private emitBlockBits(data: Uint8Array): void {
    for (const byte of data) {
      const hi = (byte >> 4) & 0x0F;
      const lo = byte & 0x0F;
      // High nibble: 4 amp bits for tones 0-3
      for (let b = 3; b >= 0; b--) {
        this.bitstream.push((hi >> b) & 1);
      }
      // Low nibble: 4 amp bits for next frame
      for (let b = 3; b >= 0; b--) {
        this.bitstream.push((lo >> b) & 1);
      }
    }
  }

  /** One-shot: encode and upsample to output sample rate */
  encodeToOutputRate(data: Uint8Array, outputRate: number): Float32Array {
    const base = this.encode(data);
    return this.resample(base, this.cfg.sampleRate, outputRate);
  }

  // ─── private ───────────────────────────────────────

  /** Generate audio from prepared bitstream */
  private generateAudioInternal(): Float32Array {
    this.leaderSamps = Math.floor(this.cfg.sampleRate / 2 / this.sps) * this.sps;
    const totalSamples = this.estimateTotalSamples2(this.bitstream.length);
    const out = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      out[i] = this.generateSample();
    }
    return out;
  }

  private estimateTotalSamples2(bitstreamBits: number): number {
    // 4 data bits per symbol (amp bits only; phase bits always 0)
    const dataSymbols = Math.ceil(bitstreamBits / 4);
    const dataSamples = dataSymbols * this.sps;
    const leaderSamples = this.leaderSamps || Math.floor(this.cfg.sampleRate / 2 / this.sps) * this.sps;
    const syncSamples = this.cfg.syncSymbols * this.sps;
    return leaderSamples + syncSamples + dataSamples + this.sps * 6;
  }

  private generateSample(): number {
    const { sampleRate, pilotFreqHz, pilotEnabled, pilotAmplitude, dataToneAmplitude } = this.cfg;
    const numTones = this.toneFreqs.length;

    // Pilot (always on if enabled)
    let output = 0;
    if (pilotEnabled) {
      const pilot = Math.sin(2 * Math.PI * this.pilotPhase) * pilotAmplitude;
      this.pilotPhase += pilotFreqHz / sampleRate;
      if (this.pilotPhase >= 1.0) this.pilotPhase -= 1.0;
      output += pilot;
    }

    switch (this.phase) {
      case Phase.kLeader: {
        this.samplesInPhase++;
        if (this.samplesInPhase >= this.leaderSamps) this.advancePhase();
        break;
      }

      case Phase.kSync: {
        // All tones ON — phase-aligned with pilot. Amplitude=1, phase=0.
        for (let t = 0; t < numTones; t++) {
          this.tonePhases[t] += this.toneFreqs[t] / sampleRate;
          if (this.tonePhases[t] >= 1.0) this.tonePhases[t] -= 1.0;
          output += Math.sin(2 * Math.PI * this.tonePhases[t]) * dataToneAmplitude;
          this.bpskMul[t] = 1;
        }
        this.samplesInPhase++;
        if (this.samplesInPhase >= this.sps * this.cfg.syncSymbols) {
          this.advancePhase();
        }
        break;
      }

      case Phase.kData: {
        if (this.bitPos >= this.bitstream.length) {
          this.advancePhase();
          break;
        }

        if (this.samplesInPhase === 0) {
          // 8-bit frame: [a0,0,a1,0,a2,0,a3,0] — phase bits always 0
          // bitstream has 4 bits per symbol, packed as [amp0,amp1,amp2,amp3]
          for (let t = 0; t < numTones; t++) {
            const ampBit = (this.bitPos + t) < this.bitstream.length
              ? this.bitstream[this.bitPos + t] : 0;
            this.bpskMul[t] = ampBit === 0 ? 0 : 1;
          }

        }

        // Generate this sample
        for (let t = 0; t < numTones; t++) {
          this.tonePhases[t] += this.toneFreqs[t] / sampleRate;
          if (this.tonePhases[t] >= 1.0) this.tonePhases[t] -= 1.0;
          output += Math.sin(2 * Math.PI * this.tonePhases[t]) * dataToneAmplitude * this.bpskMul[t];
        }

        this.samplesInPhase++;
        if (this.samplesInPhase >= this.sps) {
          this.samplesInPhase = 0;
          this.bitPos += 4; // 4 bits per symbol (phase bits are always 0)
        }
        break;
      }

      case Phase.kDone:
        if (this.onDoneCb) this.onDoneCb();
        return 0;
    }

    return output;
  }

  private advancePhase() {
    this.phase = (this.phase + 1) as Phase;
    this.samplesInPhase = 0;
  }

  /** Simple linear resample */
  private resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
    if (inRate === outRate) return input;
    const ratio = inRate / outRate;
    const outLen = Math.ceil(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = input[idx] ?? 0;
      const b = input[Math.min(idx + 1, input.length - 1)] ?? 0;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }
}

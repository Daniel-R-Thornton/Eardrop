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

import { type ModemConfig, TONE_OFFSETS, MUSICAL_OFFSETS, DEFAULT_CONFIG } from '../types';
import { encodeBlock, BLOCK_TYPE, getSentinel } from '../protocol/framing';
import { encodeSquawkPayload } from '../protocol/squawk';
import { bch3116Encode } from '../ecc/ecc';
import { BPSKModulator, type BPSKModulatorConfig } from '../modulation/BPSKModulator';
import { resample } from '../../lib/math/index';

enum Phase {
  kLeader,
  kSync,
  kCalibrate,
  kData,
  kDone,
}

export class Encoder {
  private cfg: ModemConfig;
  private sps = 128; // samples per symbol
  private leaderSamps = 0;
  private phase = Phase.kDone;
  private samplesInPhase = 0;

  // BPSK tone generation (phase accumulators, pilot, data tones, wobble, noise)
  private modulator!: BPSKModulator;

  private bitPos = 0;
  private bitstream: number[] = [];
  private onDoneCb: (() => void) | null = null;

  // Tone frequencies (computed from pilotFreq + offsets)
  private toneFreqs: Float32Array = new Float32Array(0);

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.sps = this.cfg.sampleRate / this.cfg.symbolsPerSec;

    // Compute absolute tone frequencies from pilot + offsets
    const offsets = this.cfg.musical ? MUSICAL_OFFSETS : TONE_OFFSETS;
    const numTones = this.cfg.bitsPerFrame / 2;
    this.toneFreqs = new Float32Array(numTones);
    for (let t = 0; t < numTones; t++) {
      this.toneFreqs[t] = this.cfg.pilotFreqHz + offsets[t];
    }

    // Initialize shared BPSK modulator
    const modCfg: BPSKModulatorConfig = {
      sampleRate: this.cfg.sampleRate,
      pilotFreqHz: this.cfg.pilotFreqHz,
      pilotAmplitude: this.cfg.pilotAmplitude,
      dataToneAmplitude: this.cfg.dataToneAmplitude,
      toneFrequencies: new Float32Array(this.toneFreqs),
      wobble: { rateHz: 8, depth: 0.05 },
      correlatedNoise: { amplitude: 0.002, seed: 12345 },
    };
    this.modulator = new BPSKModulator(modCfg);
  }

  onDone(cb: () => void) {
    this.onDoneCb = cb;
  }

  /** Encode raw bytes → float32 audio samples [-1, 1] */
  encode(data: Uint8Array): Float32Array {
    this.resetState();
    this.bitstream = [];
    // BCH(31,16) encode payload data before wrapping in a framed block
    const dataForWire = this.cfg.eccScheme === 'bch3116' ? bch3116Encode(data) : data;
    const framedPayload = encodeBlock(BLOCK_TYPE.PAYLOAD, dataForWire);
    this.buildBitstream(framedPayload.bytes);
    return this.generateAudioInternal();
  }

  /** Encode pre-framed block bytes → audio (no extra framing layer).
   *  NOTE: Blocks should be pre-ECC-encoded by the caller (e.g. test harness).
   *  This method does NOT apply ECC — it assumes bytes are already ECC-protected
   *  if the configured eccScheme requires it. */
  encodeFramedBlocks(blockBytes: Uint8Array): Float32Array {
    this.resetState();
    this.bitstream = [];
    this.buildBitstream(blockBytes);
    return this.generateAudioInternal();
  }

  /** Build bitstream: initial squawk → data segments → final squawk */
  private buildBitstream(dataBytes: Uint8Array): void {
    const sentinel = getSentinel(this.cfg.toneCount);

    // Emit initial squawk
    this.emitBlockBits(encodeBlock(BLOCK_TYPE.SQUAWK, encodeSquawkPayload(0), sentinel).bytes);

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
        this.emitBlockBits(
          encodeBlock(BLOCK_TYPE.SQUAWK, encodeSquawkPayload(squawkId), sentinel).bytes,
        );
      }
    }

    // Final squawk
    squawkId++;
    this.emitBlockBits(
      encodeBlock(BLOCK_TYPE.SQUAWK, encodeSquawkPayload(squawkId), sentinel).bytes,
    );
  }

  private resetState(): void {
    this.phase = Phase.kLeader;
    this.samplesInPhase = 0;
    this.modulator.reset();
    this.bitPos = 0;
    this.bitstream = [];
  }

  /** Emit raw bytes -> bits for BPSK phase modulation.
   *  Each byte is split into frames of toneCount bits each.
   *  4 tones: 2 frames × 4 bits = 1 byte.  2 tones: 4 frames × 2 bits = 1 byte. */
  private emitBlockBits(data: Uint8Array): void {
    const frameBits = this.cfg.toneCount;
    const framesPerByte = 8 / frameBits; // 2 or 4
    for (const byte of data) {
      for (let f = 0; f < framesPerByte; f++) {
        const shift = 8 - (f + 1) * frameBits;
        for (let ti = 0; ti < frameBits; ti++) {
          const bit = (byte >> (shift + frameBits - 1 - ti)) & 1;
          this.bitstream.push(bit);
        }
      }
    }
  }

  /** One-shot: encode and upsample to output sample rate */
  encodeToOutputRate(data: Uint8Array, outputRate: number): Float32Array {
    const base = this.encode(data);
    return resample(base, this.cfg.sampleRate, outputRate);
  }

  // ─── private ───────────────────────────────────────

  /** Generate audio from prepared bitstream, normalize to [-1, 1] */
  private generateAudioInternal(): Float32Array {
    this.leaderSamps = Math.floor(this.cfg.sampleRate / 2 / this.sps) * this.sps;
    const totalSamples = this.estimateTotalSamples2(this.bitstream.length);
    const out = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      out[i] = this.generateSample();
    }
    // Normalize to [-1, 1] preserving waveform shape (avoids per-sample
    // hard clipping which destroys phase information)
    let peak = 0;
    for (let i = 0; i < totalSamples; i++) {
      const abs = Math.abs(out[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 1.0) {
      const scale = 1.0 / peak;
      for (let i = 0; i < totalSamples; i++) {
        out[i] *= scale;
      }
    }
    return out;
  }

  private estimateTotalSamples2(bitstreamBits: number): number {
    const dataSymbols = Math.ceil(bitstreamBits / this.cfg.toneCount);
    const dataSamples = dataSymbols * this.sps;
    const leaderSamples =
      this.leaderSamps || Math.floor(this.cfg.sampleRate / 2 / this.sps) * this.sps;
    const syncSamples = this.cfg.syncSymbols * this.sps;
    const calSamples = 4 * 4 * this.sps; // 4 tones × 4 frames each = calibrate
    return leaderSamples + syncSamples + calSamples + dataSamples + this.sps * 6;
  }

  private generateSample(): number {
    const numTones = this.toneFreqs.length;
    const active = Math.min(numTones, this.cfg.toneCount || 4);

    switch (this.phase) {
      case Phase.kLeader: {
      // Pilot only; data tones off. modulator.bpskMul already all 1 from reset.
      // Turn off data tones for leader phase.
        for (let t = 0; t < numTones; t++) this.modulator.bpskMul[t] = 0;
        this.samplesInPhase++;
        if (this.samplesInPhase >= this.leaderSamps) this.advancePhase();
        break;
      }

      case Phase.kSync: {
      // All tones ON — phase-aligned with pilot. Amplitude=1, phase=0°.
        for (let t = 0; t < numTones; t++) this.modulator.bpskMul[t] = 1;
        this.samplesInPhase++;
        if (this.samplesInPhase >= this.sps * this.cfg.syncSymbols) {
          this.advancePhase();
        }
        break;
      }

      case Phase.kCalibrate: {
      // Send each tone ON for 4 frames at 0° phase — decoder measures gain & phase ref
        const calSymIdx = Math.floor(this.samplesInPhase / this.sps);
        const calTone = Math.min(numTones - 1, Math.floor(calSymIdx / 4));
        for (let t = 0; t < numTones; t++) {
          this.modulator.bpskMul[t] = t === calTone ? 1 : 0;
        }
        this.samplesInPhase++;
        if (this.samplesInPhase >= 4 * 4 * this.sps) this.advancePhase();
        break;
      }

      case Phase.kData: {
        if (this.bitPos >= this.bitstream.length) {
          this.advancePhase();
          break;
        }

        if (this.samplesInPhase === 0) {
        // BPSK: active tones always ON, data in 0°/180° phase
          for (let t = 0; t < numTones; t++) {
            const bit =
              t < active && this.bitPos + t < this.bitstream.length
                ? this.bitstream[this.bitPos + t]
                : 0;
            this.modulator.bpskMul[t] = t < active ? (bit === 0 ? 1 : -1) : 0;
          }
          this.bitPos += active;
        }

        this.samplesInPhase++;
        if (this.samplesInPhase >= this.sps) {
          this.samplesInPhase = 0;
        }
        break;
      }

      case Phase.kDone:
        if (this.onDoneCb) this.onDoneCb();
        return 0;
    }

    return this.modulator.generateSample();
  }

  private advancePhase() {
    this.phase = (this.phase + 1) as Phase;
    this.samplesInPhase = 0;
  }
}

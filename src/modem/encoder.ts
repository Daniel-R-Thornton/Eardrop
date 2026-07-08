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

import { ModemConfig, TONE_OFFSETS, MUSICAL_OFFSETS, DEFAULT_CONFIG } from "./types";
import { encodeBlock, BLOCK_TYPE, getSentinel } from "./framing";
import { encodeSquawkPayload } from "./squawk";

enum Phase { kLeader, kSync, kCalibrate, kData, kDone }

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
  // Anti-noise-gate: slow amplitude wobble (8 Hz, ±30%) so tones aren't mistaken for stationary hum
  private wobblePhase = 0;
  private readonly WOBBLE_RATE = 8; // Hz
  private readonly WOBBLE_DEPTH = 0.05; // ±5% (was 0.3) — reduced for cleaner BPSK
  // Correlated noise floor — same PRNG seed as decoder, keeps mic gate open, cancelled at decoder
  private noiseState = 12345;
  private readonly NOISE_AMP = 0.002; // reduced from 0.015 for cleaner BPSK

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.sps = this.cfg.sampleRate / this.cfg.symbolsPerSec;

    // Compute absolute tone frequencies from pilot + offsets
    const offsets = this.cfg.musical ? MUSICAL_OFFSETS : TONE_OFFSETS;
    this.toneFreqs = new Float32Array(this.cfg.bitsPerFrame / 2);
    for (let t = 0; t < this.toneFreqs.length; t++) {
      this.toneFreqs[t] = this.cfg.pilotFreqHz + offsets[t];
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
        this.emitBlockBits(encodeBlock(BLOCK_TYPE.SQUAWK, encodeSquawkPayload(squawkId), sentinel).bytes);
      }
    }

    // Final squawk
    squawkId++;
    this.emitBlockBits(encodeBlock(BLOCK_TYPE.SQUAWK, encodeSquawkPayload(squawkId), sentinel).bytes);
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
    this.wobblePhase = 0;
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
    const dataSymbols = Math.ceil(bitstreamBits / this.cfg.toneCount);
    const dataSamples = dataSymbols * this.sps;
    const leaderSamples = this.leaderSamps || Math.floor(this.cfg.sampleRate / 2 / this.sps) * this.sps;
    const syncSamples = this.cfg.syncSymbols * this.sps;
    const calSamples = 4 * 4 * this.sps; // 4 tones × 4 frames each = calibrate
    return leaderSamples + syncSamples + calSamples + dataSamples + this.sps * 6;
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

      case Phase.kCalibrate: {
        // Send each tone ON for 4 frames at 0° phase — decoder measures gain & phase ref
        const calSymIdx = Math.floor(this.samplesInPhase / this.sps);
        const calTone = Math.min(numTones - 1, Math.floor(calSymIdx / 4));
        for (let t = 0; t < numTones; t++) {
          this.tonePhases[t] += this.toneFreqs[t] / sampleRate;
          if (this.tonePhases[t] >= 1.0) this.tonePhases[t] -= 1.0;
          const amp = t === calTone ? dataToneAmplitude : 0;
          output += Math.sin(2 * Math.PI * this.tonePhases[t]) * amp;
          this.bpskMul[t] = t === calTone ? 1 : 0;
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
          const active = Math.min(numTones, this.cfg.toneCount || 4);
          for (let t = 0; t < numTones; t++) {
            const bit = t < active && (this.bitPos + t) < this.bitstream.length
              ? this.bitstream[this.bitPos + t] : 0;
            this.bpskMul[t] = t < active ? (bit === 0 ? 1 : -1) : 0;
          }
          this.bitPos += active;
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
          // bitPos already advanced by toneCount at symbol start — no double-advance
        }
        break;
      }

      case Phase.kDone:
        if (this.onDoneCb) this.onDoneCb();
        return 0;
    }

    // Correlated noise — same deterministic sequence as decoder, keeps mic gate open
    this.noiseState = (this.noiseState * 1664525 + 1013904223) & 0x7FFFFFFF;
    const noise = ((this.noiseState >>> 0) / 2147483648 - 1) * this.NOISE_AMP;

    // Amplitude wobble to prevent microphone noise gate from suppressing stationary tones
    this.wobblePhase += this.WOBBLE_RATE / sampleRate;
    if (this.wobblePhase >= 1.0) this.wobblePhase -= 1.0;
    const wobble = 1.0 - this.WOBBLE_DEPTH * 0.5 + this.WOBBLE_DEPTH * 0.5 * Math.sin(2 * Math.PI * this.wobblePhase);
    return output * wobble + noise;
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

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
    this.phase = Phase.kLeader;
    this.samplesInPhase = 0;
    this.pilotPhase = 0;
    const numTones = this.cfg.bitsPerFrame / 2;
    this.tonePhases = new Float32Array(numTones);
    this.bpskMul = new Float32Array(numTones);
    // BPSK multiplier defaults to +1
    for (let t = 0; t < numTones; t++) this.bpskMul[t] = 1;
    this.bitPos = 0;

    // Build bitstream: 2 bits per tone (amplitude + phase), 4 tones = 8 bits/symbol
    this.bitstream = [];
    for (const byte of data) {
      // For now, still use Hamming(7,4) as placeholder — BCH will come in Phase D
      // Each nibble (4 bits) → 8 encoded bits via Hamming(7,4)
      const hiNib = (byte >> 4) & 0xf;
      const loNib = byte & 0xf;
      // Hamming encode each nibble: 4 data → 8 encoded bits
      const hiEnc = this.hammingEncode(hiNib);
      const loEnc = this.hammingEncode(loNib);
      for (let b = 7; b >= 0; b--) this.bitstream.push((hiEnc >> b) & 1);
      for (let b = 7; b >= 0; b--) this.bitstream.push((loEnc >> b) & 1);
    }

    this.leaderSamps = Math.floor(this.cfg.sampleRate / 2 / this.sps) * this.sps;
    const totalSamples = this.estimateTotalSamples(data.length);
    const full = new Float32Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      full[i] = this.generateSample();
    }
    return full;
  }

  /** One-shot: encode and upsample to output sample rate */
  encodeToOutputRate(data: Uint8Array, outputRate: number): Float32Array {
    const base = this.encode(data);
    return this.resample(base, this.cfg.sampleRate, outputRate);
  }

  // ─── private ───────────────────────────────────────

  private estimateTotalSamples(dataBytes: number): number {
    const bits = dataBytes * 16; // Hamming(7,4): each nibble → 8 bits
    const dataSymbols = Math.ceil(bits / this.cfg.bitsPerFrame);
    const dataSamples = dataSymbols * this.sps;
    const leaderSamples = this.leaderSamps || Math.floor(this.cfg.sampleRate / 2 / this.sps) * this.sps;
    const syncSamples = this.cfg.syncSymbols * this.sps;
    return leaderSamples + syncSamples + dataSamples + this.sps * 6; // +6 padding
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
          // Start of new symbol — set BPSK multipliers for this symbol
          // bitstream layout: [amp0, phase0, amp1, phase1, amp2, phase2, amp3, phase3]
          for (let t = 0; t < numTones; t++) {
            const ampBit = (this.bitPos + t * 2) < this.bitstream.length
              ? this.bitstream[this.bitPos + t * 2] : 0;
            const phaseBit = (this.bitPos + t * 2 + 1) < this.bitstream.length
              ? this.bitstream[this.bitPos + t * 2 + 1] : 0;
            // BPSK: phaseBit=0 → +1 (0°), phaseBit=1 → -1 (180°)
            this.bpskMul[t] = phaseBit === 0 ? 1 : -1;
            // If ampBit=0, also set bpskMul to 0 (tone OFF)
            if (ampBit === 0) this.bpskMul[t] = 0;
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
          this.bitPos += this.cfg.bitsPerFrame;
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

  /** Hamming(7,4) encode — placeholder until BCH is implemented */
  private hammingEncode(nibble: number): number {
    const d0 = (nibble >> 3) & 1;
    const d1 = (nibble >> 2) & 1;
    const d2 = (nibble >> 1) & 1;
    const d3 = (nibble >> 0) & 1;
    const p0 = d0 ^ d1 ^ d3;
    const p1 = d0 ^ d2 ^ d3;
    const p2 = d1 ^ d2 ^ d3;
    let out = 0;
    out |= (p0 << 7);
    out |= (p1 << 6);
    out |= (d0 << 5);
    out |= (p2 << 4);
    out |= (d1 << 3);
    out |= (d2 << 2);
    out |= (d3 << 1);
    return out;
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

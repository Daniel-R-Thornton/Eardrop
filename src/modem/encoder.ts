/**
 * Encoder — Ported from TapewormFS lib/ofdm/src/modem_encoder.cpp
 *
 * Multi-tone OFDM-style encoder.
 * 4 bits per symbol via 4 simultaneous tones (500/700/900/1100 Hz).
 * Frame: pilot leader → sync → data → done.
 */
import { ModemConfig, TONES, DEFAULT_CONFIG } from "./types";
import { hammingEncode } from "../hamming";

enum Phase { kLeader, kSync, kGuard, kData, kDone }

export class Encoder {
  private cfg: ModemConfig;
  private sps = 128;                 // samples per symbol
  private leaderSamps = 0;           // leader length (aligned)
  private phase = Phase.kDone;
  private samplesInPhase = 0;
  private pilotPhase = 0;
  private tonePhases = new Float32Array(0);  // persistent phase per tone — no symbol-boundary jumps
  private bitPos = 0;
  private bitstream: number[] = [];
  private outputBuf: Float32Array[] = [];
  private onDoneCb: (() => void) | null = null;

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    this.sps = this.cfg.sampleRate / this.cfg.symbolsPerSec;
  }

  onDone(cb: () => void) { this.onDoneCb = cb; }

  /** Encode raw bytes → float32 audio samples [-1, 1] */
  encode(data: Uint8Array): Float32Array {
    this.outputBuf = [];
    this.phase = Phase.kLeader;
    this.samplesInPhase = 0;
    this.pilotPhase = 0;
    this.tonePhases = new Float32Array(this.cfg.bitsPerFrame);
    this.bitPos = 0;

    // bytes → nibbles → Hamming(7,4) encoded → bitstream
    this.bitstream = [];
    for (const byte of data) {
      // High nibble
      const hiNib = (byte >> 4) & 0xf;
      const hiEnc = hammingEncode(hiNib);
      for (let b = 7; b >= 0; b--) this.bitstream.push((hiEnc >> b) & 1);
      // Low nibble
      const loNib = byte & 0xf;
      const loEnc = hammingEncode(loNib);
      for (let b = 7; b >= 0; b--) this.bitstream.push((loEnc >> b) & 1);
    }

    this.sps = this.cfg.sampleRate / this.cfg.symbolsPerSec;
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
    const bits = dataBytes * 16; // Hamming(7,4): each nibble → 8 bits = 2× raw bits
    const dataSymbols = Math.ceil(bits / this.cfg.bitsPerFrame);
    const dataSamples = dataSymbols * this.sps;
    const leaderSamples = this.leaderSamps || Math.floor(this.cfg.sampleRate / 2 / this.sps) * this.sps;
    const syncSamples = this.cfg.syncSymbols * this.sps;
    return leaderSamples + syncSamples + (this.sps * 2) + dataSamples + this.sps * 6; // +2 guard + 6 padding
  }

  private generateSample(): number {
    const { sampleRate, pilotFreqHz, pilotAmplitude } = this.cfg;
    const toneAmp = 1 / this.cfg.bitsPerFrame; // 0.25 — ensure total never exceeds 1.0 in AudioBuffer

    // Pilot always on
    const pilot = Math.sin(2 * Math.PI * this.pilotPhase) * pilotAmplitude;
    this.pilotPhase += pilotFreqHz / sampleRate;
    if (this.pilotPhase >= 1.0) this.pilotPhase -= 1.0;

    let output = pilot;

    switch (this.phase) {
      case Phase.kLeader: {
        this.samplesInPhase++;
        if (this.samplesInPhase >= this.leaderSamps) this.advancePhase();
        break;
      }

      case Phase.kSync: {
        // All tones ON for every sync symbol — continuous phase, no boundary jumps
        for (let t = 0; t < this.cfg.bitsPerFrame; t++) {
          this.tonePhases[t] += TONES[t] / sampleRate;
          if (this.tonePhases[t] >= 1.0) this.tonePhases[t] -= 1.0;
          output += Math.sin(2 * Math.PI * this.tonePhases[t]) * toneAmp;
        }
        this.samplesInPhase++;
        if (this.samplesInPhase >= this.sps * this.cfg.syncSymbols) {
          this.advancePhase();
        }
        break;
      }

      case Phase.kGuard: {
        // 2-symbol silence gap — all tones OFF but phases still advance for continuity.
        // Gives the decoder clean alignment to start on a codeword boundary.
        for (let t = 0; t < this.cfg.bitsPerFrame; t++) {
          this.tonePhases[t] += TONES[t] / sampleRate;
          if (this.tonePhases[t] >= 1.0) this.tonePhases[t] -= 1.0;
        }
        this.samplesInPhase++;
        if (this.samplesInPhase >= this.sps * 2) {
          this.advancePhase();
        }
        break;
      }

      case Phase.kData: {
        if (this.bitPos >= this.bitstream.length) {
          this.advancePhase();
          break;
        }
        if (this.samplesInPhase < this.sps) {
          for (let t = 0; t < this.cfg.bitsPerFrame; t++) {
            // Advance phase for ALL tones every sample — ensures continuity
            // even for tones that toggle ON/OFF across symbol boundaries.
            this.tonePhases[t] += TONES[t] / sampleRate;
            if (this.tonePhases[t] >= 1.0) this.tonePhases[t] -= 1.0;
            if ((this.bitPos + t) < this.bitstream.length && this.bitstream[this.bitPos + t]) {
              output += Math.sin(2 * Math.PI * this.tonePhases[t]) * toneAmp;
            }
          }
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

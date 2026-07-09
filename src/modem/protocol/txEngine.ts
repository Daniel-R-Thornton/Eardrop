/**
 * txEngine.ts — Complete transmission engine for the Eardrop modem.
 *
 * State machine: CALIBRATION → HEADER → DATA → END
 *
 * Generates audio for a complete file transfer:
 *   1. Preamble (warble → cal → inv → sweep) — 620ms
 *   2. Header atomic frame (type=0x01) — file metadata
 *   3. Data atomic frames (type=0x02) — file payload
 *   4. Tail atomic frame (type=0x03) — end marker
 *
 * All audio is BPSK-modulated on 4 data tones with continuous pilot,
 * peak-normalized to [-1, 1].
 */

import { type ModemConfig, TONE_OFFSETS, DEFAULT_CONFIG } from '../types';
import { generatePreamble, type PreambleConfig } from '../protocol/preamble';
import { encodeFrame, type AtomicHeader, FRAME_SIZE, PAYLOAD_DATA_SIZE } from '../protocol/atomicFrame';
import { BPSKModulator, type BPSKModulatorConfig } from '../modulation/BPSKModulator';

// ─── Constants ───────────────────────────────────────

/** Samples per symbol — atomic frame protocol uses fixed 256 SPS */
const SPS = 256;
const TONE_COUNT = 4;

// ─── TxEngine ────────────────────────────────────────

export class TxEngine {
  private cfg: ModemConfig;
  /** Absolute tone frequencies (pilot + offsets) */
  private toneFreqs: [number, number, number, number];
  /** Shared BPSK tone generator (phase accumulators, pilot, data tones) */
  private modulator: BPSKModulator;

  constructor(cfg: Partial<ModemConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    const offsets = this.cfg.musical ? [87.5, 162.5, 287.5, 487.5] : TONE_OFFSETS;
    this.toneFreqs = [
      this.cfg.pilotFreqHz + offsets[0],
      this.cfg.pilotFreqHz + offsets[1],
      this.cfg.pilotFreqHz + offsets[2],
      this.cfg.pilotFreqHz + offsets[3],
    ] as [number, number, number, number];

    // Initialize shared BPSK modulator (no wobble/noise — TxEngine is direct)
    const modCfg: BPSKModulatorConfig = {
      sampleRate: this.cfg.sampleRate,
      pilotFreqHz: this.cfg.pilotFreqHz,
      pilotAmplitude: this.cfg.pilotAmplitude,
      dataToneAmplitude: this.cfg.dataToneAmplitude,
      toneFrequencies: new Float32Array(this.toneFreqs),
    };
    this.modulator = new BPSKModulator(modCfg);
  }

  reset(): void {
    this.modulator.reset();
  }

  // ─── Public API ──────────────────────────────────────

  /**
   * Generate complete audio for a file transfer.
   */
  transmitFile(fileName: string, data: Uint8Array): Float32Array {
    this.reset();

    // 1. Generate preamble
    const preamble = this.transmitPreamble();

    // 2. Build atomic frames
    const totalFrames = this.calcFrameCount(data.length);
    const frameAudios: Float32Array[] = [preamble];

    const repeats = this.cfg.diversityMode ? 3 : 1;

    // Header frame (type 0x01) — repeat 3× if diversity mode
    const headerPayload = this.buildHeaderPayload(fileName, data.length);
    const headerFrame = this.transmitFrame(
      {
        type: 0x01,
        seqNum: 0,
        totalFrames,
        crc: 0,
      },
      headerPayload,
    );
    for (let r = 0; r < repeats; r++) frameAudios.push(headerFrame);

    // Data frames (type 0x02) — repeat 3× if diversity mode
    const dataFrames = this.splitDataIntoFrames(data);
    for (let i = 0; i < dataFrames.length; i++) {
      const frameAudio = this.transmitFrame(
        {
          type: 0x02,
          seqNum: 1 + i,
          totalFrames,
          crc: 0,
        },
        dataFrames[i],
      );
      for (let r = 0; r < repeats; r++) frameAudios.push(frameAudio);
    }

    // Tail frame (type 0x03)
    const tailFrame = this.transmitFrame(
      {
        type: 0x03,
        seqNum: totalFrames - 1,
        totalFrames,
        crc: 0,
      },
      new Uint8Array(PAYLOAD_DATA_SIZE),
    );
    for (let r = 0; r < repeats; r++) frameAudios.push(tailFrame);

    // 3. Add tail silence
    frameAudios.push(new Float32Array(SPS * 6));

    // 4. Concatenate all audio segments
    const totalLen = frameAudios.reduce((a, b) => a + b.length, 0);
    const result = new Float32Array(totalLen);
    let offset = 0;
    for (const seg of frameAudios) {
      result.set(seg, offset);
      offset += seg.length;
    }

    // 5. Peak-normalize
    let peak = 0;
    for (let i = 0; i < result.length; i++) {
      const abs = Math.abs(result[i]);
      if (abs > peak) peak = abs;
    }
    if (peak > 1.0) {
      const scale = 1.0 / peak;
      for (let i = 0; i < result.length; i++) result[i] *= scale;
    }

    return result;
  }

  /**
   * Generate just the preamble audio.
   */
  transmitPreamble(): Float32Array {
    const preambleCfg: PreambleConfig = {
      pilotFreqHz: this.cfg.pilotFreqHz,
      pilotAmplitude: this.cfg.pilotAmplitude,
      dataToneAmplitude: this.cfg.dataToneAmplitude,
      sampleRate: this.cfg.sampleRate,
      toneOffsets: this.cfg.musical
        ? [87.5, 162.5, 287.5, 487.5]
        : [TONE_OFFSETS[0], TONE_OFFSETS[1], TONE_OFFSETS[2], TONE_OFFSETS[3]],
    };
    return generatePreamble(preambleCfg);
  }

  /**
   * Generate BPSK-modulated audio for one atomic frame.
   * The audio includes the continuous pilot tone.
   */
  transmitFrame(header: AtomicHeader, payload: Uint8Array): Float32Array {
    // Build the 79-byte atomic frame
    const frame = encodeFrame(header, payload);

    // Convert frame bytes to a bitstream
    const bits: number[] = [];
    const framesPerByte = 8 / TONE_COUNT; // 2
    for (const byte of frame) {
      for (let f = 0; f < framesPerByte; f++) {
        const shift = 8 - (f + 1) * TONE_COUNT;
        for (let ti = 0; ti < TONE_COUNT; ti++) {
          const bit = (byte >> (shift + TONE_COUNT - 1 - ti)) & 1;
          bits.push(bit);
        }
      }
    }

    // Total symbols = bits.length / TONE_COUNT
    const totalSymbols = bits.length / TONE_COUNT;
    const totalSamples = totalSymbols * SPS;

    const audio = new Float32Array(totalSamples);
    let bitIdx = 0;

    for (let sym = 0; sym < totalSymbols; sym++) {
      // Read 4 bits for this symbol, set BPSK multipliers
      for (let t = 0; t < TONE_COUNT; t++) {
        const bit = bitIdx < bits.length ? bits[bitIdx++] : 0;
        this.modulator.bpskMul[t] = bit === 0 ? 1 : -1;
      }

      // Generate SPS samples for this symbol
      for (let s = 0; s < SPS; s++) {
        audio[sym * SPS + s] = this.modulator.generateSample();
      }
    }

    return audio;
  }

  // ─── Private helpers ────────────────────────────────

  /**
   * Build the 40-byte header frame payload.
   * Format: [fileID:4B][totalSize:4B][fileNameLen:1B][fileName...][padding...]
   */
  private buildHeaderPayload(fileName: string, totalSize: number): Uint8Array {
    const nameBytes = new TextEncoder().encode(fileName);
    const payload = new Uint8Array(PAYLOAD_DATA_SIZE);
    let off = 0;

    // File ID hash (brief hash of filename, 4 bytes)
    let hash = 0;
    for (let i = 0; i < nameBytes.length; i++) {
      hash = (hash << 5) - hash + nameBytes[i];
      hash = hash & hash;
    }
    payload[off++] = (hash >> 24) & 0xff;
    payload[off++] = (hash >> 16) & 0xff;
    payload[off++] = (hash >> 8) & 0xff;
    payload[off++] = hash & 0xff;

    // File ID (little-endian)
    console.log(
      `[TX-ENDIAN] File ID: 0x${(hash >> 24).toString(16)} 0x${((hash >> 16) & 0xff).toString(16)} 0x${((hash >> 8) & 0xff).toString(16)} 0x${(hash & 0xff).toString(16)}`,
    );

    // Total file size (4 bytes LE)
    payload[off++] = totalSize & 0xff;
    payload[off++] = (totalSize >> 8) & 0xff;
    payload[off++] = (totalSize >> 16) & 0xff;
    payload[off++] = (totalSize >> 24) & 0xff;

    // File name length (1 byte, max 31)
    const nameLen = Math.min(nameBytes.length, PAYLOAD_DATA_SIZE - 9);
    payload[off++] = nameLen & 0xff;

    // File name
    for (let i = 0; i < nameLen && off < PAYLOAD_DATA_SIZE; i++) {
      payload[off++] = nameBytes[i];
    }

    // Zero-pad remaining
    while (off < PAYLOAD_DATA_SIZE) {
      payload[off++] = 0;
    }

    // Compute CRC for entire payload (40 bytes)
    const crc = this.computeCRC16(payload);
    console.log(`[TX] Header CRC: 0x${(crc >>> 0).toString(16).padStart(4, '0')}`);
    // CRC (little-endian)
    console.log(
      `[TX-ENDIAN] CRC: 0x${(crc >> 8).toString(16).padStart(2, '0')} 0x${(crc & 0xff).toString(16).padStart(2, '0')}`,
    );

    return payload;
  }

  /**
   * Calculate total frame count for a given data size.
   * Header (1) + Data (ceil(size/40)) + Tail (1)
   */
  private calcFrameCount(dataSize: number): number {
    const dataFrames = Math.max(1, Math.ceil(dataSize / PAYLOAD_DATA_SIZE));
    return dataFrames + 2; // header + data + tail
  }

  /**
   * Split file data into 40-byte chunks for atomic frames.
   * Last chunk is zero-padded.
   */
  private splitDataIntoFrames(data: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    const numDataFrames = Math.max(1, Math.ceil(data.length / PAYLOAD_DATA_SIZE));

    for (let i = 0; i < numDataFrames; i++) {
      const start = i * PAYLOAD_DATA_SIZE;
      const chunk = data.slice(start, start + PAYLOAD_DATA_SIZE);
      if (chunk.length < PAYLOAD_DATA_SIZE) {
        const padded = new Uint8Array(PAYLOAD_DATA_SIZE);
        padded.set(chunk, 0);
        frames.push(padded);
      } else {
        frames.push(chunk);
      }
    }

    return frames;
  }

  private computeCRC16(data: Uint8Array): number {
    let crc = 0xffff;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i] << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) crc = (crc << 1) ^ 0x1021;
        else crc <<= 1;
      }
    }
    return crc & 0xffff;
  }
}

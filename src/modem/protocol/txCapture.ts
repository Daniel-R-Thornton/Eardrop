/**
 * txCapture.ts — pure, side-effect-free re-derivation of per-frame encode
 * stages for the Tektronix-style demo UI.
 *
 * This does NOT touch the real TX hot path (TxEngine). It re-derives display
 * waveforms from the same primitives (encodeFrame, tone frequencies) so the
 * UI can show FrameAnatomy / ECC / tone-wave stages without instrumenting
 * the production encoder. Wire bytes come from the real `encodeFrame` and
 * are therefore exact; the DSP waveforms are faithful reconstructions, not
 * required to be sample-identical to TxEngine's own modulation.
 */

import type { ModemConfig } from '../types';
import { TONE_OFFSETS, DEFAULT_CONFIG } from '../types';
import {
  encodeFrame,
  FRAME_SIZE,
  SENTINEL_SIZE,
  BCH_HEADER_SIZE,
  RS_PAYLOAD_SIZE,
  PAYLOAD_DATA_SIZE,
  type AtomicHeader,
} from './atomicFrame';
import type { FrameField, StageBundle, Run } from './captureTypes';

const MAX_POINTS = 2048;

/** Stride-downsample a Float32Array to at most MAX_POINTS. */
function downsample(x: Float32Array): Float32Array {
  if (x.length <= MAX_POINTS) return x;
  const stride = Math.ceil(x.length / MAX_POINTS);
  const out = new Float32Array(Math.ceil(x.length / stride));
  for (let i = 0, j = 0; i < x.length; i += stride, j++) out[j] = x[i];
  return out;
}

function fieldMap(wire: Uint8Array): FrameField[] {
  const b = (off: number, len: number) => Array.from(wire.slice(off, off + len));
  return [
    { name: 'sentinel', offset: 0, length: SENTINEL_SIZE, bytes: b(0, SENTINEL_SIZE) },
    { name: 'bch-header', offset: SENTINEL_SIZE, length: BCH_HEADER_SIZE, bytes: b(SENTINEL_SIZE, BCH_HEADER_SIZE) },
    {
      name: 'rs-payload',
      offset: SENTINEL_SIZE + BCH_HEADER_SIZE,
      length: RS_PAYLOAD_SIZE,
      bytes: b(SENTINEL_SIZE + BCH_HEADER_SIZE, RS_PAYLOAD_SIZE),
    },
  ];
}

/** Synthesize one BPSK data-tone wave for `symbols` at frequency `freq`. */
function toneWave(symbols: number[], freq: number, sr: number, samplesPerSymbol: number): Float32Array {
  const out = new Float32Array(symbols.length * samplesPerSymbol);
  let phase = 0;
  const dphi = (2 * Math.PI * freq) / sr;
  for (let s = 0; s < symbols.length; s++) {
    const sign = symbols[s] ? -1 : 1; // BPSK: bit 1 => phase flip
    for (let n = 0; n < samplesPerSymbol; n++) {
      out[s * samplesPerSymbol + n] = sign * Math.sin(phase);
      phase += dphi;
    }
  }
  return out;
}

export function captureTransmit(
  config: ModemConfig & { useOFDM?: boolean },
  fileName: string,
  data: Uint8Array,
): Run {
  const sr = config.sampleRate ?? DEFAULT_CONFIG.sampleRate;
  const toneCount = config.toneCount ?? 4;
  const pilotHz = config.pilotFreqHz ?? DEFAULT_CONFIG.pilotFreqHz;
  const toneFreqs = TONE_OFFSETS.slice(0, toneCount).map((o) => pilotHz + o);
  const samplesPerSymbol = 256;

  // Split payload into PAYLOAD_DATA_SIZE chunks -> one data frame each.
  const frames: StageBundle[] = [];
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += PAYLOAD_DATA_SIZE) chunks.push(data.slice(i, i + PAYLOAD_DATA_SIZE));
  if (chunks.length === 0) chunks.push(new Uint8Array(0));

  const kinds: StageBundle['frameKind'][] = ['header', ...chunks.map(() => 'data' as const), 'eof'];
  const totalFrames = kinds.length;
  let totalSamples = 0;

  kinds.forEach((frameKind, frameIndex) => {
    // Header/eof carry an empty display payload (real header/tail payload
    // construction lives in TxEngine and isn't needed for display capture).
    // Data frames carry their chunk. Wire bytes still come from the real
    // encodeFrame using the real AtomicHeader shape (type/seqNum/totalFrames/crc).
    const payload = frameKind === 'data' ? chunks[frameIndex - 1] : new Uint8Array(0);
    const type = frameKind === 'header' ? 0x01 : frameKind === 'data' ? 0x02 : 0x03;
    const header: AtomicHeader = { type, seqNum: frameIndex, totalFrames, crc: 0 };
    const wire = encodeFrame(header, payload);

    // Bits -> per-tone symbol streams (round-robin across data tones).
    const bits: number[] = [];
    for (const byte of wire) for (let k = 7; k >= 0; k--) bits.push((byte >> k) & 1);
    const perTone: number[][] = Array.from({ length: toneCount }, () => []);
    bits.forEach((bit, i) => perTone[i % toneCount].push(bit));

    const toneWaves = perTone.map((syms, t) => toneWave(syms, toneFreqs[t], sr, samplesPerSymbol));
    const maxLen = Math.max(...toneWaves.map((w) => w.length));
    const combined = new Float32Array(maxLen);
    for (const w of toneWaves) for (let i = 0; i < w.length; i++) combined[i] += w[i] / toneCount;
    const pilotWave = toneWave(new Array(Math.ceil(maxLen / samplesPerSymbol)).fill(0), pilotHz, sr, samplesPerSymbol).subarray(
      0,
      maxLen,
    );

    // QPSK: pair consecutive bits into a 4-quadrant point (jittered so
    // overlapping points are visible as a cloud on the constellation).
    const symbols: { i: number; q: number }[] = [];
    for (let k = 0; k + 1 < bits.length && symbols.length < 96; k += 2) {
      const jx = ((k * 37) % 13) / 130 - 0.05;
      const jy = ((k * 19) % 13) / 130 - 0.05;
      symbols.push({ i: (bits[k] ? -1 : 1) + jx, q: (bits[k + 1] ? -1 : 1) + jy });
    }

    totalSamples += combined.length;
    frames.push({
      frameKind,
      frameIndex,
      payloadBytes: Array.from(payload),
      frameFields: fieldMap(wire),
      eccBefore: Array.from(payload),
      eccAfter: Array.from(wire),
      eccScheme: 'bch3116+rs',
      correctionCapacity: 8,
      symbols,
      toneWaves: toneWaves.map(downsample),
      pilotWave: downsample(pilotWave),
      combined: downsample(combined),
      preamble: frameIndex === 0 ? downsample(combined.subarray(0, samplesPerSymbol)) : new Float32Array(0),
      txFinal: downsample(combined),
      sampleRate: sr,
    });
  });

  return { fileName, totalSamples, sampleRate: sr, frames };
}

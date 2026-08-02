/**
 * Probe burst — the chatter room's "who's out there, and how does the room
 * sound" packet.
 *
 * A device joining (or polling) the chatter room emits this burst instead of
 * a full handshake: a down-chirp anchor, a coarse frequency sweep, and a
 * pulse-keyed device ID. Every other device in earshot can pick it up
 * passively — no reply, no negotiation — and come away knowing WHO is present
 * and WHAT the acoustic path currently looks like.
 *
 * Wire layout, all measured from the chirp START (the "anchor"):
 *
 *   [0, chirpMs)                              down-chirp  (4400→1200 Hz)
 *   [chirpMs, chirpMs+gapMs)                   gap (silence)
 *   [..., ...+sweep audio length)              coarse sweep (CHATTER_SWEEP)
 *   [..., ...+gapMs)                           gap (silence)
 *   [..., ...+idSlots*idSlotMs)                12 pulse-keyed ID bits
 *
 * A 100 ms silent lead-in precedes the chirp in the buffer `buildProbeBurst`
 * returns, purely so a receiver's ring buffer has quiet on both sides of the
 * chirp to correlate against; `anchor` in every decode function is the sample
 * index where the chirp itself starts, not the start of the buffer.
 *
 * WHY a DOWN-chirp: the modem's own sync/pilot chirp sweeps low→high. Every
 * data transmission on the wire already contains that shape, so a probe
 * listener correlating against it would false-trigger on ordinary traffic.
 * Reversing direction makes the probe's anchor a shape that data transmission
 * never produces.
 *
 * WHY pulse-keyed (not QAM) for the ID: 12 bits is little enough that on/off
 * keying a single tone, gated by a threshold measured against the OTHER
 * slots in the same burst, needs no amplitude reference, no channel
 * estimate, and no clock recovery beyond the chirp's own anchor. That
 * self-referencing threshold is also why the sweep sits in the middle:
 * it exists to characterize the channel, not to help decode the ID.
 */

import {
  buildSweep, measureSweep, sampleResponseAt,
  type SweepPlan, type SweepResult,
} from '../diag/channelSweep';
import { generateChirp } from './chirp';
import { toneIQ } from '../pilot';

/** The coarse sweep every probe burst carries — band-pick resolution, not
 *  notch-hunting resolution. 100 Hz steps over the full acoustic band the
 *  chatter room can use, at ~2.9 s total. */
export const CHATTER_SWEEP = {
  startHz: 1500,
  endHz: 7800,
  stepHz: 100,
  stepMs: 45,
  amplitude: 0.02,
} as const; // ~2.9 s, coarse by design (band pick, not notch hunting)

/** The frequency grid a decoded sweep is reported on — fixed, so reports from
 *  different devices (built from different SweepPlans if config ever drifts)
 *  are still directly comparable. */
export const REPORT_GRID = { startHz: 1500, stepHz: 100, points: 64 } as const;

/** [1500, 1600, ..., 7800] — the frequencies `measureProbeSweep` reports at. */
export function reportGridFreqs(): number[] {
  const freqs: number[] = [];
  for (let k = 0; k < REPORT_GRID.points; k++) freqs.push(REPORT_GRID.startHz + k * REPORT_GRID.stepHz);
  return freqs;
}

/** Burst layout timing, all in ms except slot count. */
export const PROBE_LAYOUT = {
  chirpMs: 150,
  gapMs: 50,
  idSlotMs: 40,
  idSlots: 12,
} as const;

/** Down-chirp shape: 4400→1200 Hz, reversed direction vs the sync chirp so
 *  data-transmission chirps do not false-trigger probe detection. Shared by
 *  the correlation template and the burst itself so they can never drift
 *  apart. */
const DOWN_CHIRP = { fStart: 4400, fEnd: 1200, durationSec: PROBE_LAYOUT.chirpMs / 1000 } as const;

/** Down-chirp anchor: 4400→1200 Hz, 150 ms. */
export function probeChirpTemplate(sampleRate: number): Float32Array {
  return generateChirp({ ...DOWN_CHIRP, sampleRate });
}

/** Lead-in silence before the chirp, so a receiver's ring buffer has quiet on
 *  both sides of the chirp to correlate against. Not part of the layout the
 *  decode functions measure from — they all key off the chirp's own anchor. */
const LEAD_IN_MS = 100;

/** ID pulse tone — arbitrary but fixed so encode/decode agree, and far enough
 *  from both the chirp's sweep range and the coarse sweep's band that it
 *  cannot be confused with either. */
const PULSE_HZ = 2500;
const PULSE_MS = 25;
const PULSE_AMPLITUDE = 0.15;

function ms(sampleRate: number, milliseconds: number): number {
  return Math.round((milliseconds / 1000) * sampleRate);
}

function sweepPlan(sampleRate: number): SweepPlan {
  return buildSweep({ ...CHATTER_SWEEP, sampleRate });
}

/** Slot k carries bit k of the 12-bit word V = (deviceId << 4) | crc4(deviceId),
 *  LSB-first — so slot 0 is the CRC's own least-significant bit and slot 11
 *  is the device ID's most-significant bit. Sent LSB-first (rather than the
 *  more obvious MSB-first) so that decoding does not depend on either field's
 *  own endpoint bit, which is what a plain MSB/LSB-first split of the two
 *  fields separately would do. */
function idBits(deviceId: number): number[] {
  const packed = ((deviceId & 0xff) << 4) | crc4(deviceId & 0xff);
  const bits: number[] = [];
  for (let k = 0; k < 12; k++) bits.push((packed >> k) & 1);
  return bits;
}

/** One ID slot's audio: silence, except for a centered 25 ms raised-cosine
 *  faded tone when the bit is 1 (on/off keying). */
function buildIdSlot(bit: number, sampleRate: number): Float32Array {
  const slotSamples = ms(sampleRate, PROBE_LAYOUT.idSlotMs);
  const slot = new Float32Array(slotSamples);
  if (!bit) return slot;

  const pulseSamples = ms(sampleRate, PULSE_MS);
  const fadeSamples = pulseSamples >> 2;
  const start = (slotSamples - pulseSamples) >> 1;
  const w = (2 * Math.PI * PULSE_HZ) / sampleRate;
  for (let n = 0; n < pulseSamples; n++) {
    let env = 1;
    if (n < fadeSamples) env = 0.5 - 0.5 * Math.cos((Math.PI * n) / fadeSamples);
    else if (n >= pulseSamples - fadeSamples) {
      const m = pulseSamples - 1 - n;
      env = 0.5 - 0.5 * Math.cos((Math.PI * m) / fadeSamples);
    }
    slot[start + n] = PULSE_AMPLITUDE * env * Math.sin(w * n);
  }
  return slot;
}

/** silence(100ms) + downChirp + gap + sweep + gap + 12 pulse slots. */
export function buildProbeBurst(deviceId: number, sampleRate: number): Float32Array {
  const chirp = generateChirp({ ...DOWN_CHIRP, sampleRate, amplitude: 0.5 });
  const gap = new Float32Array(ms(sampleRate, PROBE_LAYOUT.gapMs));
  const sweep = sweepPlan(sampleRate).audio;
  const bits = idBits(deviceId);
  const slots = bits.map((bit) => buildIdSlot(bit, sampleRate));

  const leadIn = new Float32Array(ms(sampleRate, LEAD_IN_MS));
  const total =
    leadIn.length + chirp.length + gap.length + sweep.length + gap.length +
    slots.reduce((sum, s) => sum + s.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  out.set(leadIn, off); off += leadIn.length;
  out.set(chirp, off); off += chirp.length;
  out.set(gap, off); off += gap.length;
  out.set(sweep, off); off += sweep.length;
  out.set(gap, off); off += gap.length;
  for (const slot of slots) { out.set(slot, off); off += slot.length; }
  return out;
}

/** Total samples from chirp START to burst end (for RX buffering). */
export function probeBurstSamplesAfterChirp(sampleRate: number): number {
  const chirpSamples = ms(sampleRate, PROBE_LAYOUT.chirpMs);
  const gapSamples = ms(sampleRate, PROBE_LAYOUT.gapMs);
  const sweepSamples = sweepPlan(sampleRate).audio.length;
  const idSamples = PROBE_LAYOUT.idSlots * ms(sampleRate, PROBE_LAYOUT.idSlotMs);
  return chirpSamples + gapSamples + sweepSamples + gapSamples + idSamples;
}

/** Sample offset (from anchor) where the ID slots begin. */
function idSlotsStart(sampleRate: number): number {
  const chirpSamples = ms(sampleRate, PROBE_LAYOUT.chirpMs);
  const gapSamples = ms(sampleRate, PROBE_LAYOUT.gapMs);
  const sweepSamples = sweepPlan(sampleRate).audio.length;
  return chirpSamples + gapSamples + sweepSamples + gapSamples;
}

/** anchor = sample index where the chirp STARTS in `samples`.
 *  Returns null on CRC failure. */
export function decodeProbeId(samples: Float32Array, anchor: number, sampleRate: number): number | null {
  const slotSamples = ms(sampleRate, PROBE_LAYOUT.idSlotMs);
  const start = anchor + idSlotsStart(sampleRate);

  const mags: number[] = [];
  for (let k = 0; k < PROBE_LAYOUT.idSlots; k++) {
    const slotStart = start + k * slotSamples;
    const slot = samples.subarray(slotStart, slotStart + slotSamples);
    const { i, q } = toneIQ(slot, PULSE_HZ, sampleRate);
    mags.push(Math.hypot(i, q));
  }

  // Self-referencing threshold: split the 12 slot magnitudes into "pulse
  // present" / "pulse absent" clusters by the largest gap in sorted order.
  // A single fixed multiple of the literal median breaks down whenever half
  // or more of the 12 bits are 1 (the median then falls IN the "on" cluster,
  // so no on-slot can ever be 4x itself) — which is a common case, not an
  // edge case, for an 8-bit ID + 4-bit CRC. The largest-gap split has no such
  // failure mode: it works for any on/off ratio from 1-in-12 to 11-in-12.
  const sorted = mags.slice().sort((a, b) => a - b);
  let gapIdx = 0;
  let gapSize = -Infinity;
  for (let k = 0; k < sorted.length - 1; k++) {
    const gap = sorted[k + 1] - sorted[k];
    if (gap > gapSize) { gapSize = gap; gapIdx = k; }
  }
  const threshold = (sorted[gapIdx] + sorted[gapIdx + 1]) / 2;
  const bits = mags.map((m) => (m > threshold ? 1 : 0));

  // Undo the LSB-first packing from idBits: bits[k] is bit k of V.
  let packed = 0;
  for (let k = 0; k < 12; k++) packed |= bits[k] << k;
  const deviceId = (packed >> 4) & 0xff;
  const crc = packed & 0xf;

  if (crc4(deviceId) !== crc) return null;
  return deviceId;
}

/** Measure the burst's sweep, sampled onto REPORT_GRID (linear mags). */
export function measureProbeSweep(samples: Float32Array, anchor: number, sampleRate: number): number[] | null {
  const chirpSamples = ms(sampleRate, PROBE_LAYOUT.chirpMs);
  const gapSamples = ms(sampleRate, PROBE_LAYOUT.gapMs);
  const plan = sweepPlan(sampleRate);
  const start = anchor + chirpSamples + gapSamples;
  const slice = samples.subarray(start, start + plan.audio.length);

  const result: SweepResult = measureSweep(slice, plan);
  if (result.failed) return null;
  return sampleResponseAt(result, reportGridFreqs());
}

/** CRC-4 (poly x^4+x+1, MSB-first, non-reflected) over the 8 id bits. */
export function crc4(byte: number): number {
  let crc = 0;
  for (let i = 7; i >= 0; i--) {
    const bit = (byte >> i) & 1;
    const feedback = ((crc >> 3) & 1) ^ bit;
    crc = (crc << 1) & 0xf;
    if (feedback) crc ^= 0b0011;
  }
  return crc & 0xf;
}

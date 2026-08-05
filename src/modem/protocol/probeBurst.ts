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
 *   [..., ...+idSlots*idSlotMs)                13 pulse-keyed bits (8 id + 1 purpose + 4 CRC)
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
 * WHY pulse-keyed (not QAM) for the ID: 13 bits is little enough that on/off
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
  /**
   * Matched to the ID pulses, NOT inherited from SWEEP_DEFAULTS' 0.02.
   *
   * That default is sized for the calibration tool, where the point is to
   * probe at the same operating level a 32-40 tone grid uses per tone. A
   * probe burst is a different animal: one tone at a time, sharing a burst
   * with a 0.5 chirp, and the player normalises the WHOLE burst by its peak.
   * At 0.02 the sweep therefore landed near -28 dBFS while the chirp sat at
   * full scale — and the sweep is 2.9 of the burst's 3.7 seconds, so almost
   * everything a listener hears, and everything the channel measurement
   * rides on, was the quietest part of the transmission by a factor of 25.
   *
   * 0.15 is ~17 dB louder and still well under the 0.25 where a sustained
   * single tone was measured compressing by 14 dB, which would flatten the
   * very response this is here to measure.
   */
  amplitude: 0.15,
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

/**
 * What a probe burst is announcing, so a listener knows which reply to send
 * instead of guessing.
 *
 * Before this bit existed the wire-level burst was identical for a join and a
 * roll call, and the only way to tell them apart was whether the listener
 * already knew the prober — which is one-sided and wrong in both directions.
 * A device rejoining with the same id (page refresh, reconnect) is a stranger
 * to itself but a known member to everyone else, so it received a REPORT when
 * it needed a WELCOME; and a peer whose WELCOME was lost still considers us a
 * stranger, so it answers our roll call with a WELCOME. See
 * roomProtocol.ts's onProbeHeard for the inference this replaces.
 */
export const PROBE_PURPOSE = { joining: 0, rollCall: 1 } as const;
export type ProbePurpose = (typeof PROBE_PURPOSE)[keyof typeof PROBE_PURPOSE];

/** Burst layout timing, all in ms except slot count. */
export const PROBE_LAYOUT = {
  chirpMs: 150,
  gapMs: 50,
  idSlotMs: 40,
  // 13, not 12: 8 id bits + 1 purpose bit + 4 CRC bits. One extra 40 ms slot
  // (~3.74 s burst, up from ~3.70 s) buys an explicitly signalled reply type.
  // Wire constant — both ends read it, and a mismatch fails CRC, so an
  // old-build peer's probes are dropped rather than misread.
  idSlots: 13,
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

/**
 * ID pulse tone — arbitrary but fixed so encode/decode agree.
 *
 * The old claim here ("far enough from both the chirp's sweep range and the
 * coarse sweep's band that it cannot be confused with either") was written
 * when the handshake band sat at 6900-7250 Hz, and it enumerated only two of
 * the three neighbours this tone now has. 2500 Hz is:
 *   - inside the down-chirp's own sweep (4400->1200) and inside the coarse
 *     sweep's band (1500-7800) — it was never actually clear of either, which
 *     is fine: the ID slots are separated from both in TIME, not in frequency,
 *     and every decode is anchored on the down-chirp;
 *   - 100 Hz BELOW OFDM_HANDSHAKE's first tone (2600) and 500 Hz above its
 *     pilot (2000), since that band moved down to 2600-2950.
 *
 * No decode path breaks on that last one: decodeProbeId only ever runs off a
 * down-chirp anchor, so a control message's tones are never read as ID slots,
 * and the worker re-arms the control listener after every burst. But NOTHING
 * CURRENTLY CONSTRAINS PULSE_HZ against OFDM_HANDSHAKE — no test, no derived
 * clearance — so a future move of either value can put them on top of each
 * other with nothing complaining.
 */
const PULSE_HZ = 2500;
const PULSE_MS = 25;
const PULSE_AMPLITUDE = 0.15;

function ms(sampleRate: number, milliseconds: number): number {
  return Math.round((milliseconds / 1000) * sampleRate);
}

function sweepPlan(sampleRate: number): SweepPlan {
  return buildSweep({ ...CHATTER_SWEEP, sampleRate });
}

/** Sample count of the sweep audio, without synthesizing it. Mirrors the
 *  step count `buildSweep` computes internally before its per-sample cos()
 *  loop — needed by every length/offset calculation (`probeBurstSamplesAfterChirp`,
 *  `idSlotsStart`, called on every decode) that only wants a length, not the
 *  ~139k-sample waveform itself. */
function sweepSampleCount(sampleRate: number): number {
  const { startHz, endHz, stepHz, stepMs } = CHATTER_SWEEP;
  const steps = Math.floor((endHz - startHz) / stepHz) + 1;
  return steps * ms(sampleRate, stepMs);
}

/** Slot k carries bit k of the 13-bit word
 *  V = (word << 4) | crc4Bits(word, 9), where word = (deviceId << 1) | purpose
 *  — LSB-first, so slot 0 is the CRC's least-significant bit, slot 4 is the
 *  purpose bit, and slot 12 is the device ID's most-significant bit. Sent
 *  LSB-first (rather than the more obvious MSB-first) so that decoding does
 *  not depend on either field's own endpoint bit. */
function idBits(deviceId: number, purpose: ProbePurpose): number[] {
  const word = ((deviceId & 0xff) << 1) | (purpose & 1);
  const packed = (word << 4) | crc4Bits(word, 9);
  const bits: number[] = [];
  for (let k = 0; k < PROBE_LAYOUT.idSlots; k++) bits.push((packed >> k) & 1);
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

/** silence(100ms) + downChirp + gap + sweep + gap + 13 pulse slots. */
export function buildProbeBurst(
  deviceId: number,
  sampleRate: number,
  purpose: ProbePurpose = PROBE_PURPOSE.joining,
): Float32Array {
  const chirp = generateChirp({ ...DOWN_CHIRP, sampleRate, amplitude: 0.5 });
  const gap = new Float32Array(ms(sampleRate, PROBE_LAYOUT.gapMs));
  const sweep = sweepPlan(sampleRate).audio;
  const bits = idBits(deviceId, purpose);
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
  const sweepSamples = sweepSampleCount(sampleRate);
  const idSamples = PROBE_LAYOUT.idSlots * ms(sampleRate, PROBE_LAYOUT.idSlotMs);
  return chirpSamples + gapSamples + sweepSamples + gapSamples + idSamples;
}

/** Sample offset (from anchor) where the ID slots begin. */
function idSlotsStart(sampleRate: number): number {
  const chirpSamples = ms(sampleRate, PROBE_LAYOUT.chirpMs);
  const gapSamples = ms(sampleRate, PROBE_LAYOUT.gapMs);
  const sweepSamples = sweepSampleCount(sampleRate);
  return chirpSamples + gapSamples + sweepSamples + gapSamples;
}

/** anchor = sample index where the chirp STARTS in `samples`.
 *  Returns null on CRC failure. */
export function decodeProbeId(
  samples: Float32Array,
  anchor: number,
  sampleRate: number,
): { deviceId: number; purpose: ProbePurpose } | null {
  // chirpCorrelate returns peakIndex -1 when its template is longer than the
  // signal — never a real anchor. Guard here rather than let it silently
  // slice into whatever precedes `samples[0]`.
  if (anchor < 0) return null;
  const slotSamples = ms(sampleRate, PROBE_LAYOUT.idSlotMs);
  const start = anchor + idSlotsStart(sampleRate);

  const mags: number[] = [];
  for (let k = 0; k < PROBE_LAYOUT.idSlots; k++) {
    const slotStart = start + k * slotSamples;
    const slot = samples.subarray(slotStart, slotStart + slotSamples);
    const { i, q } = toneIQ(slot, PULSE_HZ, sampleRate);
    mags.push(Math.hypot(i, q));
  }

  // Self-referencing threshold: split the 13 slot magnitudes into "pulse
  // present" / "pulse absent" clusters by the largest gap in sorted order.
  // A single fixed multiple of the literal median breaks down whenever half
  // or more of the 13 bits are 1 (the median then falls IN the "on" cluster,
  // so no on-slot can ever be 4x itself) — which is a common case, not an
  // edge case, for an 8-bit ID + 1 purpose bit + 4-bit CRC. The largest-gap
  // split has no such failure mode: it works for any on/off ratio from
  // 1-in-13 to 12-in-13.
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
  for (let k = 0; k < PROBE_LAYOUT.idSlots; k++) packed |= bits[k] << k;
  const word = (packed >> 4) & 0x1ff;
  const crc = packed & 0xf;

  if (crc4Bits(word, 9) !== crc) return null;
  return { deviceId: (word >> 1) & 0xff, purpose: (word & 1) as ProbePurpose };
}

/** Measure the burst's sweep, sampled onto REPORT_GRID (linear mags). */
export function measureProbeSweep(samples: Float32Array, anchor: number, sampleRate: number): number[] | null {
  if (anchor < 0) return null;
  const chirpSamples = ms(sampleRate, PROBE_LAYOUT.chirpMs);
  const gapSamples = ms(sampleRate, PROBE_LAYOUT.gapMs);
  const plan = sweepPlan(sampleRate);
  const start = anchor + chirpSamples + gapSamples;
  const slice = samples.subarray(start, start + plan.audio.length);

  const result: SweepResult = measureSweep(slice, plan);
  if (result.failed) return null;
  return sampleResponseAt(result, reportGridFreqs());
}

/** CRC-4 (poly x^4+x+1, MSB-first, non-reflected) over the low `bitCount`
 *  bits of `value`. Parameterised because the ID word grew from 8 bits to 9
 *  when the purpose bit was added, and the CRC has to cover the purpose bit
 *  too — a silent flip there sends the wrong reply type, which is the exact
 *  failure the bit exists to prevent. */
function crc4Bits(value: number, bitCount: number): number {
  let crc = 0;
  for (let i = bitCount - 1; i >= 0; i--) {
    const bit = (value >> i) & 1;
    const feedback = ((crc >> 3) & 1) ^ bit;
    crc = (crc << 1) & 0xf;
    if (feedback) crc ^= 0b0011;
  }
  return crc & 0xf;
}

/** CRC-4 over the 8 id bits — the pre-purpose-bit form. TEST-ONLY: no
 *  production caller remains (the wire format covers 9 bits, see idBits), and
 *  probeBurst.test.ts is the sole consumer. It used to say "kept for callers
 *  that only have a device id"; there are none. */
export function crc4(byte: number): number {
  return crc4Bits(byte & 0xff, 8);
}

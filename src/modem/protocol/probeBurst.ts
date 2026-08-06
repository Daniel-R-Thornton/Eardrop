/**
 * Probe burst — the chatter room's "who's out there, and how does the room
 * sound" packet.
 *
 * A device joining (or polling) the chatter room emits this burst instead of
 * a full handshake: a down-chirp anchor, a multitone channel probe, and a
 * pulse-keyed device ID. Every other device in earshot can pick it up
 * passively — no reply, no negotiation — and come away knowing WHO is present
 * and WHAT the acoustic path currently looks like.
 *
 * Wire layout, all measured from the chirp START (the "anchor"):
 *
 *   [0, chirpMs)                              down-chirp  (4400→1200 Hz)
 *   [chirpMs, chirpMs+gapMs)                   gap (silence)
 *   [..., ...+multitone length)                multitone probe (CHATTER_MULTITONE)
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
 * self-referencing threshold is also why the multitone sits in the middle:
 * it exists to characterize the channel, not to help decode the ID.
 */

import { generateChirp } from './chirp';
import { toneIQ } from '../pilot';

/**
 * The multitone burst every probe carries — the room's channel measurement.
 *
 * WHY NOT A STEPPED SWEEP (what this replaces): a sweep measures one frequency
 * at a time, so its length is points x step time — 64 x 45 ms = 2.9 s, which
 * was 78% of the entire probe burst. A multitone measures every frequency AT
 * ONCE. All tones are integer multiples of `spacingHz`, so they are mutually
 * orthogonal over any whole number of 1/spacingHz windows: one 20 ms window
 * separates all 126 of them exactly, and the repeats below buy coherent
 * processing gain rather than buying more frequencies.
 *
 * The probe drops from 3.84 s to ~0.93 s as a result, and that is not just a
 * latency win. A roll-call reply is transmitted into the decaying reverb of
 * the prober's own burst — hardware logs show those replies handing off at
 * 0.68-0.83 where messages arriving into a quiet room score 0.93-0.97. Four
 * times less energy pumped into the room is four times less tail sitting on
 * top of the REPORT that has to be decoded through it.
 *
 * 50 Hz spacing, not the old grid's 100: the control tones sit 50 Hz apart, so
 * a 100 Hz measurement could only ever see every OTHER one and a null on an
 * odd tone was invisible (see handshakeToneMags). REPORT_GRID stays at 100 Hz
 * — it is a wire format — and simply takes every second measured tone, so
 * nothing downstream changes while the measurement itself gets twice the
 * resolution.
 */
export const CHATTER_MULTITONE = {
  startHz: 1500,
  endHz: 7800,
  /** Tone spacing. Sets both the resolution AND the minimum analysis window
   *  (1/50 Hz = 20 ms), since orthogonality is what separates the tones. */
  spacingHz: 50,
  /** One orthogonality period. Every tone completes a whole number of cycles
   *  in exactly this long, which is what makes a single window separate them. */
  symbolMs: 20,
  /** Repeats of that window. Coherent integration over all of them, so this is
   *  pure SNR: 8 repeats is ~9 dB over one, for 160 ms of air.
   *
   *  This is the knob to turn if a room proves too noisy to measure — it costs
   *  time linearly and buys SNR at 10log10(N), where the old sweep bought SNR
   *  by spending time PER FREQUENCY (64x worse for the same gain). */
  repeats: 8,
  /**
   * Peak the multitone is normalised to, before the player's own whole-burst
   * normalisation.
   *
   * A multitone can be driven far harder than the sweep it replaces BECAUSE of
   * the Schroeder phasing below: 126 tones summed in phase would crest at ~11x
   * RMS and have to be attenuated to fit, which is exactly how the old sweep
   * ended up ~28 dB below the chirp sharing its burst. Schroeder phases flatten
   * the crest to under 3, so the energy goes into the channel instead of into
   * headroom.
   *
   * 0.22 measures out at RMS 0.1155 (crest 1.91). Compare that against the
   * 0.25 at which a sustained tone was measured compressing by 14 dB: that
   * tone's RMS is 0.177, so this sits ~3.7 dB BELOW the level known to
   * compress, not just below its peak. Peak-vs-peak would be the wrong
   * comparison — compression follows delivered power, and a crest-1.91
   * waveform delivers far less of it at equal peak than a sine does.
   *
   * THE COST, recorded because it is real and the opposite of the win above:
   * spreading the same peak across 127 tones puts ~15 dB less ENERGY into each
   * frequency than the stepped sweep did (which spent 45 ms on one tone at a
   * time at amplitude 0.15). The measurement is correspondingly noisier per
   * point. Two knobs if a real room proves too noisy to measure: `repeats`
   * (+3 dB per doubling, 20 ms each), or this — there is ~4 dB of level left
   * before reaching the compression threshold above. Neither has been needed
   * against a measured failure yet, so neither has been spent.
   */
  peak: 0.22,
} as const;

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

/** Every frequency the multitone carries: [1500, 1550, ..., 7800]. */
export function multitoneFreqs(): number[] {
  const { startHz, endHz, spacingHz } = CHATTER_MULTITONE;
  const freqs: number[] = [];
  for (let f = startHz; f <= endHz; f += spacingHz) freqs.push(f);
  return freqs;
}

/** Sample count of the multitone audio, without synthesizing it — needed by
 *  the length/offset maths (`probeBurstSamplesAfterChirp`, `idSlotsStart`)
 *  that runs on every decode and only wants a length. */
function multitoneSampleCount(sampleRate: number): number {
  return CHATTER_MULTITONE.repeats * ms(sampleRate, CHATTER_MULTITONE.symbolMs);
}

/**
 * Schroeder phase for tone `k` of `n`: phi_k = -pi k^2 / n.
 *
 * The reason a multitone is usable at all here. Summing n equal-amplitude
 * tones at phase 0 produces a single impulse of amplitude n — crest factor
 * ~sqrt(n) against RMS, ~11 for 126 tones — so the burst has to be scaled down
 * by that factor to avoid clipping, and almost all the transmit headroom is
 * spent on one sample. Schroeder's quadratic phase ramp spreads the energy
 * evenly across the window (it is a discrete chirp in disguise), giving a
 * crest under 3, which is what lets `peak` above sit at 0.22 instead of ~0.02.
 */
function schroederPhase(k: number, n: number): number {
  return (-Math.PI * k * k) / n;
}

/**
 * The multitone burst: every measured frequency at once, Schroeder-phased,
 * repeated `repeats` times and normalised to `peak`.
 *
 * Exported for the PAPR test — the crest factor is the property the whole
 * design rests on, and it is not visible from the burst as a whole (the chirp
 * dominates that peak).
 */
export function buildProbeMultitone(sampleRate: number): Float32Array {
  const freqs = multitoneFreqs();
  const period = ms(sampleRate, CHATTER_MULTITONE.symbolMs);
  const one = new Float32Array(period);
  for (let k = 0; k < freqs.length; k++) {
    const w = (2 * Math.PI * freqs[k]) / sampleRate;
    const phase = schroederPhase(k, freqs.length);
    for (let n = 0; n < period; n++) one[n] += Math.cos(w * n + phase);
  }
  // Normalise the single period, then repeat it. Repeating a normalised period
  // (rather than normalising the whole run) keeps every repeat sample-identical,
  // which is what makes the receiver's integration across them coherent.
  let peak = 0;
  for (let n = 0; n < period; n++) peak = Math.max(peak, Math.abs(one[n]));
  const scale = peak > 0 ? CHATTER_MULTITONE.peak / peak : 0;
  for (let n = 0; n < period; n++) one[n] *= scale;

  const out = new Float32Array(period * CHATTER_MULTITONE.repeats);
  for (let r = 0; r < CHATTER_MULTITONE.repeats; r++) out.set(one, r * period);
  return out;
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

/** silence(100ms) + downChirp + gap + multitone + gap + 13 pulse slots. */
export function buildProbeBurst(
  deviceId: number,
  sampleRate: number,
  purpose: ProbePurpose = PROBE_PURPOSE.joining,
): Float32Array {
  const chirp = generateChirp({ ...DOWN_CHIRP, sampleRate, amplitude: 0.5 });
  const gap = new Float32Array(ms(sampleRate, PROBE_LAYOUT.gapMs));
  const sweep = buildProbeMultitone(sampleRate);
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
  const sweepSamples = multitoneSampleCount(sampleRate);
  const idSamples = PROBE_LAYOUT.idSlots * ms(sampleRate, PROBE_LAYOUT.idSlotMs);
  return chirpSamples + gapSamples + sweepSamples + gapSamples + idSamples;
}

/** Sample offset (from anchor) where the ID slots begin. */
function idSlotsStart(sampleRate: number): number {
  const chirpSamples = ms(sampleRate, PROBE_LAYOUT.chirpMs);
  const gapSamples = ms(sampleRate, PROBE_LAYOUT.gapMs);
  const sweepSamples = multitoneSampleCount(sampleRate);
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

/**
 * Measure the burst's multitone, reported on REPORT_GRID (linear mags).
 *
 * Integrates each tone over the WHOLE multitone segment rather than per
 * repeat. Every tone is an integer multiple of `spacingHz` and the segment is
 * a whole number of 1/spacingHz periods, so the integration is exactly
 * coherent: the wanted tone adds in phase across all 8 repeats while every
 * other tone — and any noise not sitting precisely on the grid — averages
 * toward zero. That is where the SNR comes from, and it is why the repeats
 * cost 20 ms each instead of a full pass over every frequency.
 *
 * `null` (rather than a floor-valued curve) when the segment is silence, so a
 * caller can tell "measured a dead channel" from "heard nothing at all" —
 * see the !PRB-SWEEP log in modemService.
 */
export function measureProbeSweep(samples: Float32Array, anchor: number, sampleRate: number): number[] | null {
  if (anchor < 0) return null;
  const chirpSamples = ms(sampleRate, PROBE_LAYOUT.chirpMs);
  const gapSamples = ms(sampleRate, PROBE_LAYOUT.gapMs);
  const start = anchor + chirpSamples + gapSamples;
  const slice = samples.subarray(start, start + multitoneSampleCount(sampleRate));
  // A partial capture cannot be integrated coherently — the tail of the window
  // would be zeros, which is not the same signal the phases were built for.
  if (slice.length < multitoneSampleCount(sampleRate)) return null;

  const measured = new Map<number, number>();
  for (const hz of multitoneFreqs()) {
    const { i, q } = toneIQ(slice, hz, sampleRate);
    measured.set(hz, Math.hypot(i, q));
  }

  const grid = reportGridFreqs().map((hz) => measured.get(hz) ?? 0);
  // Silence in, nothing out. Every tone reading zero means no signal, not a
  // channel with no response.
  if (!(Math.max(...grid) > 0)) return null;
  return grid;
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

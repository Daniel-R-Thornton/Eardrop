/**
 * llmDump.ts — compress a dlog session into a machine-oriented digest.
 *
 * NOT human-readable, deliberately. The console output stays as it is; this is a
 * separate rendering whose only consumer is an LLM reading a pasted session, and
 * the format is documented in docs/dump-format.md.
 *
 * The problem it solves: per-tone diagnostics dominate a session by volume and
 * carry almost no information per character. A 40-tone QAM constellation dump is
 * ~300 characters of coordinates, and what actually gets read off it is three
 * numbers (gain, dispersion, magnitude spread). Multiply by dozens of dumps per
 * transmission and the useful signal is buried in coordinates nobody reads.
 *
 * So every per-tone array is reduced to statistics, repeated rows are collapsed,
 * and pure-noise events (failed sync probes) become a count. Field names go to
 * one or two characters, positionally ordered, with the meaning carried by the
 * format doc rather than repeated on every line.
 */

import { dlogFmt, type DlogRecord } from './dlog';

/** Cap on a fallback row for an unmapped tag — keeps one stray record from
 *  swamping a dump that is meant to be skim-readable. */
const UNMAPPED_LINE_MAX = 100;

/** Format version — bump when field order or codes change. */
export const LLM_DUMP_VERSION = 'v2';

// ── numeric helpers ─────────────────────────────────────────────────────────

/**
 * 3 significant figures, exponent only when the plain form would be longer.
 *
 * Integers stay plain up to 6 digits: frequencies are the most-read numbers in
 * the digest and `6.3e+3` for a 6300 Hz pilot is both longer to read and lossy
 * against the tone grid it has to be compared with.
 */
function n(value: number): string {
  if (!Number.isFinite(value)) return 'x';
  if (value === 0) return '0';
  if (Number.isInteger(value) && Math.abs(value) < 1000000) return String(value);
  const abs = Math.abs(value);
  if (abs >= 1000 || abs < 0.01) return value.toExponential(1);
  return String(Number(value.toPrecision(3)));
}

interface Stats {
  min: number;
  max: number;
  mean: number;
  spreadDb: number;
}

function stats(values: number[]): Stats | null {
  const usable = values.filter((v) => Number.isFinite(v) && v > 0);
  if (usable.length === 0) return null;
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  return { min, max, mean, spreadDb: 20 * Math.log10(max / min) };
}

/**
 * Stats over values already in dB.
 *
 * Separate from stats() because that one drops non-positive values — correct for
 * magnitudes, where zero means "no measurement", and wrong for dB, where a tone
 * at -3 dB MER is the most important number on the line. Dropping it would
 * report a failing run as healthier than it is.
 */
function dbStats(values: number[]): { min: number; max: number; mean: number } | null {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return null;
  return {
    min: Math.min(...usable),
    max: Math.max(...usable),
    mean: usable.reduce((a, b) => a + b, 0) / usable.length,
  };
}

/**
 * Least-squares fit of phase against tone index, after unwrapping.
 *
 * This replaces the single most-read-by-eye array in the whole log. A healthy
 * channel gives phase that is LINEAR in frequency (a delay), so what matters is
 * the slope and — much more diagnostically — the RMS residual around it. A
 * scattered residual means the estimate is broken; a small one means it is a
 * clean delay however steep. Reading that off 40 wrapped values by eye is slow
 * and error-prone, and it was the thing being eyeballed most often.
 */
export function phaseFit(degrees: number[]): { slope: number; resid: number } | null {
  if (degrees.length < 3) return null;
  const unwrapped: number[] = [degrees[0]];
  for (let i = 1; i < degrees.length; i++) {
    let d = degrees[i] - degrees[i - 1];
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    unwrapped.push(unwrapped[i - 1] + d);
  }
  const count = unwrapped.length;
  const meanX = (count - 1) / 2;
  const meanY = unwrapped.reduce((a, b) => a + b, 0) / count;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < count; i++) {
    sxy += (i - meanX) * (unwrapped[i] - meanY);
    sxx += (i - meanX) * (i - meanX);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  let sse = 0;
  for (let i = 0; i < count; i++) {
    const fit = meanY + slope * (i - meanX);
    sse += (unwrapped[i] - fit) ** 2;
  }
  return { slope, resid: Math.sqrt(sse / count) };
}

// ── parsers for the per-tone string formats dlog callers produce ────────────

/** "8.8e-2@-120 1.2e-1@-108 …" → magnitudes + phases in degrees. */
export function parseMagPhase(text: string): { mags: number[]; phases: number[] } {
  const mags: number[] = [];
  const phases: number[] = [];
  for (const tok of text.trim().split(/\s+/)) {
    const at = tok.lastIndexOf('@');
    if (at <= 0) continue;
    const mag = Number(tok.slice(0, at));
    const phase = Number(tok.slice(at + 1));
    if (Number.isFinite(mag) && Number.isFinite(phase)) {
      mags.push(mag);
      phases.push(phase);
    }
  }
  return { mags, phases };
}

/** "83,106;105,72;…" → per-tone (i,q) pairs. */
export function parseIQ(text: string): Array<{ i: number; q: number }> {
  const out: Array<{ i: number; q: number }> = [];
  for (const pair of text.split(';')) {
    const [i, q] = pair.split(',').map(Number);
    if (Number.isFinite(i) && Number.isFinite(q)) out.push({ i, q });
  }
  return out;
}

/** Delimited numbers ("98;94;91" or "22,21,20") → numbers. */
export function parseNums(text: string): number[] {
  return text
    .split(/[;,]/)
    .map(Number)
    .filter((v) => Number.isFinite(v));
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function asNum(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

// ── per-tag compression ─────────────────────────────────────────────────────

/**
 * Tags dropped wholesale, counted only. Empty by design right now: RX-SCAN was
 * here, and suppressing it hid the one fact that separates "the receiver never
 * saw a sentinel" from "it saw one and the frame failed" — see the RX-SCAN case,
 * which keeps the bit count instead.
 */
const NOISE_TAGS = new Set<string>();

/**
 * Returned for events deliberately not rendered. They are counted under
 * SUPPRESSED rather than UNMAPPED, so UNMAPPED means "the format has no rule for
 * this" — an actionable signal — rather than a permanent list of known noise.
 */
const DROP = '';

function compressOne(rec: DlogRecord): string | null {
  const f = rec.fields;
  const has = (key: string): boolean => f[key] !== undefined;

  switch (rec.tag) {
    case 'TX-OFDM': {
      // Band-handshake rows first — the card event also carries tones+pilot
      // and would otherwise be swallowed by the C-row rule below.
      if (has('bandCard')) {
        return `HC ${n(asNum(f.pilot))} ${n(asNum(f.toneStart))} ${asNum(f.tones)} ${asNum(f.settle)}`;
      }
      if (has('handshakePreambleMs')) return `HP ${asNum(f.handshakePreambleMs)}`;
      if (has('tones') && has('pilot')) {
        // Two different callers use `tones`: the tone LIST, and a plain COUNT on
        // the enable line. Treating a count as a one-element list read as
        // "t=1 lo=40 hi=40", which looks like a single-tone config — wrong in a
        // way that would send a reader after the wrong fault.
        const tones = f.tones;
        const list = Array.isArray(tones) ? tones.map(asString) : asString(tones).split(',');
        if (list.length === 1) return `C ${asNum(tones)} ${n(asNum(f.pilot))}`;
        return `C ${list.length} ${n(asNum(f.pilot))} ${list[0]} ${list[list.length - 1]}`;
      }
      if (has('chirp')) {
        return `Y ${asString(f.chirp)} ${n(asNum(f.amp))} ${n(asNum(f.symPeak))} ${n(asNum(f.symCoherentPeak))}`;
      }
      if (has('settleSymbols')) {
        return `Y2 ${asNum(f.trainingSymbols)} ${asNum(f.settleSymbols)} ${asNum(f.preambleMs)}`;
      }
      // Which frames were actually sent — the reference RX outcomes are read against.
      if (has('frame')) return `TF ${asString(f.frame)} ${asNum(f.seq)}`;
      return null;
    }

    case 'RX-OFDM': {
      // `sps` is SAMPLES per symbol, so HO bnd can be read against it directly.
      if (has('sps')) return `RC ${n(asNum(f.pilot))} ${asNum(f.sps)} ${asNum(f.tones)}`;
      if (has('toneCountChange')) return `!TCC ${asNum(f.from)}->${asNum(f.to)}`;
      if (has('badToneCount')) return `!TCB ${asNum(f.badToneCount)} ${asNum(f.using)}`;
      if (has('adaptingToneCount')) return `TCA ${asNum(f.newCount)}`;
      // Band handshake (card mode) — listen, card decode, hop, bad card.
      if (has('handshakeBand')) return `HL ${n(asNum(f.pilot))}`;
      if (has('card')) {
        return `HR ${n(asNum(f.pilot))} ${n(asNum(f.toneStart))} ${asNum(f.tones)} ${asNum(f.settle)}`;
      }
      if (has('cardHop')) return `HH ${n(asNum(f.pilot))} ${asNum(f.tones)} ${asNum(f.discard)}`;
      if (has('cardInvalid')) return '!HC';
      // The most informative failure on the whole ladder, and it was being
      // dropped: the header decoded (sentinel found, BCH and CRC-8 good) and
      // only the payload failed its own BCH/CRC. That is a link carrying the
      // waveform correctly and losing bits, not one that cannot hear.
      if (has('controlPayloadInvalid')) return '!CPAY';
      return null;
    }

    case 'TX-COMP':
      return has('wire') ? `CM ${asString(f.scheme)} ${asNum(f.raw)} ${asNum(f.wire)}` : null;

    case 'APP':
      return has('hwRate') ? `HW ${asNum(f.hwRate)}` : null;

    case 'OFDM-SCALE':
      return `SC ${n(asNum(f.requested))} ${n(asNum(f.clampedTo))}`;

    case 'OFDM-SYNC': {
      if (f.chirp === true) {
        return `SY ${n(asNum(f.norm))} ${n(asNum(f.peak))} ${asNum(f.idx)}`;
      }
      if (f.chirpHandoff === true) {
        return `HO ${asNum(f.boundary)} ${n(asNum(f.score))} ${asNum(f.trainingSamples)}`;
      }
      if (f.reject === true) {
        return `RJ ${n(asNum(f.score))} ${n(asNum(f.sharp))}`;
      }
      // ── why the chirp was not used, which is NOT inferable from its absence ──
      // A missing SY row has three very different causes and they were
      // indistinguishable: the correlator ran and scored low, the correlator
      // never ran because the receiver was still in FRAMES (the watchdog holds
      // that state for ~15 s and only a CRC-valid frame clears it), or the probe
      // window expired. Each points somewhere else entirely.
      if (f.watchdogReset === true) return `!WD ${asNum(f.windows)}`;
      if (f.chirpProbeTimeout === true) return `!CPT`;
      if (f.detected === true) return `!ES`;
      if (has('boundary')) return `EB ${asNum(f.boundary)}`;
      // chirpMiss: the correlator DID run and scored low. Counted, not rendered —
      // it fires once per attempt while correlation ramps.
      return DROP;
    }

    case 'TX-FRAME':
      return DROP;

    case 'RX': {
      // The PLL's pilot must match the TX pilot; a mismatch is silent and fatal.
      if (has('pllPilot')) return `PP ${n(asNum(f.pllPilot))}`;
      return DROP;
    }

    case 'OFDM-TRAIN': {
      if (has('h')) {
        const { mags, phases } = parseMagPhase(asString(f.h));
        const st = stats(mags);
        const fit = phaseFit(phases);
        if (!st) return null;
        return `TR ${n(asNum(f.pilotAmp))} ${n(st.min)} ${n(st.max)} ${n(st.spreadDb)}`
          + (fit ? ` ${n(fit.slope)} ${n(fit.resid)}` : ' - -');
      }
      if (has('settled')) return `ST ${asNum(f.settled)}`;
      return DROP;
    }

    case 'OFDM-DEMOD': {
      if (has('firstSym')) {
        // Not the per-tone list — how many DISTINCT decisions it contains. A
        // healthy data symbol spreads across the constellation; a symbol that is
        // really still training, or is being read at the wrong boundary, collapses
        // onto one or two decisions. That distinction is the whole diagnostic
        // value of the list and is invisible in a count of suppressed events.
        const decisions = asString(f.firstSym)
          .split(/\s+/)
          .map((tok) => tok.split('/')[1])
          .filter((d) => d !== undefined);
        const distinct = new Set(decisions).size;
        return `FS ${decisions.length} ${distinct}`
          + (has('pilotAmp') ? ` ${n(asNum(f.pilotAmp))}` : ' -');
      }
      if (has('pilotAmp') && has('tones')) return `DA ${n(asNum(f.pilotAmp))}`;
      // Entering the data phase with an empty buffer vs a full one distinguishes
      // "no data arrived" from "data arrived and decoded wrong".
      if (has('enteringDataPhase')) {
        return `DP ${asNum(f.bufLenAtEntry)} ${asNum(f.samplesSeen)}`;
      }
      return DROP;
    }

    case 'QPSKD':
      return has('drift') ? `DR ${asNum(f.drift)}` : null;

    case 'QAMCAL': {
      if (has('k')) {
        const st = stats(parseNums(asString(f.k)));
        return st ? `KC ${n(st.min)} ${n(st.mean)} ${n(st.max)}` : null;
      }
      if (has('clamp')) {
        const clamped = asString(f.clamp);
        return `KL ${clamped ? clamped.split(',').length : 0}`;
      }
      return null;
    }

    case 'QAMD': {
      // The biggest volume saving in the whole format: the 40 coordinate pairs
      // become three numbers, because that is what was ever read off them.
      if (!has('p')) return null;
      const pts = parseIQ(asString(f.p));
      const mags = pts.map((pt) => Math.hypot(pt.i, pt.q));
      const st = stats(mags);
      const sd = asString(f.sd);
      return `QD ${asNum(f.n)} ${n(asNum(f.g))} ${sd}`
        + (st ? ` ${n(st.mean)} ${n(st.spreadDb)}` : ' - -');
    }

    case 'OFDM-GAIN':
      return `GN ${n(asNum(f.g))}`;

    case 'OFDM-MER': {
      return `ME ${n(asNum(f.merDb))} ${n(asNum(f.evmPct))} ${asString(f.verdict)}`;
    }

    case 'OFDM-TMER': {
      const st = dbStats(parseNums(asString(f.db)));
      return st ? `TM ${n(st.min)} ${n(st.mean)} ${n(st.max)}` : null;
    }

    case 'OFDM-STMER': {
      // Per-tone MER of a FAILED frame. The spread is the whole point: flat means
      // level or common phase error (pre-emphasis will not help), spread means the
      // channel (pre-emphasis will). Both ends are kept, not just the spread, so
      // a uniformly-bad run is distinguishable from a tilted one.
      const values = parseNums(asString(f.db));
      const st = dbStats(values);
      if (!st) return null;
      return `SM ${n(st.min)} ${n(st.mean)} ${n(st.max)} ${n(st.max - st.min)}`;
    }

    case 'RX-FRAME': {
      if (has('ok')) {
        // `pa` is the PLL's leaky mean |sample| — a WIDEBAND input level, not the
        // pilot's amplitude (see pilot.ts update()). Renamed here because reading
        // it as a pilot level invites comparing it with `TR pA`/`DA pA`, which
        // measure a different quantity and diverge for reasons that are not faults.
        return `F ${f.ok === true ? 1 : 0} ${asString(f.t)} ${asNum(f.s)}`
          + ` ${n(asNum(f.mer))} ${n(asNum(f.pa))}`;
      }
      if (has('tail')) return `FT ${asNum(f.assembled)} ${asNum(f.size)}`;
      if (has('decompressError')) return `!DEC ${asString(f.decompressError)}`;
      if (has('dupHeader')) return DROP;
      return null;
    }

    case 'RX-SCAN': {
      // Sentinel hits are the load-bearing fact — one row each. The bit-count
      // heartbeat is the negative evidence (bits scanned, nothing found), so it
      // collapses to its running total via the row-repeat mechanism.
      if (has('frame')) return `SH ${asNum(f.frame)}`;
      if (has('bits')) return `SCAN ${asNum(f.bits)}`;
      return DROP;
    }

    case 'RX-COMP':
      return `RM ${asString(f.scheme)} ${asNum(f.wire)} ${asNum(f.decompressed)}`;

    case 'OFDM-CONFIG':
      return has('restart') ? `CFG restart` : null;

    case 'CONFIG':
      // Bin-grid snapping. Worth a row: a snapped pilot or tone start moves the
      // whole tone set, so a configuration read off the UI is not what went out.
      return has('note') ? `SNAP ${asString(f.note)} ${n(asNum(f.from))} ${n(asNum(f.to))}` : null;

    case 'RX-FAIL': {
      // Fixed arity with '-' for absent fields: positional rows cannot omit a
      // column without shifting every later one.
      return [
        'X',
        asString(f.r),
        has('t') ? asString(f.t) : '-',
        has('bch') ? asString(f.bch) : '-',
        has('rs') ? asString(f.rs) : '-',
        has('smer') ? n(asNum(f.smer)) : '-',
      ].join(' ');
    }

    case 'RX-PROFILE': {
      if (has('ord')) {
        const orders = parseNums(asString(f.ord));
        const distinct = [...new Set(orders)];
        return `PR ${orders.length} ${distinct.join('/')}`;
      }
      return DROP;
    }

    case 'PLAY': {
      if (has('peak') && has('vol')) return `PL ${n(asNum(f.peak))} ${asString(f.vol)}`;
      // The playback path rescaling or clipping a chunk breaks the fixed TX scale
      // the whole modem depends on, so neither may be silent.
      if (has('autoNorm')) return `!PLNORM ${n(asNum(f.autoNorm))} ${n(asNum(f.peak))}`;
      if (has('clipped')) return `!PLCLIP ${asNum(f.clipped)}`;
      if (has('setSinkIdFailed')) return `!SINK ${asString(f.setSinkIdFailed)}`;
      return DROP;
    }

    case 'PLAYER':
      return has('clipClamped') ? `!CLIP ${asNum(f.clipClamped)} ${n(asNum(f.peak))}` : null;

    // A control message that decoded end to end — the success case the whole
    // ladder builds toward, and the one that says who is actually reachable.
    case 'CHATTER-RX':
      return `CRX ${asString(f.decoded)} from=${asNum(f.from)} to=${asNum(f.to)} ${asNum(f.bytes)}B`;

    // What the operator did, and when. Without it a dump shows the radio
    // reacting to nothing, and a protocol that never started is
    // indistinguishable from one that started and failed.
    case 'UI': {
      if (has('pressed')) return `>${asString(f.pressed)}${has('target') ? ` ${asNum(f.target)}` : ''}`;
      if (has('action')) return `>${asString(f.action)}`;
      if (has('fileChosen')) return `>file ${asString(f.fileChosen)} ${asNum(f.bytes)}B to=${asString(f.to)}`;
      if (has('fileEvent')) return `>route ${asString(f.route)} ${asNum(f.bytes)}B to=${asString(f.to)}`;
      if (has('fileRejected')) return `!>file ${asString(f.fileRejected)}`;
      return DROP;
    }

    // What the browser ACTUALLY granted for capture. The whole reason this
    // exists is mobile: those stacks routinely apply AGC/noise suppression
    // despite being asked not to, and either one explains a link whose
    // preamble decodes while every payload dies.
    case 'REC-CAP':
      return `CAP agc=${asString(f.agc)} ns=${asString(f.ns)} aec=${asString(f.aec)}`
        + ` rate=${asString(f.rate)} ch=${asString(f.ch)}`;

    // Room protocol decisions — without these a dump shows the radio's view
    // and none of the reasoning on top of it.
    case 'ROOM': {
      if (has('rollCallDone')) {
        // `us` matters as much as the rest: a peer addresses its reply to the
        // id it decoded from our probe's pulse trailer, and that trailer is
        // guarded by only a 4-bit CRC. If it mis-decodes, every reply is
        // addressed to a device that isn't here and gets dropped — which
        // looks exactly like nobody answering. Without our own id printed
        // there is nothing to compare the drops against.
        return `RCALL us=${asNum(f.us)} n=${asNum(f.reports)} from=${asString(f.from)}`
          + ` known=${asString(f.knownMembers)}`;
      }
      if (has('probeFrom')) {
        return `PRB ${asNum(f.probeFrom)} mean=${asString(f.meanDb)} hs=${asString(f.handshakeBandDb)}`;
      }
      if (has('droppedWelcome')) return `!DW from=${asNum(f.from)} to=${asNum(f.to)} us=${asNum(f.us)}`;
      if (has('droppedReport')) return `!DR from=${asNum(f.from)} to=${asNum(f.to)} us=${asNum(f.us)}`;
      if (has('fileComingForOther')) return `FC-OTHER to=${asNum(f.to)} us=${asNum(f.us)}`;
      return DROP;
    }

    case 'REC': {
      if (has('label')) return `MIC ${asString(f.label)}`;
      if (has('deviceFallback')) return `!MIC-DEFAULT`;
      if (has('deviceUnresolved')) return `!MIC-UNRESOLVED`;
      // Capture rate vs hardware rate (HW): a mismatch means resampling, which
      // moves every tone off its bin.
      if (has('ctxRate')) return `RS ${asNum(f.ctxRate)} ${asString(f.ctxState)} ${asNum(f.gain)}`;
      if (has('running')) {
        return `RG ${asNum(f.gain) || '-'} ${has('outRate') ? asNum(f.outRate) : '-'}`
          + ` ${has('ratio') ? n(asNum(f.ratio)) : '-'}`;
      }
      return DROP;
    }

    case 'CAL': {
      if (has('done')) {
        return `CAL ${n(asNum(f.beforeSpreadDb))} ${n(asNum(f.afterSpreadDb))} ${asString(f.stored)}`;
      }
      if (f.failed === true) return `!CALFAIL ${asString(f.stage ?? f.round)}`;
      if (has('error')) return `!CALERR ${asString(f.error)}`;
      if (has('key')) return `CALSTART ${asNum(f.tones)} ${asString(f.key)}`;
      return DROP;
    }

    case 'CAL-GAIN-DB': {
      // The gains themselves, as a spread: a calibration is only trustworthy if
      // the boosts it asks for are inside what the TX can deliver without
      // eating the whole peak budget.
      const st = dbStats(parseNums(asString(f.db)));
      return st ? `CG ${n(st.min)} ${n(st.max)}` : null;
    }

    case 'CAL-ROUND':
      return `CR ${asString(f.stage ?? f.round)} ${n(asNum(f.spreadDb))}`;

    case 'DIAG-LINEARITY':
      return `LIN ${n(asNum(f.maxDevDb))} ${asString(f.note)}`;

    case 'DIAG-IMD':
      return `IMD ${n(asNum(f.offSlotDb))} ${n(asNum(f.noiseSlotDb))} ${asString(f.note)}`;

    default:
      return null;
  }
}

/**
 * Row codes whose consecutive rows collapse when every numeric field is within
 * FOLD_TOLERANCE, not just when they are byte-identical.
 *
 * These are per-symbol series: a transmission emits dozens of QD rows whose gain
 * and dispersion drift by a percent at a time, so exact-duplicate collapse never
 * fires and they dominated the digest — 40 of 97 rows in a measured session, for
 * information a single row plus a count carries. Only codes where the TREND is
 * the content belong here; anything where an individual row is an event (frames,
 * failures, sync decisions) must never fold.
 */
const FOLDABLE = new Set(['QD', 'SCAN', 'TM', 'SM', 'GN', 'KC']);

/**
 * Columns to ignore when deciding whether two rows of a code are near-duplicates,
 * 1-based within the row.
 *
 * These are monotonic counters, not measurements: QD's symbol index and SCAN's
 * cumulative bit count rise without bound, so comparing them by fractional
 * difference blocks every fold (symbol 1 vs 2 differs by 100%). The counter of
 * the LAST row in a run still survives into the output, which is what tells a
 * reader where the run ended.
 */
const FOLD_IGNORE_COLUMNS: Record<string, number[]> = {
  QD: [1],
  SCAN: [1],
};

/** Fractional difference below which two numeric fields count as the same. */
const FOLD_TOLERANCE = 0.1;

/**
 * Whether `row` is a near-duplicate of `prev` — same code, same arity, and every
 * numeric field within FOLD_TOLERANCE. Non-numeric fields must match exactly, so
 * a changed verdict or frame type always breaks the run.
 */
function foldsInto(prev: string | undefined, row: string): boolean {
  if (!prev) return false;
  const a = prev.split(' ');
  const b = row.split(' ');
  if (a[0] !== b[0] || a.length !== b.length) return false;
  if (!FOLDABLE.has(a[0])) return false;
  const ignore = FOLD_IGNORE_COLUMNS[a[0]] ?? [];
  for (let i = 1; i < a.length; i++) {
    if (ignore.includes(i)) continue;
    if (a[i] === b[i]) continue;
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const scale = Math.max(Math.abs(x), Math.abs(y));
    if (scale === 0) return false;
    if (Math.abs(x - y) / scale > FOLD_TOLERANCE) return false;
  }
  return true;
}

/**
 * Render a session digest. Consecutive identical rows collapse to `row xN`,
 * near-identical rows of a series code to `row ~N` (see FOLDABLE), and
 * suppressed-tag counts are reported once at the end so nothing disappears
 * silently.
 */
export function compressRecords(recs: DlogRecord[]): string {
  const rows: string[] = [];
  const suppressed = new Map<string, number>();
  /**
   * Events no rule matched. Reported as counts rather than dropped: an empty
   * digest is indistinguishable from a silent session, and that is exactly how
   * the missing worker records went unnoticed.
   */
  const unmapped = new Map<string, number>();

  for (const rec of recs) {
    if (NOISE_TAGS.has(rec.tag)) {
      suppressed.set(rec.tag, (suppressed.get(rec.tag) ?? 0) + 1);
      continue;
    }
    // OFDM-MISS is the current tag; OFDM-SYNC is accepted so dumps captured
    // before the split still tally correctly.
    if ((rec.tag === 'OFDM-MISS' || rec.tag === 'OFDM-SYNC') && rec.fields.chirpMiss === true) {
      suppressed.set('chirpMiss', (suppressed.get('chirpMiss') ?? 0) + 1);
      continue;
    }
    const row = compressOne(rec);
    if (row === null) {
      // Still render it. An unmapped tag used to be counted and its contents
      // thrown away, which has now hidden decisive evidence three separate
      // times during one investigation — capture settings, room decisions,
      // and a control payload failure — each time costing a debugging round
      // trip on hardware that is not on this desk. A tag with no case is a
      // gap in this file, not permission to discard the data, so fall back to
      // a generic rendering and keep the count for visibility.
      unmapped.set(rec.tag, (unmapped.get(rec.tag) ?? 0) + 1);
      const pairs = Object.entries(rec.fields)
        .map(([k, v]) => `${k}=${dlogFmt(v)}`)
        .join(' ');
      rows.push(`?${rec.tag} ${pairs}`.slice(0, UNMAPPED_LINE_MAX));
      continue;
    }
    if (row === DROP) {
      suppressed.set(rec.tag, (suppressed.get(rec.tag) ?? 0) + 1);
      continue;
    }

    const last = rows[rows.length - 1];
    // Strip BOTH count suffixes: a run that has already collapsed once must still
    // be matchable, or a long series alternates folded/unfolded rows forever.
    const lastBase = last?.replace(/ [x~]\d+$/, '');
    if (lastBase === row) {
      const m = last.match(/ x(\d+)$/);
      rows[rows.length - 1] = `${row} x${m ? Number(m[1]) + 1 : 2}`;
      continue;
    }
    if (foldsInto(lastBase, row)) {
      // Near-duplicate of the row above: replace it, so the run collapses to its
      // LATEST values plus a count. The latest is kept rather than the first
      // because these series drift, and the current value is what a reader wants.
      const m = last.match(/ ~(\d+)$/);
      rows[rows.length - 1] = `${row} ~${m ? Number(m[1]) + 1 : 2}`;
      continue;
    }
    rows.push(row);
  }

  const tail = [...suppressed.entries()].map(([tag, count]) => `${tag}=${count}`);
  const other = [...unmapped.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => `${tag}=${count}`);
  return [
    `${LLM_DUMP_VERSION} fmt=docs/dump-format.md rows=${rows.length}`,
    ...rows,
    tail.length ? `SUPPRESSED ${tail.join(' ')}` : '',
    other.length ? `UNMAPPED ${other.join(' ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

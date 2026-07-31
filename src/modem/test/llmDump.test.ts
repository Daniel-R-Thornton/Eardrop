/**
 * llmDump.test.ts — the compressed digest must not misreport.
 *
 * This output is read as fact when diagnosing, so a summary that is subtly wrong
 * is worse than no summary: it produces confident conclusions about hardware
 * from a bug in the formatter. The aggregations (spread, phase fit) and the
 * lossless properties (nothing silently dropped) are pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  compressRecords,
  phaseFit,
  parseMagPhase,
  parseIQ,
  parseNums,
} from '../../lib/debug/llmDump';
import type { DlogRecord } from '../../lib/debug/dlog';

const rec = (tag: string, fields: Record<string, unknown>): DlogRecord => ({ tag, fields });

describe('parsers', () => {
  it('parses mag@phase pairs as the training log emits them', () => {
    const { mags, phases } = parseMagPhase('8.8e-2@-120 1.2e-1@-108 1.5e-1@-114');
    expect(mags).toEqual([0.088, 0.12, 0.15]);
    expect(phases).toEqual([-120, -108, -114]);
  });

  it('parses negative phases without mistaking the minus for a separator', () => {
    // '@' is found with lastIndexOf precisely so a negative exponent in the
    // magnitude cannot be confused with the phase delimiter.
    const { mags, phases } = parseMagPhase('1.0e-2@-179');
    expect(mags).toEqual([0.01]);
    expect(phases).toEqual([-179]);
  });

  it('parses i,q pairs and delimited numbers', () => {
    expect(parseIQ('83,106;105,72')).toEqual([{ i: 83, q: 106 }, { i: 105, q: 72 }]);
    expect(parseNums('98;94;91')).toEqual([98, 94, 91]);
    expect(parseNums('22,21,20')).toEqual([22, 21, 20]);
  });
});

describe('phase fit', () => {
  it('reports a clean ramp as near-zero residual', () => {
    // A pure delay gives phase linear in tone index — the healthy case.
    const degrees = Array.from({ length: 40 }, (_u, t) => -5 * t);
    const fit = phaseFit(degrees)!;
    expect(fit.slope).toBeCloseTo(-5, 3);
    expect(fit.resid).toBeLessThan(0.01);
  });

  it('unwraps across the +/-180 boundary', () => {
    // Wrapped input must not read as scattered: this is exactly what the raw log
    // looks like, and treating a wrap as noise would invert the conclusion.
    const degrees = Array.from({ length: 40 }, (_u, t) => {
      let d = 170 - 10 * t;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      return d;
    });
    const fit = phaseFit(degrees)!;
    expect(fit.slope).toBeCloseTo(-10, 1);
    expect(fit.resid).toBeLessThan(1);
  });

  it('reports scattered phase as a large residual', () => {
    const degrees = [-43, -28, 178, -156, -166, -112, -49, -114, -133, -74, -22, 38];
    const fit = phaseFit(degrees)!;
    expect(fit.resid).toBeGreaterThan(30);
  });

  it('returns null for too few points', () => {
    expect(phaseFit([10, 20])).toBeNull();
  });
});

describe('compression', () => {
  it('reduces a 40-tone constellation dump to a few numbers', () => {
    const pts = Array.from({ length: 40 }, (_u, t) => `${80 + t},${90 - t}`).join(';');
    const out = compressRecords([rec('QAMD', { n: 5, g: 0.89, sd: '64,73', p: pts })]);
    expect(out).toMatch(/QD 5 0\.89 64,73 /);
    // The whole point: the coordinates must not survive into the digest.
    expect(out).not.toContain('80,90');
    expect(out.length).toBeLessThan(120);
  });

  it('summarises training as spread plus phase fit', () => {
    const h = Array.from({ length: 40 }, (_u, t) => `${(0.1 + t * 0.002).toExponential(1)}@${-5 * t}`).join(' ');
    const out = compressRecords([rec('OFDM-TRAIN', { symbols: 12, pilotAmp: 0.188, h })]);
    expect(out).toMatch(/^TR 0\.188 /m);
    // TR is: pilotAmp hMin hMax hSpr phSlope phResid — six values, all present.
    const trRow = out.split('\n').find((l) => l.startsWith('TR '))!;
    expect(trRow.split(' ')).toHaveLength(7);
    expect(trRow.split(' ').every((v) => v !== '-')).toBe(true);
  });

  it('collapses consecutive identical rows with a count', () => {
    const out = compressRecords([
      rec('OFDM-GAIN', { g: 2 }),
      rec('OFDM-GAIN', { g: 2 }),
      rec('OFDM-GAIN', { g: 2 }),
    ]);
    expect(out).toContain('GN 2 x3');
  });

  it('folds a drifting series but breaks the run when a value really moves', () => {
    // The saving that matters: a transmission emits dozens of QD rows drifting a
    // percent at a time. They must collapse — but a real step must NOT be folded
    // away, or the digest hides the event it exists to show.
    const pts = Array.from({ length: 32 }, (_u, t) => `${80 + t},${90 - t}`).join(';');
    const drifting = compressRecords([
      rec('QAMD', { n: 1, g: 0.71, sd: '58,60', p: pts }),
      rec('QAMD', { n: 2, g: 0.72, sd: '58,60', p: pts }),
      rec('QAMD', { n: 3, g: 0.7, sd: '58,60', p: pts }),
    ]);
    // Collapsed to the LAST row of the run, tagged with the count.
    expect(drifting).toContain('QD 3 0.7 58,60');
    expect(drifting).toContain('~3');
    expect(drifting.split('\n').filter((l) => l.startsWith('QD '))).toHaveLength(1);

    const stepped = compressRecords([
      rec('QAMD', { n: 1, g: 0.71, sd: '58,60', p: pts }),
      rec('QAMD', { n: 2, g: 2.0, sd: '58,60', p: pts }),
    ]);
    expect(stepped.split('\n').filter((l) => l.startsWith('QD '))).toHaveLength(2);
  });

  it('never folds event rows, however similar', () => {
    // Two frames failing identically are two failures, not one repeated
    // measurement — folding them would understate the damage.
    const out = compressRecords([
      rec('RX-FRAME', { ok: false, t: '0x1', s: 0, mer: 12.3, pa: 0.98 }),
      rec('RX-FRAME', { ok: false, t: '0x1', s: 0, mer: 12.4, pa: 0.98 }),
    ]);
    expect(out).not.toContain('~');
    expect(out.split('\n').filter((l) => l.startsWith('F '))).toHaveLength(2);
  });

  it('counts suppressed noise instead of dropping it silently', () => {
    // A reader must be able to tell "no failed probes" from "probes hidden".
    const out = compressRecords([
      rec('OFDM-SYNC', { chirpMiss: true, norm: 0.004 }),
      rec('OFDM-SYNC', { chirpMiss: true, norm: 0.005 }),
      rec('OFDM-SYNC', { chirp: true, norm: 0.573, peak: 11300, idx: 298 }),
    ]);
    expect(out).toContain('SY 0.573');
    expect(out).toMatch(/SUPPRESSED .*chirpMiss=2/);
  });

  it('keeps sentinel hits and the scanned-nothing heartbeat apart', () => {
    // "Never found a frame" and "found one that failed" are different faults,
    // and collapsing the scanner to a count made them indistinguishable.
    const out = compressRecords([
      rec('RX-SCAN', { bits: 8000, sr: '0x55' }),
      rec('RX-SCAN', { bits: 16000, sr: '0x77' }),
      rec('RX-SCAN', { frame: 232 }),
    ]);
    // The two SCAN heartbeats fold (the bit counter is excluded from the
    // comparison), leaving the latest plus a count; the sentinel hit stands alone.
    expect(out).toContain('SCAN 16000 ~2');
    expect(out).toContain('SH 232');
  });

  it('summarises the first data symbol by how many decisions it spans', () => {
    // A symbol collapsed onto one decision is training read as data; the per-tone
    // phase list is not needed to see that, only the distinct count.
    const collapsed = Array.from({ length: 32 }, (_u, t) => `t${t}:2°/0`).join(' ');
    const out = compressRecords([rec('OFDM-DEMOD', { firstSym: collapsed, pilotAmp: 0.19, tones: 32 })]);
    expect(out).toContain('FS 32 1 0.19');
  });

  it('flags clipping and unresolved mics prominently', () => {
    const out = compressRecords([
      rec('PLAYER', { clipClamped: 42, peak: 1.19, of: 4096 }),
      rec('REC', { deviceUnresolved: true, storedLabel: 'x' }),
    ]);
    expect(out).toContain('!CLIP 42');
    expect(out).toContain('!MIC-UNRESOLVED');
  });

  it('keeps frame outcomes and failure detail verbatim enough to diagnose', () => {
    const out = compressRecords([
      rec('RX-FRAME', { ok: true, t: '0x4', s: 0, mer: 15.2, pa: 0.192 }),
      rec('RX-FAIL', { r: 'rs', t: '0x1', s: 0, bch: '2,0,0', rs: '0,0,0,1', smer: 11 }),
    ]);
    expect(out).toContain('F 1 0x4 0 15.2 0.192');
    expect(out).toContain('X rs 0x1 2,0,0 0,0,0,1 11');
  });

  it('keeps frequencies readable and does not read a tone COUNT as a tone list', () => {
    // Both callers use `tones`: a list on the config line, a count on the enable
    // line. The count must not render as a single-tone config.
    const list = Array.from({ length: 40 }, (_u, t) => (6900 + t * 50).toFixed(1)).join(',');
    const out = compressRecords([
      rec('TX-OFDM', { enabled: true, tones: 40, pilot: 6300 }),
      rec('TX-OFDM', { pilot: 6300, tones: list }),
    ]);
    expect(out).toContain('C 40 6300\n');
    expect(out).toContain('C 40 6300 6900.0 8850.0');
    expect(out).not.toContain('6.3e+3');
    expect(out).not.toContain('C 1 ');
  });

  it('reports events it has no rule for instead of dropping them', () => {
    // The failure this guards against: a digest that looks like a quiet session
    // when in fact the events never reached the formatter.
    const out = compressRecords([
      rec('APP', { hwRate: 48000 }),
      rec('SOMETHING-NEW', { a: 1 }),
      rec('SOMETHING-NEW', { a: 2 }),
      rec('TX-OFDM', { frame: '0x4', seq: 0 }),
    ]);
    expect(out).toContain('HW 48000');
    expect(out).toContain('TF 0x4 0');
    expect(out).toMatch(/UNMAPPED SOMETHING-NEW=2/);
    expect(out).toContain('rows=2');
  });

  it('emits a version and format pointer so a reader can decode it', () => {
    expect(compressRecords([])).toContain('fmt=docs/dump-format.md');
  });

  it('is dramatically smaller than the raw lines it replaces', () => {
    // The reason this exists. A session with per-tone dumps must compress by a
    // large factor or the exercise is pointless.
    const pts = Array.from({ length: 40 }, (_u, t) => `${80 + t},${90 - t}`).join(';');
    const recs: DlogRecord[] = [];
    for (let i = 0; i < 20; i++) {
      recs.push(rec('QAMD', { n: i, g: 1 + i * 0.01, sd: '60,60', p: pts }));
    }
    const rawSize = recs.reduce((a, r) => a + JSON.stringify(r.fields).length, 0);
    const out = compressRecords(recs);
    expect(out.length).toBeLessThan(rawSize / 5);
  });
});

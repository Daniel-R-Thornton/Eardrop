/**
 * dumpReplay.test.ts — Batch replay JSON dumps through decoder.
 *
 * Replays all eardrop-dump-*.json files from ~/Downloads and reports
 * blocks decoded, CRC failures, and any recovered data for each.
 *
 * Usage:
 *   vitest run src/modem/dumpReplay.test.ts
 */

import { describe, it, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { Decoder } from '../protocol/decoder';

interface DumpFile {
  timestamp: number;
  sampleRate: number;
  recvSamples: number[];
  pilotFreqHz?: number;
  ampThresholdRatio?: number;
  txSamples?: number[] | null;
  decoder?: {
    pilotFreq: number;
    inFrame: boolean;
    snr: number;
    energies: number[];
    noiseFloor: number[];
  };
}

function findDumps(): string[] {
  const dir = path.join(process.env.HOME || '/home', 'Downloads');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('eardrop-dump-') && f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

function analyzeSignal(samples: number[]): string {
  if (samples.length === 0) return 'empty';
  let peak = 0,
    sumSq = 0;
  const n = Math.min(samples.length, 4000);
  for (let i = 0; i < n; i++) {
    const v = Math.abs(samples[i]);
    if (v > peak) peak = v;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / n);
  const rmsDb = rms > 0.0001 ? 20 * Math.log10(rms) : -80;
  return `peak=${peak.toExponential(2)} rms=${rmsDb.toFixed(1)}dB`;
}

describe('Dump Replay (Batch)', () => {
  const dumps = findDumps();

  if (dumps.length === 0) {
    it.skip('no dumps found in ~/Downloads', () => {});
    return;
  }

  beforeAll(() => {
    console.log(`Found ${dumps.length} dumps in ~/Downloads`);
  });

  // Replay each dump
  for (const dumpPath of dumps) {
    const name = path.basename(dumpPath, '.json');

    it(name, () => {
      const raw = fs.readFileSync(dumpPath, 'utf-8');
      const dump = JSON.parse(raw) as DumpFile;
      const pilotFreq = dump.pilotFreqHz || dump.decoder?.pilotFreq || 412.5;

      console.log(`  file: ${name}`);
      console.log(`  samples: ${dump.recvSamples.length} @ ${dump.sampleRate}Hz`);
      console.log(`  mic: ${analyzeSignal(dump.recvSamples)}`);
      console.log(`  pilotFreq: ${pilotFreq} Hz`);

      const decoder = new Decoder({ pilotFreqHz: pilotFreq });
      decoder.fastSync = true;
      decoder.logging = false;
      decoder.reset();

      const blocks: Array<{ type: number; len: number }> = [];
      decoder.framedDecoder.onBlock = (event) => {
        blocks.push({ type: event.type, len: event.data.length });
      };

      const t0 = performance.now();
      for (let i = 0; i < dump.recvSamples.length; i++) {
        decoder.feedSample(dump.recvSamples[i]);
      }
      decoder.flush();
      const elapsed = performance.now() - t0;

      console.log(
        `  decoded: ${blocks.length} blocks, ${decoder.framedDecoder.blocksCrcFailed} CRC fails`,
      );
      console.log(`  time: ${elapsed.toFixed(0)}ms`);

      const typeNames: Record<number, string> = {
        1: 'SQWK',
        2: 'CONF',
        3: 'DICT',
        4: 'PAYD',
        255: 'EOF',
      };
      for (const b of blocks) {
        console.log(`    |${typeNames[b.type] || '?'}|${b.len}B`);
      }
    });
  }
});

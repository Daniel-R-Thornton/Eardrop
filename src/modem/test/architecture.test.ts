/**
 * Architecture guardrails — cheap greps that fail the suite if someone
 * reintroduces per-sample worker messaging or inline modem configs.
 */
import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');

test('no per-sample postMessage anywhere in src/', () => {
  const appTs = readFileSync(join(SRC, 'ui', 'app.ts'), 'utf8');
  expect(appTs.includes("type: 'feedSample'")).toBe(false);
});

test('app.ts builds modem configs only via buildModemConfig', () => {
  const appTs = readFileSync(join(SRC, 'ui', 'app.ts'), 'utf8');
  // The bug pattern: an inline object literal passing pilotFreqHz straight
  // from getState() into a worker/engine config (NOT inside buildModemConfig).
  // Lines inside buildModemConfig({...}) are correct — that's the ONE function.
  const inlineConfigs = appTs.match(/(?<!buildModemConfig\()\{.*pilotFreqHz:\s*getState\(\)/g) ?? [];
  expect(inlineConfigs.length).toBe(0);
});

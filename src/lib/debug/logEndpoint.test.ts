import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Node context test (no jsdom needed): the handler is plain Node code.
import { handleLogRequest } from '../../../scripts/log-endpoint.mjs';

let server: http.Server;
let base: string;
let rootDir: string;

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'eardrop-log-'));
  server = http.createServer((req, res) => {
    void handleLogRequest(req, res, { rootDir }).then((handled) => {
      if (!handled) { res.statusCode = 404; res.end(); }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: unknown) => fetch(`${base}/api/log`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

/** Log files written so far, as paths relative to rootDir. */
const written = async (): Promise<string[]> => {
  const all = await readdir(rootDir, { recursive: true });
  return all.filter((f) => f.endsWith('.log')).sort();
};

/** The single log file whose name ends with `<device>-<session>.log`. */
const fileFor = async (device: string, session: string): Promise<string> => {
  const hits = (await written()).filter((f) => f.endsWith(`-${device}-${session}.log`));
  expect(hits, `exactly one file for ${device}-${session}`).toHaveLength(1);
  return hits[0];
};

describe('log endpoint', () => {
  it('answers the GET probe with 204', async () => {
    expect((await fetch(`${base}/api/log`)).status).toBe(204);
  });

  it('appends rows across POSTs to one file per device+session', async () => {
    expect((await post({ device: 'ph1', session: 'abc', rows: ['row one'] })).status).toBe(204);
    expect((await post({ device: 'ph1', session: 'abc', rows: ['row two'] })).status).toBe(204);
    const text = await readFile(join(rootDir, await fileFor('ph1', 'abc')), 'utf8');
    expect(text).toBe('row one\nrow two\n');
  });

  /**
   * The reporter pushes incrementally every 5 s, so the timestamp in the name
   * has to be fixed when the session is first seen. Recomputed per request it
   * would send each push to a new filename and shatter one session across
   * dozens of near-empty files — which is the failure this guards.
   */
  it('keeps one session in one file even as the clock moves', async () => {
    expect((await post({ device: 'ph2', session: 'sess', rows: ['a'] })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 1100)); // past a whole second
    expect((await post({ device: 'ph2', session: 'sess', rows: ['b'] })).status).toBe(204);

    const text = await readFile(join(rootDir, await fileFor('ph2', 'sess')), 'utf8');
    expect(text).toBe('a\nb\n');
  });

  /**
   * The name has to identify the run on its own — which device, and when —
   * because `dev-<random>-<random>.log` identified neither, and a directory of
   * them could not say which files came from the same phone.
   */
  it('names the file <date>T<time>-<device>-<session>.log', async () => {
    expect((await post({ device: 'chrome-android-k3n8', session: 'zz11', rows: ['x'] })).status).toBe(204);
    const rel = await fileFor('chrome-android-k3n8', 'zz11');
    const date = new Date().toISOString().slice(0, 10);
    // Directory and filename both carry the date, and they must agree — the
    // whole reason the stamp is taken server-side rather than on the client.
    expect(rel).toMatch(
      new RegExp(`^logs[/\\\\]${date}[/\\\\]${date}T\\d{6}-chrome-android-k3n8-zz11\\.log$`),
    );
  });

  it('sanitizes device/session so a request cannot escape logs/', async () => {
    expect((await post({ device: '../../evil', session: 'a/b', rows: ['x'] })).status).toBe(204);
    const rel = await fileFor('evil', 'ab');
    const date = new Date().toISOString().slice(0, 10);
    expect(rel.startsWith(join('logs', date))).toBe(true);
    expect(rel).not.toContain('..');
    expect(await readFile(join(rootDir, rel), 'utf8')).toBe('x\n');
  });

  it('rejects malformed JSON with 400 and other methods with 405', async () => {
    const bad = await fetch(`${base}/api/log`, { method: 'POST', body: '{nope' });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/log`, { method: 'PUT' })).status).toBe(405);
  });

  it('leaves non-/api/log URLs to the caller', async () => {
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});

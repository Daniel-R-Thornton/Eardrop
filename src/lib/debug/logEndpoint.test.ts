import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
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

describe('log endpoint', () => {
  it('answers the GET probe with 204', async () => {
    expect((await fetch(`${base}/api/log`)).status).toBe(204);
  });

  it('appends rows across POSTs to one file per device+session', async () => {
    expect((await post({ device: 'ph1', session: 'abc', rows: ['row one'] })).status).toBe(204);
    expect((await post({ device: 'ph1', session: 'abc', rows: ['row two'] })).status).toBe(204);
    const date = new Date().toISOString().slice(0, 10);
    const text = await readFile(join(rootDir, 'logs', date, 'ph1-abc.log'), 'utf8');
    expect(text).toBe('row one\nrow two\n');
  });

  it('sanitizes device/session so a request cannot escape logs/', async () => {
    expect((await post({ device: '../../evil', session: 'a/b', rows: ['x'] })).status).toBe(204);
    const date = new Date().toISOString().slice(0, 10);
    const text = await readFile(join(rootDir, 'logs', date, 'evil-ab.log'), 'utf8');
    expect(text).toBe('x\n');
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

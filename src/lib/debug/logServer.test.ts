import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogServer } from '../../../scripts/log-server.mjs';

let server: http.Server;
let base: string;

beforeAll(async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'eardrop-srv-'));
  const distDir = join(rootDir, 'dist');
  await mkdir(join(distDir, 'assets'), { recursive: true });
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>eardrop</title>');
  await writeFile(join(distDir, 'assets', 'app.js'), 'console.log(1)');
  server = createLogServer({ rootDir, distDir });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('log server', () => {
  it('serves static files with sensible MIME types', async () => {
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('falls back to index.html for SPA routes', async () => {
    const page = await fetch(`${base}/room/whatever`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('eardrop');
  });

  it('refuses path traversal out of dist', async () => {
    expect((await fetch(`${base}/..%2f..%2fetc%2fpasswd`)).status).not.toBe(200);
  });

  it('mounts the /api/log handler', async () => {
    expect((await fetch(`${base}/api/log`)).status).toBe(204);
  });
});

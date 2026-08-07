/**
 * log-endpoint.mjs — the one place POST /api/log is implemented.
 *
 * Shared by the standalone LAN log server (scripts/log-server.mjs) and the
 * Vite dev server (vite.config.ts plugin) so a phone can report against
 * either with the same relative URL. Plain .mjs, not TS: the standalone
 * server must run under bare `node` with no build step.
 *
 * Appends rows to logs/<yyyy-mm-dd>/<device>-<session>.log under rootDir.
 * Append-only on purpose — the phone's dlog ring holds 500 records, and this
 * file is what survives after the ring wraps.
 */
/* global Buffer */
// Node global: eslint.config.js only wires TS/browser rules for src/**, so
// scripts/*.mjs sees plain eslint:recommended with no Node globals declared.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BODY_CAP = 1024 * 1024;

/** Strip to [A-Za-z0-9_-] and cap length: these become path segments, and a
 *  request must never be able to write outside logs/. */
const sanitize = (s) => String(s ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown';

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > BODY_CAP) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/** Handle /api/log; returns true if the URL was ours (response sent). */
export async function handleLogRequest(req, res, { rootDir }) {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/api/log') return false;
  try {
    if (req.method === 'GET') { res.statusCode = 204; res.end(); return true; }
    if (req.method !== 'POST') { res.statusCode = 405; res.end(); return true; }
    const parsed = JSON.parse(await readBody(req));
    const rows = Array.isArray(parsed.rows) ? parsed.rows.filter((r) => typeof r === 'string') : null;
    if (!rows || rows.length === 0) { res.statusCode = 400; res.end('rows required'); return true; }
    const date = new Date().toISOString().slice(0, 10);
    const dir = join(rootDir, 'logs', date);
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, `${sanitize(parsed.device)}-${sanitize(parsed.session)}.log`), `${rows.join('\n')}\n`);
    res.statusCode = 204;
    res.end();
  } catch (err) {
    res.statusCode = 400;
    res.end(err instanceof Error ? err.message : 'bad request');
  }
  return true;
}

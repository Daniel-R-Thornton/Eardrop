/**
 * log-server.mjs — LAN debug server: serves the built app over plain http AND
 * collects phone logs at POST /api/log (see log-endpoint.mjs).
 *
 * Exists because the deployed site is https and a browser will not let an
 * https page POST to a plain-http LAN address. Instead of fighting certs,
 * both devices browse to THIS server during a debug session — which also
 * guarantees both run the identical build (probe wire-format changes made
 * build mismatch a real failure class).
 *
 * Run: npm run build && npm run logserver   (PORT env overrides 8790)
 * Note: build with the default base "/" (do NOT set VITE_BASE) — the Pages
 * build under /Eardrop/ will not load from here.
 */
/* global process, console, URL */
// Node globals: eslint.config.js only wires TS/browser rules for src/**, so
// scripts/*.mjs sees plain eslint:recommended with no Node globals declared.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleLogRequest } from './log-endpoint.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createLogServer({ rootDir, distDir }) {
  const distRoot = resolve(distDir);
  return http.createServer((req, res) => {
    void (async () => {
      if (await handleLogRequest(req, res, { rootDir })) return;
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
      // Reject literal ".." segments BEFORE normalize() touches them: for any
      // root-absolute path (every req.url is one) normalize() already clips
      // leading ".." at "/", so join(distRoot, normalize(urlPath)) can never
      // actually land outside distRoot — the prefix check below never fires.
      // That's not a file-read escape, but without this explicit check a
      // traversal-shaped request would silently fall through to the SPA
      // index.html fallback (200) instead of being refused.
      if (urlPath.split('/').includes('..')) {
        res.statusCode = 403; res.end(); return;
      }
      let filePath = resolve(join(distRoot, normalize(urlPath)));
      if (filePath !== distRoot && !filePath.startsWith(distRoot + sep)) {
        res.statusCode = 403; res.end(); return;
      }
      const exists = await stat(filePath).then((s) => s.isFile()).catch(() => false);
      if (!exists) filePath = join(distRoot, 'index.html'); // SPA fallback
      res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
      createReadStream(filePath)
        .on('error', () => { res.statusCode = 500; res.end(); })
        .pipe(res);
    })().catch(() => { res.statusCode = 500; res.end(); });
  });
}

// CLI entry: only when run directly (`node scripts/log-server.mjs`).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const distDir = join(rootDir, 'dist');
  const port = Number(process.env.PORT) || 8790;
  const hasDist = await stat(join(distDir, 'index.html')).then(() => true).catch(() => false);
  if (!hasDist) {
    console.error('dist/index.html not found — run `npm run build` first (default base, no VITE_BASE).');
    process.exit(1);
  }
  createLogServer({ rootDir, distDir }).listen(port, '0.0.0.0', () => {
    const urls = Object.values(networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i.address}:${port}`);
    console.log(`eardrop log server — logs append under logs/<date>/`);
    for (const u of urls) console.log(`  ${u}`);
  });
}

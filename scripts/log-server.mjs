/**
 * log-server.mjs — LAN debug server: serves the built app over plain http AND
 * collects phone logs at POST /api/log (see log-endpoint.mjs).
 *
 * Exists because the deployed site is https and a browser will not let an
 * https page POST to a plain-http LAN address. Both devices browse to THIS
 * server during a debug session — which also guarantees both run the
 * identical build (probe wire-format changes made build mismatch a real
 * failure class).
 *
 * TLS is not optional for any device other than the host, and the reason is
 * worth stating because serving plain http here already cost one debugging
 * session: `AudioContext.audioWorklet` and `navigator.mediaDevices` are both
 * [SecureContext] in their specs, so on a plain-http LAN origin they are not
 * merely restricted — they are ABSENT. Capture then dies as
 * "Cannot read properties of undefined (reading 'addModule')", several layers
 * below the actual cause, while transmit keeps working (AudioBufferSourceNode
 * needs no secure context) and makes the app look half-alive rather than
 * misconfigured. http://localhost is exempt, which is why the host machine
 * never sees this and a phone always does.
 *
 * So: if a key/cert pair is present this serves https, otherwise it falls back
 * to http and says so. Generate a locally-trusted pair with mkcert:
 *
 *   mkcert -install
 *   mkcert -key-file certs/key.pem -cert-file certs/cert.pem 192.168.x.x localhost
 *
 * Override paths with EARDROP_TLS_KEY / EARDROP_TLS_CERT. certs/ is gitignored
 * — a private key must never be committed.
 *
 * Run: npm run build && npm run logserver   (PORT env overrides 8790)
 * Note: build with the default base "/" (do NOT set VITE_BASE) — the Pages
 * build under /Eardrop/ will not load from here.
 */
/* global process, console, URL */
// Node globals: eslint.config.js only wires TS/browser rules for src/**, so
// scripts/*.mjs sees plain eslint:recommended with no Node globals declared.
import http from 'node:http';
import https from 'node:https';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
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

/**
 * Read the TLS key/cert pair, or null when none is configured.
 *
 * Absence is the normal http path, so it resolves null rather than throwing.
 * A pair that is present but unreadable DOES throw: silently downgrading to
 * http after someone deliberately generated certs would reintroduce the exact
 * missing-secure-context failure they created them to avoid, and it would be
 * invisible until a phone failed to open the mic.
 */
export async function loadTlsMaterial(rootDir) {
  const keyPath = process.env.EARDROP_TLS_KEY ?? join(rootDir, 'certs', 'key.pem');
  const certPath = process.env.EARDROP_TLS_CERT ?? join(rootDir, 'certs', 'cert.pem');
  const present = await Promise.all(
    [keyPath, certPath].map((p) => stat(p).then((s) => s.isFile()).catch(() => false)),
  );
  if (!present[0] && !present[1]) return null;
  if (!present[0] || !present[1]) {
    throw new Error(
      `TLS is half-configured: ${present[0] ? certPath : keyPath} is missing. ` +
        'Provide both key and cert, or neither.',
    );
  }
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  return { key, cert, keyPath, certPath };
}

export function createLogServer({ rootDir, distDir, tls = null }) {
  const distRoot = resolve(distDir);
  const listener = (req, res) => {
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
  };
  return tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, listener)
    : http.createServer(listener);
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
  const tls = await loadTlsMaterial(rootDir);
  const scheme = tls ? 'https' : 'http';
  createLogServer({ rootDir, distDir, tls }).listen(port, '0.0.0.0', () => {
    const addrs = Object.values(networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
    console.log('eardrop log server — logs append under logs/<date>/');
    console.log(`  ${scheme}://localhost:${port}   (host machine)`);
    for (const a of addrs) console.log(`  ${scheme}://${a}:${port}`);
    if (tls) {
      console.log(`\nTLS from ${tls.certPath}`);
      console.log('If the cert does not cover the LAN IP above, regenerate it:');
      console.log(`  mkcert -key-file certs/key.pem -cert-file certs/cert.pem ${addrs[0] ?? '<lan-ip>'} localhost`);
    } else {
      // Not a warning about the host — localhost is a secure origin either way.
      // It is a warning about every OTHER device, which silently loses mic
      // capture on a plain-http LAN origin. See the header comment.
      console.log('\n! serving plain http — mic capture will NOT work on other devices.');
      console.log('  Only http://localhost is a secure context; a LAN IP is not, so');
      console.log('  audioWorklet and navigator.mediaDevices are absent on the phone.');
      console.log('  Generate certs to fix:');
      console.log('    mkcert -install');
      console.log(`    mkcert -key-file certs/key.pem -cert-file certs/cert.pem ${addrs[0] ?? '<lan-ip>'} localhost`);
    }
  });
}

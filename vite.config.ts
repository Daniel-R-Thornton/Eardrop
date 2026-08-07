import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { handleLogRequest } from "./scripts/log-endpoint.mjs";

// Derived from this file's own location, not process.cwd(): `vite` started
// from anywhere but the repo root would otherwise scatter logs/ directories
// wherever the shell happened to be. The standalone server derives its root
// the same way, so both write to the same repo-root logs/.
const repoRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Build identity, frozen into the bundle at build time.
 *
 * A hardware log could not previously say which build produced it, and that
 * gap is not academic: an investigation into a receiver fix stalled for a whole
 * session on "do these logs predate the fix or not?", with no way to answer it
 * from the logs themselves.
 *
 * `dirty` matters as much as the SHA. This project is debugged from a working
 * tree with uncommitted fixes in it — that is the normal state during a
 * hardware run — so a bare SHA does not identify the code that ran, it
 * misidentifies it as the last commit.
 *
 * `time` is the one that catches a stale bundle. The phone loads over the LAN
 * and will happily serve a cached bundle from before the edit; a build time
 * that is older than the change under test says so immediately, where a SHA
 * (unchanged by an uncommitted edit) says nothing at all.
 */
const git = (...args: string[]): string | null => {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // A tarball export or a build container without git is not a build failure.
    return null;
  }
};

const buildInfo = {
  sha: git("rev-parse", "--short", "HEAD") ?? "nogit",
  // `--porcelain` is empty exactly when the tree is clean. Null (no git) is
  // reported as unknown rather than clean: claiming clean without checking is
  // the same lie the bare SHA told.
  dirty: (() => {
    const s = git("status", "--porcelain");
    return s === null ? "?" : s.length > 0;
  })(),
  time: new Date().toISOString(),
  base: process.env.VITE_BASE ?? "/",
};

export default defineConfig({
  root: ".",
  // GitHub Pages serves the site from /<repo>/ — the deploy workflow sets
  // VITE_BASE accordingly; local dev/preview stay at /.
  base: process.env.VITE_BASE ?? "/",
  define: { __BUILD_INFO__: JSON.stringify(buildInfo) },
  build: { outDir: "dist" },
  server: { host: "0.0.0.0", port: 5173 },
  plugins: [
    {
      // Same POST /api/log the standalone log server mounts, so a phone
      // loading the dev server reports identically (see log-endpoint.mjs).
      name: "eardrop-log-endpoint",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          void handleLogRequest(req, res, { rootDir: repoRoot }).then(
            (handled) => { if (!handled) next(); },
            next,
          );
        });
      },
    },
  ],
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { handleLogRequest } from "./scripts/log-endpoint.mjs";

// Derived from this file's own location, not process.cwd(): `vite` started
// from anywhere but the repo root would otherwise scatter logs/ directories
// wherever the shell happened to be. The standalone server derives its root
// the same way, so both write to the same repo-root logs/.
const repoRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: ".",
  // GitHub Pages serves the site from /<repo>/ — the deploy workflow sets
  // VITE_BASE accordingly; local dev/preview stay at /.
  base: process.env.VITE_BASE ?? "/",
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

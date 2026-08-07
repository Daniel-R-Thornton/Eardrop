import { defineConfig } from "vite";
import { handleLogRequest } from "./scripts/log-endpoint.mjs";

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
          void handleLogRequest(req, res, { rootDir: process.cwd() }).then(
            (handled) => { if (!handled) next(); },
            next,
          );
        });
      },
    },
  ],
});

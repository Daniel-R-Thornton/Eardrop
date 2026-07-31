import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  // GitHub Pages serves the site from /<repo>/ — the deploy workflow sets
  // VITE_BASE accordingly; local dev/preview stay at /.
  base: process.env.VITE_BASE ?? "/",
  build: { outDir: "dist" },
  server: { host: "0.0.0.0", port: 5173 },
});

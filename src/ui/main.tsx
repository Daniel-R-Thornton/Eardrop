/**
 * main.tsx — React entry point for Eardrop.
 * Mounts the full React UI into #root.
 * app.ts continues to manage workers/audio as a background controller.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { BenchApp } from './BenchApp';
import './app'; // boot the background controller (workers, audio, events)
import '../style.css';
import { startLogReporter } from '../lib/debug/logReporter';

// Probe for a LAN log server (scripts/log-server.mjs or the dev server) and
// auto-push the dlog ring if one answers. Inert on GitHub Pages — the probe
// 404s and the reporter never arms. See logReporter.ts.
startLogReporter();

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(React.createElement(BenchApp));
} else {
  console.error('[Eardrop] #root not found');
}

/**
 * main.tsx — React entry point for Eardrop.
 * Mounts the full React UI into #root.
 * app.ts continues to manage workers/audio as a background controller.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { MainApp } from './MainApp';
import './app'; // boot the background controller (workers, audio, events)
import '../style.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(React.createElement(MainApp));
} else {
  console.error('[Eardrop] #root not found');
}

/**
 * react.ts — React mount point for the debug UI.
 *
 * Mounts the DebugContainer into a dedicated div (#react-debug).
 * The main app.ts controls visibility (toggled by Ctrl+Shift+D).
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DebugContainer } from './debug/DebugContainer';

let root: Root | null = null;

/**
 * Mount the React debug UI. Safe to call multiple times.
 */
export function mountReactDebug(): void {
  if (root) return; // already mounted

  const container = document.getElementById('react-debug');
  if (!container) {
    console.warn('[React] #react-debug not found in DOM');
    return;
  }

  root = createRoot(container);
  root.render(React.createElement(DebugContainer));
}

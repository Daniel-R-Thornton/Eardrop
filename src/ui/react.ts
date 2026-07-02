/**
 * react.ts — React mount point for the debug floating window UI.
 * Mounts DebugContainer into a dedicated div.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import DebugContainer from './debug/DebugContainer';

const container = document.getElementById('react-debug');
if (container) {
  const root = createRoot(container);
  root.render(React.createElement(DebugContainer));
}

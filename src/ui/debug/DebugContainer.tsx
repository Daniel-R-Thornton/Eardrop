/**
 * DebugContainer.tsx — Root component for floating window debug UI.
 *
 * Manages a set of open floating windows. app.ts imports the windowManager
 * singleton to open/close windows from event handlers.
 */

import React, { useState, useCallback, useRef } from 'react';
import FloatingWindow from './FloatingWindow';

// ─── Window Config ──────────────────────────────────

export interface WindowConfig {
  id: string;
  title: string;
  component: React.ReactNode;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  zIndex: number;
}

// ─── Window Manager (Singleton) ─────────────────────

type WindowsListener = (windows: Map<string, WindowConfig>) => void;

class WindowManager {
  private windows = new Map<string, WindowConfig>();
  private nextZ = 100;
  private listeners: Set<WindowsListener> = new Set();
  private defaultPos = { x: 60, y: 60 };
  private posOffset = 0;

  subscribe(listener: WindowsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) {
      try { listener(this.windows); } catch { /* ignore */ }
    }
  }

  openWindow(id: string, title: string, component: React.ReactNode): void {
    if (this.windows.has(id)) {
      // Bring to front
      this.focusWindow(id);
      return;
    }

    const pos = {
      x: this.defaultPos.x + this.posOffset,
      y: this.defaultPos.y + this.posOffset,
    };
    this.posOffset = (this.posOffset + 24) % 240;

    this.windows.set(id, {
      id,
      title,
      component,
      position: pos,
      size: { width: 360, height: 280 },
      zIndex: this.nextZ++,
    });
    this.notify();
  }

  closeWindow(id: string): void {
    this.windows.delete(id);
    this.notify();
  }

  focusWindow(id: string): void {
    const win = this.windows.get(id);
    if (win) {
      win.zIndex = this.nextZ++;
      this.notify();
    }
  }

  getWindows(): Map<string, WindowConfig> {
    return new Map(this.windows);
  }
}

/** Singleton — import this from app.ts to control debug windows */
export const windowManager = new WindowManager();

// ─── React Component ────────────────────────────────

const DebugContainer: React.FC = () => {
  const [windows, setWindows] = useState<Map<string, WindowConfig>>(new Map());

  React.useEffect(() => {
    return windowManager.subscribe((updated) => {
      setWindows(new Map(updated));
    });
  }, []);

  const handleClose = useCallback((id: string) => {
    windowManager.closeWindow(id);
  }, []);

  const handleFocus = useCallback((id: string) => {
    windowManager.focusWindow(id);
  }, []);

  if (windows.size === 0) return null;

  return (
    <>
      {Array.from(windows.values()).map((win) => (
        <FloatingWindow
          key={win.id}
          id={win.id}
          title={win.title}
          initialPosition={win.position}
          initialSize={win.size}
          zIndex={win.zIndex}
          onClose={handleClose}
          onFocus={handleFocus}
        >
          {win.component}
        </FloatingWindow>
      ))}
    </>
  );
};

export default DebugContainer;

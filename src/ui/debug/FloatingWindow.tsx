/**
 * FloatingWindow.tsx — Draggable, resizable, closeable floating window.
 * Renders via ReactDOM.createPortal into document.body.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface FloatingWindowProps {
  id: string;
  title: string;
  children: React.ReactNode;
  initialPosition?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  onClose?: (id: string) => void;
  onFocus?: (id: string) => void;
  zIndex?: number;
}

const MIN_W = 200;
const MIN_H = 150;
const HEADER_H = 32;

const styles: Record<string, React.CSSProperties> = {
  window: {
    position: 'fixed',
    background: '#0e0e18',
    border: '1px solid #2a2a3e',
    borderRadius: 8,
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#e0e0e8',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 8px',
    height: HEADER_H,
    background: '#15152a',
    borderBottom: '1px solid #2a2a3e',
    cursor: 'grab',
    userSelect: 'none',
    flexShrink: 0,
  },
  title: {
    fontSize: 11,
    fontWeight: 600,
    color: '#6c6cff',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerBtns: {
    display: 'flex',
    gap: 4,
    flexShrink: 0,
  },
  btn: {
    background: 'none',
    border: '1px solid #3a3a5e',
    color: '#8888a0',
    cursor: 'pointer',
    padding: '0 6px',
    borderRadius: 4,
    fontSize: 10,
    lineHeight: '18px',
  },
  body: {
    flex: 1,
    overflow: 'auto',
    minHeight: 0,
    padding: 4,
  },
  resizeHandle: {
    position: 'absolute' as const,
    right: 0,
    bottom: 0,
    width: 12,
    height: 12,
    cursor: 'nwse-resize',
    background: 'linear-gradient(135deg, transparent 50%, #3a3a5e 50%)',
  },
};

const FloatingWindow: React.FC<FloatingWindowProps> = ({
  id,
  title,
  children,
  initialPosition = { x: 100, y: 100 },
  initialSize = { width: 320, height: 240 },
  onClose,
  onFocus,
  zIndex = 100,
}) => {
  const [pos, setPos] = useState(initialPosition);
  const [size, setSize] = useState(initialSize);
  const windowRef = useRef<HTMLDivElement>(null);

  // ─── Drag ────────────────────────────────────────
  const dragRef = useRef<{ startX: number; startY: number; startPos: { x: number; y: number } } | null>(null);

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.float-win-btn')) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPos: { ...pos },
    };
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: dragRef.current.startPos.x + (ev.clientX - dragRef.current.startX),
        y: dragRef.current.startPos.y + (ev.clientY - dragRef.current.startY),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [pos]);

  // ─── Resize ──────────────────────────────────────
  const resizeRef = useRef<{
    startX: number; startY: number; startW: number; startH: number;
  } | null>(null);

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: size.width,
      startH: size.height,
    };
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      setSize({
        width: Math.max(MIN_W, resizeRef.current.startW + (ev.clientX - resizeRef.current.startX)),
        height: Math.max(MIN_H, resizeRef.current.startH + (ev.clientY - resizeRef.current.startY)),
      });
    };
    const onUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [size]);

  // ─── Focus on click ─────────────────────────────
  const onWindowMouseDown = useCallback(() => {
    if (onFocus) onFocus(id);
  }, [id, onFocus]);

  // ─── Render ──────────────────────────────────────
  return createPortal(
    <div
      ref={windowRef}
      style={{ ...styles.window, left: pos.x, top: pos.y, width: size.width, height: size.height, zIndex }}
      onMouseDown={onWindowMouseDown}
    >
      {/* Header */}
      <div style={styles.header} onMouseDown={onHeaderMouseDown}>
        <span style={styles.title}>{title}</span>
        <div className="float-win-btn" style={styles.headerBtns}>
          <button style={styles.btn} className="float-win-btn" onClick={() => onClose?.(id)}>✕</button>
        </div>
      </div>
      {/* Body */}
      <div style={styles.body}>{children}</div>
      {/* Resize handle */}
      <div style={styles.resizeHandle} onMouseDown={onResizeMouseDown} />
    </div>,
    document.body,
  );
};

export default FloatingWindow;

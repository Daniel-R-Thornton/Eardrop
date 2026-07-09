/**
 * FloatingWindow.tsx — Draggable, resizable, closeable floating window.
 *
 * Each debug panel is rendered into a portal at document.body.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface FloatingWindowProps {
  title: string;
  children: React.ReactNode;
  initialPosition?: { x: number; y: number };
  initialSize?: { width: number; height: number };
  onClose?: () => void;
  zIndex?: number;
  onFocus?: () => void;
}

export const FloatingWindow: React.FC<FloatingWindowProps> = ({
  title,
  children,
  initialPosition = { x: 100, y: 100 },
  initialSize = { width: 400, height: 300 },
  onClose,
  zIndex = 1000,
  onFocus,
}) => {
  const [position, setPosition] = useState(initialPosition);
  const [size, setSize] = useState(initialSize);
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, startPos: { x: 0, y: 0 } });
  const resizeRef = useRef({ startX: 0, startY: 0, startSize: { width: 0, height: 0 } });

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('.fw-header-btns')) return;
      onFocus?.();
      setDragging(true);
      dragRef.current = { startX: e.clientX, startY: e.clientY, startPos: { ...position } };
    },
    [position, onFocus],
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onFocus?.();
      setResizing(true);
      resizeRef.current = { startX: e.clientX, startY: e.clientY, startSize: { ...size } };
    },
    [size, onFocus],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) =>
      setPosition({
        x: dragRef.current.startPos.x + (e.clientX - dragRef.current.startX),
        y: dragRef.current.startPos.y + (e.clientY - dragRef.current.startY),
      });
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) =>
      setSize({
        width: Math.max(
          200,
          resizeRef.current.startSize.width + (e.clientX - resizeRef.current.startX),
        ),
        height: Math.max(
          150,
          resizeRef.current.startSize.height + (e.clientY - resizeRef.current.startY),
        ),
      });
    const onUp = () => setResizing(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [resizing]);

  const panel = (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: size.width,
        height: size.height,
        zIndex,
        background: '#0e0e18',
        border: '1px solid #2a2a3e',
        borderRadius: 10,
        boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'monospace',
        fontSize: 12,
        color: '#e0e0e8',
        userSelect: dragging ? 'none' : 'auto',
      }}
    >
      <div
        onMouseDown={handleMouseDown}
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 10px',
          background: '#15152a',
          borderBottom: '1px solid #2a2a3e',
          cursor: 'grab',
          flexShrink: 0,
          fontWeight: 600,
          color: '#6c6cff',
        }}
      >
        <span>{title}</span>
        <div className="fw-header-btns" style={{ display: 'flex', gap: 4 }}>
          {onClose && (
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: '1px solid #3a3a5e',
                color: '#8888a0',
                cursor: 'pointer',
                padding: '0 6px',
                borderRadius: 4,
                fontSize: 12,
                lineHeight: '18px',
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 6, minHeight: 0 }}>{children}</div>
      <div
        onMouseDown={handleResizeStart}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: 'nwse-resize',
          background: 'linear-gradient(135deg, transparent 50%, #3a3a5e 50%)',
        }}
      />
    </div>
  );

  return createPortal(panel, document.body);
};

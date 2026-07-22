// src/ui/components/instrument/Screen.tsx
import React, { useEffect, useRef } from 'react';
import { T } from '../../theme/labaccent/tokens';

export interface ScreenProps {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  grid?: boolean;
}

export function Screen({ width, height, draw, grid = true }: ScreenProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = width * dpr;
    cv.height = height * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.screenBg;
    ctx.fillRect(0, 0, width, height);
    if (grid) {
      ctx.strokeStyle = T.grid;
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x += width / 10) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
      for (let y = 0; y <= height; y += height / 8) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
    }
    draw(ctx, width, height);
  });
  return <canvas ref={ref} className="lab-screen" style={{ width, height }} />;
}

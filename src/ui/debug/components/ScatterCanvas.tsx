/**
 * ScatterCanvas.tsx — I/Q constellation scatter plot for one tone.
 * Draws a grid, crosshair, and colored scatter points.
 */

import React, { useEffect, useRef } from 'react';

export interface ScatterPoint {
  i: number;
  q: number;
  bit: number; // 0 or 1
  error?: boolean; // if true, highlight differently
}

interface Props {
  points: ScatterPoint[];
  width: number;
  height: number;
  toneLabel: string;
  color: string;
}

export const ScatterCanvas: React.FC<Props> = ({ points, width, height, toneLabel, color }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = width / 2;
    const cy = height / 2;
    const maxDim = Math.min(width, height) / 2 - 20;

    // Find extent for auto-scaling
    let maxVal = 1;
    for (const p of points) {
      const absI = Math.abs(p.i);
      const absQ = Math.abs(p.q);
      if (absI > maxVal) maxVal = absI;
      if (absQ > maxVal) maxVal = absQ;
    }
    maxVal = Math.max(maxVal, 0.01);
    const scale = maxDim / maxVal;

    // Background
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, width, height);

    // Grid
    ctx.strokeStyle = '#1a1a28';
    ctx.lineWidth = 0.5;
    for (let i = -3; i <= 3; i++) {
      const pos = cx + (i * maxDim) / 3;
      ctx.beginPath();
      ctx.moveTo(pos, 0);
      ctx.lineTo(pos, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, pos);
      ctx.lineTo(width, pos);
      ctx.stroke();
    }

    // Crosshair
    ctx.strokeStyle = '#ff446644';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(width, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, height);
    ctx.stroke();

    // Label
    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    ctx.fillText(toneLabel, 4, 12);

    // Scatter points
    for (const p of points) {
      const x = cx + p.i * scale;
      const y = cy - p.q * scale; // Y inverted: +Q is up
      if (x < 0 || x > width || y < 0 || y > height) continue;

      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);

      if (p.error) {
        ctx.fillStyle = '#ff4444';
      } else if (p.bit === 1) {
        ctx.fillStyle = color;
      } else {
        ctx.fillStyle = '#555';
      }
      ctx.fill();

      // Border
      ctx.strokeStyle = '#ffffff33';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = '#555';
    ctx.font = '8px monospace';
    ctx.fillText('I', width - 12, cy - 4);
    ctx.fillText('Q', cx + 4, 10);
  }, [points, width, height, toneLabel, color]);

  return <canvas ref={ref} style={{ width, height, display: 'block' }} />;
};

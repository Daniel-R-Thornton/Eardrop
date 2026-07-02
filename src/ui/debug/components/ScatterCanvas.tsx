/**
 * ScatterCanvas.tsx — I/Q constellation scatter plot for one tone.
 * Canvas-based, renders with devicePixelRatio for sharp output.
 */

import React, { useRef, useEffect } from 'react';

export interface ScatterPoint {
  i: number;
  q: number;
  ampBit: number;
  phaseBit: number;
}

interface Props {
  points: ScatterPoint[];
  width?: number;
  height?: number;
  toneLabel: string;
  color: string;
}

const ScatterCanvas: React.FC<Props> = ({
  points,
  width = 160,
  height = 160,
  toneLabel,
  color,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;
    const cw = width * dpr;
    const ch = height * dpr;
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Compute axis limits
    let maxAbs = 0.5;
    for (const p of points) {
      maxAbs = Math.max(maxAbs, Math.abs(p.i), Math.abs(p.q));
    }
    // Round up to nearest 0.5
    let limit = Math.ceil(maxAbs * 2) / 2;
    if (limit < 0.5) limit = 0.5;

    const pad = 20;
    const plotW = width - pad * 2;
    const plotH = height - pad * 2;
    const midX = pad + plotW / 2;
    const midY = pad + plotH / 2;
    const scale = Math.min(plotW / 2, plotH / 2) / limit;

    // Background
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, width, height);

    // Grid circles
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.5;
    for (let r = 0.25; r <= limit; r += 0.25) {
      const radius = r * scale;
      ctx.beginPath();
      ctx.arc(midX, midY, radius, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Crosshair axes
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, midY);
    ctx.lineTo(width - pad, midY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(midX, pad);
    ctx.lineTo(midX, height - pad);
    ctx.stroke();

    // Axis labels
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.fillText('I', width - pad + 4, midY + 4);
    ctx.fillText('Q', midX + 4, pad - 4);

    // Tone label
    ctx.fillStyle = color;
    ctx.font = 'bold 10px monospace';
    ctx.fillText(toneLabel, pad + 4, pad + 12);

    // Scatter points
    for (const p of points) {
      const x = midX + p.i * scale;
      const y = midY - p.q * scale; // Q axis inverted for display

      if (p.ampBit === 1) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.8;
      } else {
        ctx.fillStyle = '#555';
        ctx.globalAlpha = 0.3;
      }

      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }, [points, width, height, toneLabel, color, dpr]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', background: '#0a0a14', borderRadius: 4 }}
    />
  );
};

export default ScatterCanvas;

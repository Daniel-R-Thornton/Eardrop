import React, { useEffect, useRef } from 'react';

interface ConstellationPlotProps {
  iVal: number;
  qVal: number;
  color: string;
  label: string;
}

/**
 * Constellation diagram — plots I/Q values on a 2D canvas with fading trail.
 * Shows BPSK phase shifts visually: in-phase (right) vs out-of-phase (left).
 */
export function ConstellationPlot({ iVal, qVal, color, label }: ConstellationPlotProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const history = useRef<Array<{ x: number; y: number }>>([]);
  const size = 80;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width;
    const h = c.height;
    const cx = w / 2;
    const cy = h / 2;
    const scale = w / 2 / 0.6;

    // Fading trail
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, w, h);

    // Axes
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(0, cy);
    ctx.lineTo(w, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 0.5 * scale, 0, Math.PI * 2);
    ctx.stroke();

    // Add to history
    const x = cx + iVal * scale;
    const y = cy - qVal * scale;
    history.current.push({ x, y });
    if (history.current.length > 60) history.current.shift();

    // Draw trail
    if (history.current.length > 1) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < history.current.length; i++) {
        const p = history.current[i];
        if (i === 0) {
          ctx.moveTo(p.x, p.y);
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Current dot
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.stroke();
  }, [iVal, qVal, color]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <canvas
        ref={ref}
        width={size}
        height={size}
        style={{ borderRadius: 6, background: 'rgba(0,0,0,0.4)' }}
      />
      <span style={{ fontSize: 9, color, fontFamily: 'SF Mono, ui-monospace, monospace' }}>
        {label} I={iVal.toFixed(3)} Q={qVal.toFixed(3)}
      </span>
    </div>
  );
}

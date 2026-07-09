/**
 * WaveformScope.tsx — Interactive oscilloscope with gain, zoom, TX/RX overlay, and diff.
 *
 * Features:
 *   - Gain slider for vertical scaling
 *   - Zoom slider for horizontal zoom
 *   - TX (speaker output) overlay in orange
 *   - RX (mic input) trace in blue
 *   - Diff mode (TX - RX) to visualize channel distortion
 *   - Gridlines and time axis
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  rxSamples: Float32Array | null;
  txSamples: Float32Array | null;
  sampleRate?: number;
}

export function WaveformScope({ rxSamples, txSamples, sampleRate = 3200 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [gain, setGain] = useState(1.0);
  const [zoom, setZoom] = useState(1); // samples per pixel
  const [offset, setOffset] = useState(0); // start sample
  const [mode, setMode] = useState<'rx' | 'tx' | 'both' | 'diff'>('both');

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = c.width,
      h = c.height;
    const mid = h / 2;

    // Background
    ctx.fillStyle = '#08081a';
    ctx.fillRect(0, 0, w, h);

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 0.5;
    for (let y = 0; y <= 4; y++) {
      const py = (y / 4) * h;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(w, py);
      ctx.stroke();
    }
    for (let x = 0; x <= 8; x++) {
      const px = (x / 8) * w;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // Helper: draw trace
    const drawTrace = (samples: Float32Array | null, color: string, alpha = 1) => {
      if (!samples || samples.length === 0) return;
      const step = Math.max(1, zoom);
      const maxSamp = Math.min(samples.length, offset + w * step);
      if (maxSamp <= offset) return;

      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let first = true;
      for (let px = 0; px < w; px++) {
        const idx = offset + px * step;
        if (idx >= samples.length) break;
        // Linear interpolation between steps for smoother rendering
        let val = samples[Math.floor(idx)];
        const frac = idx - Math.floor(idx);
        if (frac > 0 && Math.floor(idx) + 1 < samples.length) {
          val = val + (samples[Math.floor(idx) + 1] - val) * frac;
        }
        const y = mid - val * mid * gain;
        if (first) {
          ctx.moveTo(px, y);
          first = false;
        } else ctx.lineTo(px, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    // Draw traces based on mode
    if (mode === 'rx' || mode === 'both') drawTrace(rxSamples, '#818cf8');
    if (mode === 'tx' || mode === 'both') drawTrace(txSamples, '#f59e0b', 0.7);
    if (mode === 'diff' && rxSamples && txSamples) {
      const diff = new Float32Array(Math.min(rxSamples.length, txSamples.length));
      for (let i = 0; i < diff.length; i++) diff[i] = (rxSamples[i] ?? 0) - (txSamples[i] ?? 0);
      drawTrace(diff, '#f87171');
    }

    // Time axis labels
    ctx.fillStyle = '#4b5563';
    ctx.font = '9px SF Mono, ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let x = 0; x <= 8; x++) {
      const px = (x / 8) * w;
      const t = (offset + px * zoom) / sampleRate;
      ctx.fillText(`${t.toFixed(2)}s`, px, h - 4);
    }

    // Legend
    ctx.font = '9px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    if (mode === 'both') {
      ctx.fillStyle = '#818cf8';
      ctx.fillText('RX', 6, 14);
      ctx.fillStyle = '#f59e0b';
      ctx.fillText('TX', 36, 14);
    } else if (mode === 'diff') {
      ctx.fillStyle = '#f87171';
      ctx.fillText('TX−RX diff', 6, 14);
    }
  }, [rxSamples, txSamples, gain, zoom, offset, mode, sampleRate]);

  useEffect(() => {
    draw();
    const interval = setInterval(draw, 200);
    return () => clearInterval(interval);
  }, [draw]);

  // Zoom with mouse wheel
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) setZoom((z) => Math.max(1, Math.floor(z * 0.7)));
    else setZoom((z) => Math.min(256, Math.floor(z * 1.4)));
  }, []);

  // Pan with drag
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setDragging(true);
    dragStart.current = e.clientX;
  }, []);
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStart.current;
      dragStart.current = e.clientX;
      setOffset((o) => Math.max(0, o - dx * zoom));
    },
    [dragging, zoom],
  );
  const handleMouseUp = useCallback(() => setDragging(false), []);

  const totalSamples = Math.max(rxSamples?.length ?? 0, txSamples?.length ?? 0);

  return (
    <div
      style={{
        background: 'rgba(0,0,0,0.2)',
        borderRadius: 8,
        border: '1px solid rgba(255,255,255,0.06)',
        overflow: 'hidden',
      }}
    >
      <canvas
        ref={canvasRef}
        width={1200}
        height={400}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{
          width: '100%',
          height: 400,
          cursor: dragging ? 'grabbing' : 'grab',
          display: 'block',
        }}
      />

      {/* Controls bar */}
      <div
        style={{
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          padding: '6px 12px',
          borderTop: '1px solid rgba(255,255,255,0.05)',
          background: 'rgba(0,0,0,0.15)',
          flexWrap: 'wrap',
        }}
      >
        {/* Mode */}
        <div style={{ display: 'flex', gap: 2 }}>
          {(['rx', 'tx', 'both', 'diff'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '3px 8px',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 4,
                background: mode === m ? 'rgba(129,140,248,0.2)' : 'transparent',
                color: mode === m ? '#818cf8' : '#6b7280',
                cursor: 'pointer',
                fontSize: 10,
                fontWeight: 600,
                textTransform: 'uppercase',
              }}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Gain */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: '#6b7280', minWidth: 28 }}>Gain</span>
          <input
            type="range"
            min="0.1"
            max="10"
            step="0.1"
            value={gain}
            onChange={(e) => setGain(parseFloat(e.target.value))}
            style={{ width: 80, accentColor: '#818cf8' }}
          />
          <span style={{ fontSize: 10, color: '#818cf8', fontFamily: 'monospace', minWidth: 30 }}>
            ×{gain.toFixed(1)}
          </span>
        </div>

        {/* Zoom */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: '#6b7280', minWidth: 28 }}>Zoom</span>
          <input
            type="range"
            min="1"
            max="128"
            step="1"
            value={zoom}
            onChange={(e) => setZoom(parseInt(e.target.value))}
            style={{ width: 80, accentColor: '#34d399' }}
          />
          <span style={{ fontSize: 10, color: '#34d399', fontFamily: 'monospace', minWidth: 30 }}>
            {zoom}spp
          </span>
        </div>

        {/* Offset */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: '#6b7280', minWidth: 28 }}>Pos</span>
          <input
            type="range"
            min="0"
            max={Math.max(0, totalSamples)}
            step={zoom}
            value={offset}
            onChange={(e) => setOffset(parseInt(e.target.value))}
            style={{ width: 80, accentColor: '#f59e0b' }}
          />
          <button
            onClick={() => setOffset(0)}
            style={{
              padding: '2px 6px',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 3,
              background: 'transparent',
              color: '#6b7280',
              cursor: 'pointer',
              fontSize: 9,
            }}
          >
            ↺
          </button>
        </div>

        {/* Info */}
        <span
          style={{ fontSize: 9, color: '#4b5563', fontFamily: 'monospace', marginLeft: 'auto' }}
        >
          {totalSamples > 0
            ? `${(totalSamples / sampleRate).toFixed(1)}s · ${sampleRate}Hz`
            : 'no data'}
        </span>
      </div>
    </div>
  );
}

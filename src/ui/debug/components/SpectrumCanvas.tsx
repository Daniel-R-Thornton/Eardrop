/**
 * SpectrumCanvas.tsx — FFT magnitude spectrum display.
 * Canvas-based, dB scale, tone frequency markers, peak hold.
 */

import React, { useRef, useEffect } from 'react';

interface Props {
  magnitudes: Float32Array;
  sampleRate: number;
  width?: number;
  height?: number;
  toneFreqs?: number[];
  toneColors?: string[];
}

const SpectrumCanvas: React.FC<Props> = ({
  magnitudes,
  sampleRate,
  width = 320,
  height = 120,
  toneFreqs = [],
  toneColors = [],
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || magnitudes.length === 0) return;

    const ctx = canvas.getContext('2d')!;
    const cw = width * dpr;
    const ch = height * dpr;
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pad = { top: 8, bottom: 16, left: 36, right: 8 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    // Background
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, width, height);

    // Normalize magnitudes to dB, relative to peak
    let peak = 0;
    for (let i = 0; i < magnitudes.length; i++) {
      if (magnitudes[i] > peak) peak = magnitudes[i];
    }
    if (peak === 0) peak = 1;

    const nyquist = sampleRate / 2;
    const binWidth = nyquist / magnitudes.length;

    // Plot the spectrum
    ctx.strokeStyle = '#6c6cff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < plotW; x++) {
      const binIdx = Math.floor((x / plotW) * magnitudes.length);
      if (binIdx >= magnitudes.length) break;
      const db = 20 * Math.log10(magnitudes[binIdx] / peak + 1e-10);
      const norm = Math.max(0, Math.min(1, (db + 60) / 50));
      const y = pad.top + plotH - norm * plotH;
      if (x === 0) ctx.moveTo(pad.left + x, y);
      else ctx.lineTo(pad.left + x, y);
    }
    ctx.stroke();

    // Fill below curve
    const lastX = plotW - 1;
    const lastBin = Math.min(lastX, magnitudes.length - 1);
    const lastDb = 20 * Math.log10(magnitudes[lastBin] / peak + 1e-10);
    const lastNorm = Math.max(0, Math.min(1, (lastDb + 60) / 50));
    ctx.lineTo(pad.left + lastX, pad.top + plotH);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(108,108,255,0.08)';
    ctx.fill();

    // Tone frequency markers
    for (let i = 0; i < toneFreqs.length; i++) {
      const freq = toneFreqs[i];
      const x = pad.left + (freq / nyquist) * plotW;
      const color = toneColors[i % toneColors.length] || '#888';

      // Dashed vertical line
      ctx.strokeStyle = `${color}44`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Frequency label
      ctx.fillStyle = color;
      ctx.font = '8px monospace';
      ctx.fillText(`${freq}Hz`, x - 14, height - 2);
    }

    // X axis labels
    ctx.fillStyle = '#555';
    ctx.font = '8px monospace';
    for (let f = 0; f <= nyquist; f += 500) {
      const x = pad.left + (f / nyquist) * plotW;
      ctx.fillText(`${f}`, x - 6, height - 4);
    }

    // Y axis label
    ctx.fillStyle = '#555';
    ctx.font = '8px monospace';
    ctx.fillText('0dB', 2, pad.top + 8);
    ctx.fillText('-60dB', 2, pad.top + plotH);

  }, [magnitudes, sampleRate, width, height, toneFreqs, toneColors, dpr]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', background: '#0a0a14', borderRadius: 4 }}
    />
  );
};

export default SpectrumCanvas;

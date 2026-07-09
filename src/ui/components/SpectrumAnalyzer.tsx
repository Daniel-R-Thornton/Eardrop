/**
 * SpectrumAnalyzer.tsx — VU meter, FFT bars, and waterfall spectrogram.
 * Updates live from the FFT spectrum pushed via the Store.
 */

import React, { useEffect, useRef } from 'react';

interface Props {
  spectrum: Float32Array | null;
  rawPeak: number;
  noiseFloorDb: number;
  sampleRate?: number;
}

const MAX_BINS = 64;

export function SpectrumAnalyzer({ spectrum, rawPeak, noiseFloorDb, sampleRate = 3200 }: Props) {
  const waterfallRef = useRef<HTMLCanvasElement>(null);
  const fftRef = useRef<HTMLCanvasElement>(null);
  const waterfallRows = useRef<Float32Array[]>([]);

  // Waterfall: push new row, shift old
  useEffect(() => {
    if (!spectrum) return;
    const rows = waterfallRows.current;
    rows.push(new Float32Array(spectrum));
    if (rows.length > 80) rows.shift();

    // Draw waterfall
    const wc = waterfallRef.current;
    if (!wc) return;
    const wctx = wc.getContext('2d');
    if (!wctx) return;
    const ww = wc.width,
      wh = wc.height;

    // Scroll up
    const rowH = wh / rows.length;
    wctx.drawImage(wc, 0, rowH, ww, wh - rowH, 0, 0, ww, wh - rowH);
    // Draw new row at bottom
    const latest = rows[rows.length - 1];
    const maxMag = 0.15;
    for (let x = 0; x < MAX_BINS; x++) {
      const db = latest[x] > 1e-10 ? 20 * Math.log10(latest[x]) : -80;
      const t = Math.max(0, Math.min(1, (db + 60) / 60));
      const r = Math.floor(t * 100);
      const g = Math.floor(t * 60);
      const b = Math.floor(t * 200);
      wctx.fillStyle = `rgb(${r},${g},${b})`;
      wctx.fillRect((x / MAX_BINS) * ww, wh - rowH, ww / MAX_BINS, rowH);
    }

    // Draw FFT bars
    const fc = fftRef.current;
    if (!fc) return;
    const fctx = fc.getContext('2d');
    if (!fctx) return;
    const fw = fc.width,
      fh = fc.height;

    fctx.fillStyle = 'rgba(0,0,0,0.5)';
    fctx.fillRect(0, 0, fw, fh);

    const barW = fw / MAX_BINS - 1;
    for (let x = 0; x < MAX_BINS; x++) {
      const db = latest[x] > 1e-10 ? 20 * Math.log10(latest[x]) : -80;
      const t = Math.max(0, Math.min(1, (db + 60) / 60));
      const h = t * fh;
      const freq = (x / MAX_BINS) * (sampleRate / 2);
      // Color based on frequency proximity to tone frequencies
      const nearTone = [475, 525, 625, 775].some((tf) => Math.abs(freq - tf) < 50);
      fctx.fillStyle = nearTone
        ? `rgb(${Math.floor(t * 255)},${Math.floor(t * 100)},${Math.floor(t * 255)})`
        : `rgb(${Math.floor(t * 100)},${Math.floor(t * 200)},${Math.floor(t * 100)})`;
      fctx.fillRect(x * (barW + 1), fh - h, barW, h);
    }

    // Frequency labels
    fctx.fillStyle = '#4b5563';
    fctx.font = '9px monospace';
    fctx.textAlign = 'center';
    for (let f = 0; f <= sampleRate / 2; f += 400) {
      const x = (f / (sampleRate / 2)) * fw;
      fctx.fillText(`${f}`, x, fh - 2);
    }
  }, [spectrum, sampleRate]);

  // VU meter
  const vuDb = rawPeak > 0.0001 ? 20 * Math.log10(rawPeak) : -80;
  const vuPct = Math.max(0, Math.min(100, ((vuDb + 60) / 60) * 100));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* VU Meter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: '#6b7280', minWidth: 20 }}>VU</span>
        <div
          style={{
            flex: 1,
            height: 12,
            background: 'rgba(255,255,255,0.05)',
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${vuPct}%`,
              height: '100%',
              background:
                vuDb > -12
                  ? '#f87171'
                  : vuDb > -24
                    ? '#f59e0b'
                    : vuDb > -40
                      ? '#34d399'
                      : '#818cf8',
              borderRadius: 3,
              transition: 'width 60ms linear',
            }}
          />
        </div>
        <span
          style={{
            fontSize: 10,
            fontFamily: 'monospace',
            color: '#e5e7eb',
            minWidth: 45,
            textAlign: 'right',
          }}
        >
          {vuDb.toFixed(0)} dB
        </span>
      </div>

      {/* Raw peak + noise floor */}
      <div style={{ display: 'flex', gap: 16, fontSize: 10, color: '#6b7280' }}>
        <span>
          Peak:{' '}
          <span style={{ color: '#e5e7eb', fontFamily: 'monospace' }}>
            {rawPeak.toExponential(2)}
          </span>
        </span>
        <span>
          Noise:{' '}
          <span style={{ color: '#e5e7eb', fontFamily: 'monospace' }}>
            {noiseFloorDb.toFixed(0)} dB
          </span>
        </span>
      </div>

      {/* FFT Bars */}
      <canvas
        ref={fftRef}
        width={400}
        height={80}
        style={{
          width: '100%',
          height: 80,
          borderRadius: 4,
          background: 'rgba(0,0,0,0.4)',
        }}
      />

      {/* Waterfall */}
      <canvas
        ref={waterfallRef}
        width={400}
        height={100}
        style={{
          width: '100%',
          height: 100,
          borderRadius: 4,
          background: 'rgba(0,0,0,0.4)',
        }}
      />
    </div>
  );
}

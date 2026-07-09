/**
 * MicMonitorPanel.tsx — Real-time microphone diagnostics.
 *
 * Consumes Store.micDiag from AudioRecorder.getDiag().
 * Shows RMS level, peak, zero-crossing rate, waveform, and context info.
 */

import React, { useRef, useEffect } from 'react';
import { useStore } from '../../Store';

const WaveformCanvas: React.FC<{ samples: Float32Array; width: number; height: number }> = ({ samples, width, height }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || samples.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, width, height);
    const midY = height / 2;
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    const step = Math.max(1, Math.floor(samples.length / width));
    for (let x = 0; x < width; x++) {
      const idx = Math.floor(x * step);
      if (idx >= samples.length) break;
      const y = midY + samples[idx] * (height / 2 * 0.8);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Center line
    ctx.strokeStyle = '#1a1a3a';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [samples, width, height]);

  return <canvas ref={canvasRef} width={width} height={height} style={{ width, height, borderRadius: 4 }} />;
};

export const MicMonitorPanel: React.FC = () => {
  const micDiag = useStore(s => s.micDiag);
  const containerRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = React.useState({ width: 300, height: 80 });

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) {
        setCanvasSize({
          width: Math.floor(entry.contentRect.width - 16),
          height: 80,
        });
      }
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  if (!micDiag) {
    return (
      <div style={{ padding: 12, fontSize: 11, color: '#555', fontStyle: 'italic' }}>
        Start listening to see mic diagnostics…
      </div>
    );
  }

  // Level meter: map -80..0 dB to 0..100%
  const levelPct = Math.max(0, Math.min(100, ((micDiag.rmsDb + 80) / 80) * 100));
  const barColor = micDiag.rmsDb > -20 ? '#ff6b4a' : micDiag.rmsDb > -40 ? '#eab308' : '#4a9eff';

  return (
    <div style={{ padding: 6, fontSize: 11, fontFamily: 'monospace', height: '100%', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Level meter */}
      <div style={{ background: '#080812', borderRadius: 4, padding: '6px 8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ color: '#888' }}>RMS Level</span>
          <span style={{ color: barColor, fontWeight: 700 }}>{micDiag.rmsDb.toFixed(1)} dB</span>
        </div>
        <div style={{ background: '#1a1a2a', borderRadius: 3, height: 12, overflow: 'hidden' }}>
          <div style={{
            width: `${levelPct}%`, height: '100%',
            background: barColor,
            borderRadius: 3,
            transition: 'width 100ms ease',
            opacity: 0.8,
          }} />
        </div>
      </div>

      {/* Key metrics grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        <div style={{ background: '#080812', borderRadius: 4, padding: '4px 8px' }}>
          <div style={{ color: '#555', fontSize: 9 }}>Peak</div>
          <div style={{ color: '#ff6b4a', fontWeight: 700 }}>{(micDiag.peak * 1000).toFixed(1)}×10⁻³</div>
        </div>
        <div style={{ background: '#080812', borderRadius: 4, padding: '4px 8px' }}>
          <div style={{ color: '#555', fontSize: 9 }}>Zero-Xing Rate</div>
          <div style={{ color: '#4a9eff', fontWeight: 700 }}>{(micDiag.zeroCrossingRate * 100).toFixed(1)}%</div>
        </div>
        <div style={{ background: '#080812', borderRadius: 4, padding: '4px 8px' }}>
          <div style={{ color: '#555', fontSize: 9 }}>Sample Rate</div>
          <div style={{ color: '#ccc' }}>{(micDiag.sampleRate / 1000).toFixed(1)} kHz</div>
        </div>
        <div style={{ background: '#080812', borderRadius: 4, padding: '4px 8px' }}>
          <div style={{ color: '#555', fontSize: 9 }}>Calibration</div>
          <div style={{ color: '#ccc' }}>×{micDiag.calibrationFactor.toFixed(3)}</div>
        </div>
      </div>

      {/* Context state */}
      <div style={{ display: 'flex', gap: 12, background: '#080812', borderRadius: 4, padding: '4px 8px' }}>
        <span style={{ color: '#555' }}>AudioCtx:</span>
        <span style={{
          color: micDiag.ctxState === 'running' ? '#5eea5e' : '#eab308',
          fontWeight: 700,
        }}>
          {micDiag.ctxState}
        </span>
        <span style={{ color: '#555' }}>|</span>
        <span style={{ color: '#888' }}>Buffer: {micDiag.recentSamples.length} samples</span>
      </div>

      {/* Waveform */}
      <div ref={containerRef} style={{ flex: 1, minHeight: 60, background: '#080812', borderRadius: 4, padding: 4 }}>
        <div style={{ color: '#555', fontSize: 9, marginBottom: 2 }}>Recent Waveform</div>
        <WaveformCanvas
          samples={micDiag.recentSamples}
          width={canvasSize.width}
          height={canvasSize.height}
        />
      </div>
    </div>
  );
};

import React from 'react';

interface MeterBarProps {
  val: number;
  peak: number;
  color: string;
  label: string;
}

export function MeterBar({ val, peak, color, label }: MeterBarProps) {
  const pct = Math.min(100, Math.max(0, (val / Math.max(peak || 1e-12, 1e-6)) * 100));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
      <span style={{ fontSize: 11, color: '#6b7280', minWidth: 55, textAlign: 'right' }}>
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 6,
          background: 'rgba(255,255,255,0.04)',
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            borderRadius: 3,
            transition: 'width 80ms linear',
          }}
        />
      </div>
      <span
        style={{
          fontSize: 11,
          fontFamily: 'SF Mono, ui-monospace, monospace',
          color,
          minWidth: 50,
          textAlign: 'right',
        }}
      >
        {val.toFixed(1)}
      </span>
    </div>
  );
}

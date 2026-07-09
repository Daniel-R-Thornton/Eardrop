import React from 'react';

interface StatProps {
  label: string;
  value: string;
  color?: string;
}

export function Stat({ label, value, color = '#e0e0ee' }: StatProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span
        style={{
          fontSize: 10,
          color: '#6b7280',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 15,
          fontWeight: 600,
          fontFamily: 'SF Mono, ui-monospace, monospace',
          color,
        }}
      >
        {value}
      </span>
    </div>
  );
}

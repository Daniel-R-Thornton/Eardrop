import React from 'react';

export interface ReadoutProps {
  label: string;
  value: string | number;
  unit?: string;
}

export function Readout({ label, value, unit }: ReadoutProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="lab-panel__title" style={{ padding: 0, background: 'transparent', border: 0 }}>
        {label}
      </span>
      <span className="lab-readout">
        {value}
        {unit ? ` ${unit}` : ''}
      </span>
    </div>
  );
}

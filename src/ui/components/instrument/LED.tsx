import React from 'react';

export interface LEDProps {
  on: boolean;
  label?: string;
}

export function LED({ on, label }: LEDProps) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={`lab-led${on ? ' is-on' : ''}`} />
      {label && <span className="lab-readout" style={{ fontSize: 11 }}>{label}</span>}
    </span>
  );
}

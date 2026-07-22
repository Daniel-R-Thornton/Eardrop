import React from 'react';

export interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
}

export function Slider({ label, min, max, step, value, onChange, unit }: SliderProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="lab-panel__title" style={{ padding: 0, background: 'transparent', border: 0 }}>
        {label}: {value}
        {unit ? ` ${unit}` : ''}
      </span>
      <input
        type="range"
        className="lab-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

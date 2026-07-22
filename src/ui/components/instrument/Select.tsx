import React from 'react';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}

export function Select({ label, value, options, onChange }: SelectProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="lab-panel__title" style={{ padding: 0, background: 'transparent', border: 0 }}>
        {label}
      </span>
      <select className="lab-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

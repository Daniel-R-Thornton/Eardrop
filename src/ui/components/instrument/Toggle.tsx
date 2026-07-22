import React from 'react';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}

export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <input
        type="checkbox"
        className="lab-toggle"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="lab-panel__title" style={{ padding: 0, background: 'transparent', border: 0 }}>
        {label}
      </span>
    </label>
  );
}

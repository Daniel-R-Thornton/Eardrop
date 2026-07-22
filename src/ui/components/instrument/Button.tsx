import React from 'react';

export interface ButtonProps {
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
}

export function Button({ onClick, children, primary, disabled }: ButtonProps) {
  return (
    <button
      type="button"
      className={`lab-btn${primary ? ' lab-btn--accent' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

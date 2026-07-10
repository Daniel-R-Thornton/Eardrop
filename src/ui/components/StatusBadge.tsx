import React from 'react';

interface StatusBadgeProps {
  type: string;
  msg: string;
}

export function StatusBadge({ type, msg }: StatusBadgeProps) {
  const kind = type === 'success' || type === 'error' ? type : 'info';
  return (
    <div className="ed-badge" data-kind={kind}>
      <span className="dot" />
      {msg}
    </div>
  );
}

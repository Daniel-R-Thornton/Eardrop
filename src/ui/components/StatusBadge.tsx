import React from 'react';

interface StatusBadgeProps {
  type: string;
  msg: string;
}

const COLORS: Record<string, { bg: string; fg: string }> = {
  info: { bg: 'rgba(108,108,255,0.15)', fg: '#6c6cff' },
  success: { bg: 'rgba(52,211,153,0.15)', fg: '#34d399' },
  error: { bg: 'rgba(248,113,113,0.15)', fg: '#f87171' },
};

export function StatusBadge({ type, msg }: StatusBadgeProps) {
  const s = COLORS[type] ?? COLORS.info;
  return (
    <div
      style={{
        marginTop: 6,
        padding: '6px 12px',
        borderRadius: 8,
        fontSize: 13,
        background: s.bg,
        color: s.fg,
        fontWeight: 500,
      }}
    >
      {msg}
    </div>
  );
}

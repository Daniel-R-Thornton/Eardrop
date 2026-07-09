import React from 'react';

interface CardProps {
  title?: string;
  accent?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function Card({ title, accent = '#6c6cff', children, style }: CardProps) {
  return (
    <div
      style={{
        background: 'var(--surface)',
        borderRadius: 12,
        border: '1px solid var(--border)',
        overflow: 'hidden',
        ...style,
      }}
    >
      {title && (
        <div
          style={{
            padding: '10px 16px',
            fontSize: 13,
            fontWeight: 600,
            color: accent,
            borderBottom: '1px solid var(--border)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {title}
        </div>
      )}
      <div style={{ padding: title ? '14px 16px' : '16px' }}>{children}</div>
    </div>
  );
}

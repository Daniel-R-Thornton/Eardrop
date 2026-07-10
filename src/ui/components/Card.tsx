import React from 'react';

interface CardProps {
  title?: string;
  accent?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function Card({ title, accent = 'var(--signal)', children, style }: CardProps) {
  return (
    <div className="ed-card" style={style}>
      {title && (
        <div className="ed-card-title" style={{ '--accent': accent } as React.CSSProperties}>
          <span className="tick" />
          {title}
        </div>
      )}
      <div style={{ padding: title ? '14px 16px' : '16px' }}>{children}</div>
    </div>
  );
}

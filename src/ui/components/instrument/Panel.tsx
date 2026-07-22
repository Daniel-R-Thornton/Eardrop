import React from 'react';

export interface PanelProps {
  title: string;
  children: React.ReactNode;
  span?: number;
}

export function Panel({ title, children, span }: PanelProps) {
  return (
    <section className="lab-panel" style={span ? { gridColumn: `span ${span}` } : undefined}>
      <h3 className="lab-panel__title">{title}</h3>
      <div style={{ padding: 8 }}>{children}</div>
    </section>
  );
}

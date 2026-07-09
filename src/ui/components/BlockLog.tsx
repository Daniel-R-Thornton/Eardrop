/**
 * BlockLog.tsx — Shows recent block decode results.
 */

import React from 'react';
import type { BlockLogEntry } from '../Store';

interface Props {
  entries: BlockLogEntry[];
}

export const BlockLog: React.FC<Props> = ({ entries }) => {
  const typeColors: Record<string, string> = {
    SQUAWK: '#5eead4',
    CONFIG: '#4a9eff',
    DICTIONARY: '#f472b6',
    PAYLOAD: '#eab308',
    EOF: '#44cc88',
  };

  return (
    <div style={{ fontSize: 10, fontFamily: 'monospace', lineHeight: 1.6 }}>
      {entries.slice(-8).map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: typeColors[e.type] || '#888' }}>{e.type.padEnd(10)}</span>
          <span style={{ color: '#888' }}>{e.len}B</span>
          <span style={{ color: '#555' }}>
            {((performance.now() - e.time) / 1000).toFixed(1)}s ago
          </span>
        </div>
      ))}
    </div>
  );
};

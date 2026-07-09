/**
 * SentinelScanPanel.tsx — Sentinel scanner shift register visualizer.
 *
 * Consumes Store.sentinelScan from the RxEngine SentinelScanner.
 * Shows the 24-bit sliding window and match status.
 */

import React, { useRef, useEffect } from 'react';
import { useStore } from '../../Store';

export const SentinelScanPanel: React.FC = () => {
  const scanHistory = useStore(s => s.sentinelScan);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [scanHistory.length]);

  const maxVisible = 32;
  const visible = scanHistory.slice(-maxVisible);
  const latest = visible[visible.length - 1];

  return (
    <div style={{ padding: 6, fontSize: 11, fontFamily: 'monospace', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ color: '#888', marginBottom: 4, fontSize: 10 }}>
        Sentinel Scanner — 24-bit sliding window
      </div>

      {/* Current state */}
      {latest && (
        <div style={{
          background: '#0a0a14', borderRadius: 4, padding: '6px 8px', marginBottom: 6,
          display: 'flex', gap: 12, alignItems: 'center',
        }}>
          <span style={{ color: '#aaa' }}>Shift Reg:</span>
          <span style={{ color: '#fff', fontWeight: 700, fontFamily: 'monospace' }}>
            0x{latest.shiftReg.toString(16).padStart(6, '0')}
          </span>
          <span style={{
            color: latest.matched ? '#5eea5e' : '#888',
            fontWeight: latest.matched ? 700 : 400,
          }}>
            {latest.matched ? '🛡 MATCH!' : 'scanning…'}
          </span>
          <span style={{ color: '#555' }}>phase: {latest.phase}</span>
          {latest.matched && latest.shiftReg === 0xE79FE7 && (
            <span style={{ color: '#5eea5e', fontWeight: 700 }}>SENTINEL 0xE79FE7</span>
          )}
          {latest.matched && latest.shiftReg === 0x186018 && (
            <span style={{ color: '#f472b6', fontWeight: 700 }}>INVERTED 0x186018</span>
          )}
        </div>
      )}

      {/* Timeline of recent shift register states */}
      <div style={{ color: '#666', fontSize: 9, marginBottom: 2 }}>Recent states (bit | reg → match):</div>
      <div
        ref={scrollRef}
        style={{
          flex: 1, overflowX: 'auto', overflowY: 'hidden',
          background: '#080812', borderRadius: 4, padding: '4px 6px',
          whiteSpace: 'nowrap',
        }}
      >
        {visible.length === 0 && (
          <div style={{ color: '#555', fontStyle: 'italic' }}>Waiting for data…</div>
        )}
        {visible.map((entry, i) => {
          const regStr = '0x' + entry.shiftReg.toString(16).padStart(6, '0');
          return (
            <div
              key={i}
              style={{
                display: 'inline-block',
                background: entry.matched ? '#0a3a0a' : entry.phase === 'COLLECT' ? '#1a1a2a' : '#0a0a14',
                border: '1px solid ' + (entry.matched ? '#2a8a2a' : '#1a1a2a'),
                borderRadius: 3,
                padding: '2px 4px',
                margin: '0 2px 2px 0',
                fontSize: 9,
                color: entry.matched ? '#5eea5e' : '#888',
                minWidth: 120,
                textAlign: 'center',
              }}
              title={`bit ${entry.bit} | reg=${regStr} | ${entry.phase}`}
            >
              <div>{regStr}</div>
              <div style={{ fontSize: 8, color: '#555' }}>
                {entry.phase}{entry.matched ? ' ✓' : ''}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

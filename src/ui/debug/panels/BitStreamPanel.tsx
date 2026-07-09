/**
 * BitStreamPanel.tsx — Live byte-level hex dump with framing annotations.
 *
 * Consumes Store.debugByteStream from the RxEngine SentinelScanner.
 * Color-coded by phase:
 *   SENTINEL (0xFF/0xF0) — green
 *   DATA (collected bytes) — white hex on dark bg
 *   FRAME (frame complete) — yellow marker
 */

import React, { useRef, useEffect } from 'react';
import { useStore } from '../../Store';

export const BitStreamPanel: React.FC = () => {
  const byteStream = useStore(s => s.debugByteStream);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to latest
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [byteStream.length]);

  const maxVisible = 80;
  const visible = byteStream.slice(-maxVisible);

  return (
    <div style={{ padding: 6, fontSize: 11, fontFamily: 'monospace', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ color: '#888', marginBottom: 4, fontSize: 10 }}>
        Byte Stream ({byteStream.length} entries, showing last {visible.length})
      </div>
      <div
        ref={scrollRef}
        style={{
          flex: 1, overflowY: 'auto', background: '#080812', borderRadius: 4,
          padding: '4px 6px', lineHeight: '18px',
        }}
      >
        {visible.length === 0 && (
          <div style={{ color: '#555', fontStyle: 'italic' }}>Waiting for data…</div>
        )}
        {visible.map((entry, i) => {
          const isSentinel = entry.phase === 'SENTINEL';
          const isFrame = entry.phase === 'FRAME';
          const isData = entry.phase === 'DATA';
          const bgColor = isSentinel ? '#0a2a0a' : isFrame ? '#2a2a00' : 'transparent';
          const fgColor = isSentinel ? '#5eea5e' : isFrame ? '#eaea5e' : isData ? '#ccc' : '#888';

          return (
            <div
              key={byteStream.length - visible.length + i}
              style={{
                background: bgColor,
                color: fgColor,
                borderRadius: 3,
                padding: '0 4px',
                display: 'flex',
                gap: 12,
              }}
            >
              <span style={{ color: '#555', width: 50, flexShrink: 0 }}>
                @{entry.bitOffset}
              </span>
              <span style={{ width: 60, flexShrink: 0, color: isSentinel ? '#5eea5e' : isFrame ? '#eaea5e' : '#fff' }}>
                0x{entry.byte.toString(16).padStart(2, '0')}
              </span>
              <span style={{
                color: isSentinel ? '#5eea5e' : isFrame ? '#eaea5e' : '#888',
                fontWeight: isSentinel || isFrame ? 700 : 400,
              }}>
                {isSentinel && '🛡 SENTINEL'}
                {isFrame && '📦 FRAME'}
                {isData && `DATA byte`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

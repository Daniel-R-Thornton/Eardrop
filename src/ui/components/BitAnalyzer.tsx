/**
 * BitAnalyzer.tsx — Per-frame bit table with binary visualization.
 *
 * Shows the last N decoded frames as a compact bit-table with
 * color-coded phase bits, constellation alignment, and error markers.
 */

import React, { useMemo } from 'react';
import type { DecoderInfo } from '../Store';
import { TONE_COLORS } from '../../modem/types';

interface Props {
  debug: DecoderInfo | null;
  historyMax?: number;
}

export function BitAnalyzer({ debug, historyMax = 8 }: Props) {
  // Extract bit pattern into per-tone display
  const bitTable = useMemo(() => {
    if (!debug) return null;
    const pat = debug.bitPattern;
    const rows = [];
    for (let t = 0; t < 4; t++) {
      const ampBit = (pat >> (7 - t * 2)) & 1;
      const phaseBit = (pat >> (6 - t * 2)) & 1;
      rows.push({
        tone: t,
        ampBit,
        phaseBit,
        energy: debug.energies[t],
        relI: debug.relI[t],
        flip: phaseBit === 1,
      });
    }
    return rows;
  }, [debug]);

  if (!bitTable) {
    return (
      <div style={{ fontSize: 10, color: '#5858a0', padding: '8px 0', textAlign: 'center' }}>
        Waiting for signal…
      </div>
    );
  }

  return (
    <div style={{ fontFamily: 'monospace', fontSize: 10 }}>
      {/* Compact bit table header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '40px 30px 30px 60px 1fr',
          gap: '1px',
          background: '#1e1e3a',
          borderRadius: 4,
          overflow: 'hidden',
          marginBottom: 4,
        }}
      >
        <div style={thStyle}>Tone</div>
        <div style={thStyle}>Amp</div>
        <div style={thStyle}>Ph</div>
        <div style={thStyle}>I</div>
        <div style={thStyle}>Energy</div>
      </div>

      {bitTable.map((row) => {
        const ePct = Math.min(
          100,
          (row.energy / Math.max(...(debug?.energies ?? [1]), 1e-12)) * 100,
        );
        return (
          <div
            key={row.tone}
            style={{
              display: 'grid',
              gridTemplateColumns: '40px 30px 30px 60px 1fr',
              gap: '1px',
              background: '#1e1e3a',
              marginBottom: 2,
              borderRadius: 3,
              overflow: 'hidden',
            }}
          >
            <div style={{ ...tdStyle, color: TONE_COLORS[row.tone], fontWeight: 600 }}>
              {row.tone}
            </div>
            <div style={{ ...tdStyle, color: row.ampBit ? '#44cc88' : '#484870' }}>
              {row.ampBit}
            </div>
            <div
              style={{
                ...tdStyle,
                color: row.flip ? '#ff6b4a' : '#6c6cff',
                fontWeight: row.flip ? 700 : 400,
              }}
            >
              {row.phaseBit}
            </div>
            <div
              style={{
                ...tdStyle,
                color: row.relI > 0 ? '#44cc88' : row.relI < 0 ? '#ff6b4a' : '#484870',
              }}
            >
              {row.relI.toFixed(3)}
            </div>
            <div style={tdStyle}>
              <div
                style={{
                  width: `${ePct}%`,
                  height: 6,
                  background: TONE_COLORS[row.tone],
                  borderRadius: 2,
                  transition: 'width 50ms linear',
                }}
              />
            </div>
          </div>
        );
      })}

      {/* Frame bit pattern display */}
      <div
        style={{
          marginTop: 6,
          padding: '4px 6px',
          background: '#07070e',
          borderRadius: 3,
          border: '1px solid #1e1e3a',
          fontSize: 9,
          color: '#5858a0',
        }}
      >
        Frame:{' '}
        <span style={{ color: '#e0e0ee', letterSpacing: '0.05em' }}>
          {debug?.bitPattern?.toString(2).padStart(8, '0')}
        </span>
        <span style={{ marginLeft: 8, color: '#484870' }}>
          (0x{debug?.bitPattern?.toString(16).padStart(2, '0') || '00'})
        </span>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  background: '#11111e',
  padding: '3px 4px',
  fontSize: 8,
  color: '#5858a0',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  background: '#11111e',
  padding: '3px 4px',
  display: 'flex',
  alignItems: 'center',
};

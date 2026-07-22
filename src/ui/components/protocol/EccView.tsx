import { T } from '../../theme/labaccent/tokens';

interface EccViewProps {
  before: number[];
  after: number[];
  scheme: string;
  capacity: number;
}

export function EccView({ before, after, scheme, capacity }: EccViewProps) {
  const parityCount = after.length - before.length;

  // Format bytes as inline hex (max 24 bytes, uppercase 2-digit hex, ellipsis if longer)
  const formatHex = (bytes: number[]) => {
    const maxBytes = 24;
    const hex = bytes
      .slice(0, maxBytes)
      .map(b => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');
    return bytes.length > maxBytes ? `${hex} …` : hex;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Two-column layout: RAW and CODED */}
      <div style={{ display: 'flex', gap: 12 }}>
        {/* RAW column */}
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 10,
              color: T.panelInk,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
              fontWeight: 600,
            }}
          >
            RAW
          </div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 11,
              backgroundColor: T.screenBg,
              color: T.panelInk,
              padding: 8,
              borderRadius: T.radius,
              overflow: 'auto',
              whiteSpace: 'nowrap',
            }}
          >
            {formatHex(before)}
          </div>
          <div style={{ fontSize: 9, color: '#666', marginTop: 4 }}>
            {before.length} byte{before.length !== 1 ? 's' : ''}
          </div>
        </div>

        {/* CODED column */}
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 10,
              color: T.panelInk,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
              fontWeight: 600,
            }}
          >
            CODED
          </div>
          <div
            style={{
              fontFamily: T.mono,
              fontSize: 11,
              backgroundColor: T.screenBg,
              color: T.phosphor,
              padding: 8,
              borderRadius: T.radius,
              overflow: 'auto',
              whiteSpace: 'nowrap',
            }}
          >
            {formatHex(after)}
          </div>
          <div style={{ fontSize: 9, color: '#666', marginTop: 4 }}>
            {after.length} byte{after.length !== 1 ? 's' : ''}
          </div>
        </div>
      </div>

      {/* Readout line: scheme, parity count, and capacity */}
      <div
        style={{
          fontSize: 11,
          color: T.panelInk,
          fontFamily: T.mono,
          lineHeight: 1.5,
        }}
      >
        <span style={{ fontWeight: 600 }}>{scheme}</span>
        <span style={{ color: T.amber, marginLeft: 8, fontWeight: 600 }}>
          +{parityCount} parity byte{parityCount !== 1 ? 's' : ''}
        </span>
        <span style={{ marginLeft: 8 }}>corrects up to {capacity}</span>
      </div>
    </div>
  );
}

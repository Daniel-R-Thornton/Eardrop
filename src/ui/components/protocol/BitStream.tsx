import { T } from '../../theme/labaccent/tokens';

interface BitStreamProps {
  bytes: number[];
  max?: number;
}

export function BitStream({ bytes, max = 512 }: BitStreamProps) {
  // Convert bytes to bit string (MSB-first per byte)
  const bits: string[] = [];
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1 ? '1' : '0');
    }
  }

  // Truncate if needed
  const isTruncated = bits.length > max;
  const displayBits = bits.slice(0, max);

  return (
    <div
      style={{
        fontFamily: T.mono,
        fontSize: 10,
        backgroundColor: T.screenBg,
        color: T.panelInk,
        padding: 8,
        borderRadius: T.radius,
        overflow: 'auto',
        wordBreak: 'break-all',
        lineHeight: 1.4,
      }}
    >
      <span style={{ letterSpacing: '2px' }}>
        {displayBits.map((bit, idx) => (
          <span
            key={idx}
            style={{
              color: bit === '1' ? T.phosphor : T.phosphorDim,
              fontWeight: bit === '1' ? 600 : 400,
            }}
          >
            {bit}
          </span>
        ))}
        {isTruncated && <span style={{ color: T.phosphorDim }}>…</span>}
      </span>
    </div>
  );
}

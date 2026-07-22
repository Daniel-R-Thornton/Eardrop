import { T } from '../../theme/labaccent/tokens';

interface ByteMapProps {
  bytes: number[];
  highlight?: [number, number];
}

export function ByteMap({ bytes, highlight }: ByteMapProps) {
  const COLS = 16;

  return (
    <div
      style={{
        fontFamily: T.mono,
        fontSize: 11,
        backgroundColor: T.screenBg,
        color: T.panelInk,
        padding: 8,
        borderRadius: T.radius,
        overflow: 'auto',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${COLS}, minmax(24px, 1fr))`,
          gap: 2,
          width: 'fit-content',
        }}
      >
        {bytes.map((byte, idx) => {
          const hex = byte.toString(16).toUpperCase().padStart(2, '0');
          const isHighlighted =
            highlight && idx >= highlight[0] && idx < highlight[1];

          return (
            <div
              key={idx}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 24,
                height: 18,
                backgroundColor: isHighlighted ? T.phosphor : 'transparent',
                color: isHighlighted ? T.screenBg : T.panelInk,
                fontWeight: isHighlighted ? 600 : 400,
                borderRadius: 2,
              }}
            >
              {hex}
            </div>
          );
        })}
      </div>
    </div>
  );
}

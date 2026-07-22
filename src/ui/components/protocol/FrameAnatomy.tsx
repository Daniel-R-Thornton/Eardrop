import { T, TONE_TRACE } from '../../theme/labaccent/tokens';
import type { FrameField } from '../../../modem/protocol/captureTypes';

export interface FrameAnatomyProps {
  fields: FrameField[];
}

export function FrameAnatomy({ fields }: FrameAnatomyProps) {
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: 48,
        gap: 1,
        borderRadius: T.radius,
        overflow: 'hidden',
        backgroundColor: T.screenBg,
      }}
    >
      {fields.map((field, idx) => {
        const color = TONE_TRACE[idx % TONE_TRACE.length];
        const byteCount = field.length;
        const firstBytes =
          field.bytes.length > 0
            ? field.bytes.slice(0, 4).map(b => `${b.toString(16).padStart(2, '0')}`).join(' ')
            : '—';

        return (
          <div
            key={field.name}
            style={{
              flexGrow: byteCount,
              backgroundColor: color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 8px',
              cursor: 'default',
            }}
            title={`${field.name}: ${firstBytes}`}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: T.screenBg,
                textAlign: 'center',
                textShadow: `0 0 2px rgba(0,0,0,0.5)`,
              }}
            >
              <div>{field.name}</div>
              <div style={{ fontSize: 10, fontWeight: 400 }}>
                {byteCount} byte{byteCount !== 1 ? 's' : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

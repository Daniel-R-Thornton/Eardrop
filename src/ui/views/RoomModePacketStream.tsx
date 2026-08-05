/**
 * RoomModePacketStream.tsx — the live packet list for RoomMode.tsx, split
 * out to keep the parent file under the codebase's ~450-line guideline.
 * Newest-first scroller; fills whatever height its parent gives it
 * (`height: 100%` + `overflowY: auto`) so it gets real vertical room in the
 * room-mode layout instead of a small fixed box, while staying readable at
 * the full 200-entry ring buffer.
 */
import type { ChatterPacket } from '../Store';
import { T, TONE_TRACE } from '../theme/labaccent/tokens';
import { hex, formatAgoShort } from './roomModeFormat';

// All colours here come from the shared token vocabulary (T / TONE_TRACE) —
// no ad hoc hex values — so packet kinds stay visually consistent with the
// rest of the lab-accent theme.
const KIND_COLOR: Record<ChatterPacket['kind'], string> = {
  probe: T.cyan,
  welcome: T.phosphor,
  report: T.amber,
  fileComing: TONE_TRACE[3],
  bye: T.led,
  file: TONE_TRACE[4],
  text: TONE_TRACE[5],
  ack: TONE_TRACE[7],
};

export function PacketStream({ packets, now }: { packets: ChatterPacket[]; now: number }) {
  if (packets.length === 0) {
    return (
      <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6 }}>
        (no packets observed yet)
      </div>
    );
  }
  const rows = [...packets].reverse();
  return (
    <div style={{ height: '100%', overflowY: 'auto', fontFamily: T.mono, fontSize: 11 }}>
      {rows.map((p) => (
        <div
          key={p.seq}
          style={{
            display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 0',
            borderBottom: '1px solid rgba(0,0,0,0.06)',
          }}
        >
          <span style={{ color: p.dir === 'tx' ? T.phosphor : T.cyan, width: 12 }}>{p.dir === 'tx' ? '↑' : '↓'}</span>
          <span style={{ color: KIND_COLOR[p.kind], minWidth: 62 }}>{p.kind}</span>
          <span style={{ opacity: 0.75, minWidth: 30 }}>{p.peerId !== undefined ? hex(p.peerId) : '--'}</span>
          <span style={{ opacity: 0.6, minWidth: 46, textAlign: 'right' }}>{p.bytes}B</span>
          <span style={{ opacity: 0.5, minWidth: 34, textAlign: 'right' }}>{formatAgoShort(now - p.tMs)}</span>
          {p.note && <span style={{ opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.note}</span>}
        </div>
      ))}
    </div>
  );
}

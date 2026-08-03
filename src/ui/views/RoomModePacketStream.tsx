/**
 * RoomModePacketStream.tsx — the live packet list for RoomMode.tsx, split
 * out to keep the parent file under the codebase's ~450-line guideline.
 * Newest-first scroller, capped visually (fixed height + overflow) so it
 * stays readable even with the full 200-entry ring buffer behind it.
 */
import type { ChatterPacket } from '../Store';
import { T } from '../theme/labaccent/tokens';

const KIND_COLOR: Record<ChatterPacket['kind'], string> = {
  probe: T.cyan,
  welcome: T.phosphor,
  report: T.amber,
  fileComing: '#ff7ad0',
  bye: T.led,
  file: '#b3ff3c',
};

function hex(id: number): string {
  return id.toString(16).padStart(2, '0');
}

function formatAgoShort(ms: number): string {
  const sec = Math.max(0, ms / 1000);
  if (sec < 1) return 'now';
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const min = sec / 60;
  return `${min.toFixed(0)}m`;
}

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
    <div style={{ maxHeight: 460, overflowY: 'auto', fontFamily: T.mono, fontSize: 11 }}>
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

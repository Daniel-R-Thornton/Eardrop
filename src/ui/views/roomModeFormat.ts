/**
 * roomModeFormat.ts — tiny display-only formatters shared by RoomMode.tsx and
 * RoomModePacketStream.tsx (device-id hex, relative-age strings). Kept out of
 * ChatterPanel.tsx deliberately — that file is owned by a different task and
 * still has its own near-identical copies; this only de-dupes within room mode.
 */

export function hex(id: number): string {
  return id.toString(16).padStart(2, '0');
}

/** "3m 12s ago" style — used for roster / node tooltips. */
export function formatAgo(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s ago`;
}

/** "54 B" / "1.2 kB" style — used on received-file rows in the transcript.
 *  Transfers over this medium are small by nature, so kB is the last unit
 *  worth spelling. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} kB`;
}

/** "12s" / "3m" style — compact, used in the packet stream's timestamp column. */
export function formatAgoShort(ms: number): string {
  const sec = Math.max(0, ms / 1000);
  if (sec < 1) return 'now';
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const min = sec / 60;
  return `${min.toFixed(0)}m`;
}

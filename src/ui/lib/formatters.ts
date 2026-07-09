/**
 * src/ui/lib/formatters.ts — Display formatting utilities.
 */

/** Format byte count to human-readable string. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Format a dB value for display. */
export function formatDb(db: number): string {
  if (db === -Infinity || db < -100) return '−∞';
  return `${db.toFixed(1)} dB`;
}

/** Format a number with fixed precision. */
export function formatFixed(value: number, decimals: number = 1): string {
  return value.toFixed(decimals);
}

/** Format hex bytes with optional truncation. */
export function formatPayloadHex(bytes: Uint8Array, maxLen: number = 32): string {
  const hex = Array.from(bytes.slice(0, maxLen))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  if (bytes.length > maxLen) return `${hex}…`;
  return hex;
}

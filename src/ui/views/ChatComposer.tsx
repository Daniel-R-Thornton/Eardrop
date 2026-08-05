/**
 * ChatComposer — recipient picker, text input, byte counter, send.
 *
 * The picker sets the target for BOTH text and file sends, so "who am I
 * addressing" is answered in one place. Addressed does NOT mean private:
 * every device in earshot demodulates the transmission, the target id only
 * decides who acts on it. Nothing here may suggest otherwise.
 *
 * The counter is in BYTES because the cap is: packText rejects a payload over
 * TEXT_MAX_BYTES, and an emoji spends 4 of them while counting characters
 * would show 1. Refusing at the boundary is better than truncating, which can
 * split a UTF-8 codepoint and put invalid bytes on the air.
 */
import { useState, type CSSProperties } from 'react';
import { TEXT_MAX_BYTES, textByteLength } from '../../modem/protocol/controlFrame';
import { T } from '../theme/labaccent/tokens';
import { hex } from './roomModeFormat';

/** Smallest comfortable touch target — this page is driven from a phone. */
const CONTROL_MIN_HEIGHT = 44;

export function ChatComposer({
  targetId, onTargetChange, nodeIds, onSend, disabledReason,
}: {
  targetId: number;
  onTargetChange: (id: number) => void;
  nodeIds: number[];
  onSend: (text: string) => void;
  disabledReason: string | null;
}) {
  const [text, setText] = useState('');
  const bytes = textByteLength(text);
  const overCap = bytes > TEXT_MAX_BYTES;
  const blocked = disabledReason !== null;
  const canSend = !blocked && !overCap && text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
  };

  const control: CSSProperties = {
    fontFamily: T.mono, fontSize: 12, minHeight: CONTROL_MIN_HEIGHT,
    background: T.panel, color: T.panelInk,
    border: `1px solid ${T.panelEdge}`, borderRadius: T.radius, padding: '4px 8px',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '0 0 auto' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          style={{ ...control, flex: '0 0 auto', cursor: 'pointer' }}
          value={String(targetId)}
          onChange={(e) => onTargetChange(Number(e.target.value))}
          aria-label="message recipient"
        >
          <option value="0">room</option>
          {nodeIds.map((id) => (
            <option key={id} value={String(id)}>{hex(id)}</option>
          ))}
        </select>
        <span style={{
          fontFamily: T.mono, fontSize: 10,
          color: overCap ? T.led : T.panelInk, opacity: overCap ? 1 : 0.7,
        }}>
          {bytes} / {TEXT_MAX_BYTES} bytes
        </span>
      </div>

      {disabledReason && (
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.led }}>{disabledReason}</div>
      )}

      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          style={{ ...control, flex: '1 1 auto', minWidth: 0 }}
          value={text}
          placeholder="type a message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <button
          type="button"
          style={{
            ...control, flex: '0 0 auto', cursor: canSend ? 'pointer' : 'not-allowed',
            opacity: canSend ? 1 : 0.5, color: canSend ? T.phosphor : T.panelInk,
          }}
          disabled={!canSend}
          onClick={submit}
        >
          send
        </button>
      </div>
    </div>
  );
}

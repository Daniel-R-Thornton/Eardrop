/**
 * NicknameField — the one control that names this device.
 *
 * Shared by RoomMode and ChatterPanel rather than duplicated: the field owns a
 * real constraint (a 12-byte airtime budget, see NICKNAME_MAX_BYTES) and two
 * copies would drift on how they enforce and display it. Both UIs write the
 * same localStorage key, so a name set in either shows up in the other.
 *
 * Sanitizes on CHANGE, not on blur, so the box always shows exactly what will
 * go out on the air — including the byte cap biting. A field that accepts
 * "Daniel's Pixel!" and silently transmits "daniels-pixe" would be lying about
 * what the room will see.
 */
import { useState } from 'react';
import { T } from '../theme/labaccent/tokens';
import {
  NICKNAME_MAX_BYTES, defaultNickname, getNickname, setNickname,
} from '../../lib/identity';

const enc = new TextEncoder();

/**
 * Matches the 44px floor every other control in room mode uses (the chat input,
 * the recipient select, every button). Room mode is driven from a phone, so a
 * 32px field was the one thumb target on screen below the floor.
 */
const TARGET_PX = 44;

export function NicknameField() {
  // Seeded from storage once; this state is the source of truth for the input
  // thereafter. Not in the Store because nothing else writes it, and
  // RoomProtocol reads it live off `deps.nickname()` when it builds a WELCOME.
  const [name, setName] = useState(() => getNickname());
  const used = enc.encode(name).length;

  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 6, minWidth: 0,
        fontFamily: T.mono, fontSize: 11,
      }}
    >
      <span style={{ opacity: 0.7, flex: '0 0 auto' }}>this device</span>
      <input
        aria-label="nickname for this device"
        value={name}
        placeholder={defaultNickname()}
        onChange={(e) => setName(setNickname(e.target.value))}
        style={{
          // minWidth:0 so the field can shrink inside a wrapping flex row
          // instead of forcing the row wider than a phone screen.
          flex: '1 1 auto', minWidth: 0,
          minHeight: TARGET_PX, fontFamily: T.mono, fontSize: 11,
          color: T.phosphor, background: 'rgba(0,0,0,0.35)',
          border: `1px solid ${T.phosphor}`, borderRadius: 3, padding: '4px 6px',
        }}
      />
      {/* The cap is short enough to hit by accident, so it is always visible
       *  rather than only complaining once a name is truncated. */}
      <span style={{ opacity: 0.5, flex: '0 0 auto' }}>{`${used}/${NICKNAME_MAX_BYTES}B`}</span>
    </label>
  );
}

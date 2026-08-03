/**
 * ChatterPanel.tsx — the chatter room panel: join/leave, room state, member
 * roster (ID, last-heard age, claimed range once known), and the last
 * RoomProtocol error. Talks to app.ts purely through the existing
 * dispatch/Store event bus (see TxPanel.tsx/SettingsPanel.tsx) — it never
 * imports ChatterController directly.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../Store';
import { T } from '../theme/labaccent/tokens';
import { Panel } from '../components/instrument/Panel';
import { Button } from '../components/instrument/Button';
import { LED } from '../components/instrument/LED';

const dispatch = (type: string) => window.dispatchEvent(new CustomEvent(type));

/** Members past this age are still listed but shown as aged-out — display-only;
 *  RoomProtocol owns its own membership timeout separately. */
const AGE_OUT_MS = 5 * 60 * 1000;

/** Safety ceiling on the Join/Leave button's disabled window — the button
 *  re-enables as soon as `chatterOn` actually flips (the normal path), but a
 *  join/leave that throws before touching the store must not leave it stuck
 *  disabled forever. `ChatterController.joinRoom`/`leaveRoom` themselves are
 *  idempotency-guarded (see chatterController.ts), so this is a UX debounce
 *  against rapid double-clicks, not the sole re-entry guard. */
const PENDING_TIMEOUT_MS = 15000;

function formatAgo(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s ago`;
}

function hex(id: number): string {
  return id.toString(16).padStart(2, '0');
}

export function ChatterPanel() {
  const s = useStore((x) => x);
  // "last heard Ns ago" should keep ticking even when nothing else in the
  // store changes — re-render once a second.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Join/Leave dispatches a fire-and-forget custom event — there's no promise
  // to await here, so track "a click is in flight" locally and disable the
  // button until the store reflects the outcome (chatterOn flips) or the
  // safety timeout elapses. Without this, a second click mid-join re-enters
  // ChatterController.joinRoom() while chatterOn is still false.
  const [pending, setPending] = useState(false);
  const wasOn = useRef(s.chatterOn);
  useEffect(() => {
    if (wasOn.current !== s.chatterOn) {
      wasOn.current = s.chatterOn;
      setPending(false);
    }
  }, [s.chatterOn]);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(false), PENDING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [pending]);

  const now = performance.now();
  const title = s.chatterOn ? `CHATTER — ${s.chatterState.toUpperCase()}` : 'CHATTER';

  return (
    <Panel title={title}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <Button
          primary={!s.chatterOn}
          disabled={pending}
          onClick={() => {
            setPending(true);
            dispatch(s.chatterOn ? 'eardrop-chatter-leave' : 'eardrop-chatter-join');
          }}
        >
          {pending ? '…' : s.chatterOn ? '⏏ LEAVE ROOM' : '☎ JOIN ROOM'}
        </Button>
        <LED on={s.chatterOn} label={s.chatterOn ? s.chatterState.toUpperCase() : 'OFF'} />
        {s.chatterOn && (
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.7 }}>
            id {hex(s.chatterDeviceId)}
          </span>
        )}
      </div>

      {s.chatterError && (
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.led, marginBottom: 8 }}>
          ⚠ {s.chatterError}
        </div>
      )}

      {!s.chatterOn && (
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6 }}>
          Join the room to see who else is around.
        </div>
      )}

      {s.chatterOn && (
        s.chatterMembers.length === 0 ? (
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6 }}>
            (no other members heard yet)
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontFamily: T.mono, fontSize: 11 }}>
            {s.chatterMembers.map((m) => {
              const ageMs = now - m.lastHeardMs;
              const agedOut = ageMs > AGE_OUT_MS;
              const hasClaim = m.claimLowHz !== undefined && m.claimHighHz !== undefined;
              return (
                <li
                  key={m.deviceId}
                  style={{
                    marginBottom: 4,
                    opacity: agedOut ? 0.4 : 1,
                    textDecoration: agedOut ? 'line-through' : 'none',
                  }}
                >
                  <span style={{ color: T.phosphor }}>{hex(m.deviceId)}</span>
                  {` · last heard ${formatAgo(ageMs)}`}
                  {hasClaim && (
                    <span style={{ opacity: 0.7 }}>
                      {` · claim ${m.claimLowHz!.toFixed(0)}–${m.claimHighHz!.toFixed(0)}Hz`}
                    </span>
                  )}
                  {agedOut && <span style={{ opacity: 0.7 }}> · aged out</span>}
                </li>
              );
            })}
          </ul>
        )
      )}

      {s.chatterOn && s.chatterState === 'idle' && (
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6, marginTop: 8 }}>
          drop a file anywhere to broadcast
        </div>
      )}
    </Panel>
  );
}

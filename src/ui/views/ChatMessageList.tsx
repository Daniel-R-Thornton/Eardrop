/**
 * ChatMessageList — the room's chat transcript.
 *
 * Reads only from the store's ChatMessage records; no protocol logic. The
 * per-message status line exists because this medium is slow and half duplex:
 * one device transmitting blocks every other, a message can be several
 * seconds of audio, and it may sit queued behind a file transfer before any
 * of that starts. Naming what the radio is doing turns a long wait from a
 * suspected freeze into visible progress.
 */
import { type CSSProperties } from 'react';
import { type ChatMessage } from '../Store';
import { T } from '../theme/labaccent/tokens';
import { textAirSeconds } from './chatAirTime';
import { hex } from './roomModeFormat';

/**
 * States in which the outbox can actually transmit. Anywhere else a queued
 * message is genuinely held — see the Outbox's canTransmit gate — so calling
 * it "sending" would be a lie the operator would eventually catch.
 */
const TRANSMIT_READY_STATES = ['idle', 'joinWait'];

function statusLine(m: ChatMessage, roomState: string, nowMs: number): string | null {
  if (m.dir === 'rx') return null; // delivery state is only ours to know
  if (m.state === 'delivered') return `✓✓ delivered to ${m.ackedBy.length}`;
  if (m.state === 'failed') return '✗ failed — no reply';
  const elapsedS = Math.max(0, Math.round((nowMs - m.tMs) / 1000));
  return TRANSMIT_READY_STATES.includes(roomState)
    ? `⏳ sending — ${textAirSeconds(m.text).toFixed(1)}s of audio · ${elapsedS}s`
    : `⏳ waiting for a clear moment · ${elapsedS}s`;
}

export function ChatMessageList({
  messages, ownDeviceId, roomState, nowMs, onResend,
}: {
  messages: ChatMessage[];
  ownDeviceId: number;
  roomState: string;
  nowMs: number;
  onResend: (text: string) => void;
}) {
  const row: CSSProperties = { fontFamily: T.mono, fontSize: 12, marginBottom: 8 };
  const meta: CSSProperties = { fontFamily: T.mono, fontSize: 10, opacity: 0.7, marginLeft: 8 };

  if (messages.length === 0) {
    return (
      <div style={{ ...row, opacity: 0.6, padding: 8 }}>
        no messages yet — say something to the room
      </div>
    );
  }

  return (
    <div style={{ overflowY: 'auto', minHeight: 0, flex: '1 1 auto', padding: 8 }}>
      {messages.map((m) => {
        const mine = m.dir === 'tx';
        const status = statusLine(m, roomState, nowMs);
        return (
          <div key={m.seq} style={row}>
            <span style={{ color: mine ? T.amber : T.phosphor }}>
              {mine ? 'you' : hex(m.senderId)}
            </span>
            {m.targetId !== 0 && (
              <span style={meta}>{mine ? `→ ${hex(m.targetId)}` : 'to you'}</span>
            )}
            <div style={{ color: T.panelInk, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {m.text}
            </div>
            {status && (
              <div style={{ ...meta, marginLeft: 0 }}>
                {status}
                {m.state === 'failed' && (
                  <button
                    type="button"
                    onClick={() => onResend(m.text)}
                    style={{
                      marginLeft: 8, minHeight: 28, padding: '2px 8px',
                      fontFamily: T.mono, fontSize: 10, cursor: 'pointer',
                      background: 'transparent', color: T.amber,
                      border: `1px solid ${T.panelEdge}`, borderRadius: 4,
                    }}
                  >
                    resend
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

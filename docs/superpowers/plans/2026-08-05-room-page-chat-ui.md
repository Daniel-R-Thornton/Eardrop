# Room Page Chat UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make text messaging reachable from the room page, and make that page work on a phone.

**Architecture:** The room page becomes one vertical stack — graph, two buttons, three collapsible debug panels, chat, composer — replacing the two-column grid whose fixed 340 px track is what breaks a phone. A single column is inherently responsive, so there is one structure at every width; viewport width is read once, only to seed four collapsed/expanded booleans. Chat lives in its own component file beside the existing `RoomModePacketStream.tsx`.

**Tech Stack:** React 19, TypeScript, Vitest with jsdom, `@testing-library/react`. No new dependencies.

Spec: `docs/superpowers/specs/2026-08-05-room-page-chat-ui-design.md`

## Global Constraints

- Run `npm run typecheck`, `npm run test`, and `npm run lint` before every commit. `npm run test` has 3 known-failing BPSK Doppler/stress cases in `src/modem/test/pipeline.test.ts` — those may stay red; **nothing else may go red.** `npm run lint` baseline is 16 errors / 395 warnings; introduce no new errors. `npm run typecheck` must be zero errors — it is the ONLY gate that typechecks, since Vitest transpiles via esbuild and ESLint is not type-aware.
- **`Array.prototype.at` is unavailable.** This repo targets ES2020 with no `lib` override, so `.at(-1)` fails typecheck with TS2550. Use `arr[arr.length - 1]`. Do not edit `tsconfig.json`. This has already cost two tasks on earlier plans.
- Component tests need the `// @vitest-environment jsdom` pragma as the file's first line, and use `render` from `@testing-library/react` — see `src/ui/components/instrument/instrument.test.tsx` for the established shape.
- The text cap is **254 UTF-8 bytes, not characters.** An emoji is 4 bytes, an accented letter 2. Always measure with `textByteLength` from `controlFrame.ts`.
- Scope is the room page. The only permitted change outside `src/ui/views/` is one event listener in `src/ui/app.ts`.
- The UI must not imply security. Anything in earshot can read the room and a `senderId` is 8 bits with no proof of identity — no lock icons, no "secure"/"private" language. "DM" means addressed, not confidential.
- Conventional Commits. Comments explain *why* and match the surrounding file's density — this codebase writes long explanatory comments. Do not strip existing comments; update any your change makes false. **Stale prose has been a review finding on nearly every task of the two preceding plans.**

## File Structure

Create:
- `src/ui/views/viewport.ts` — `isWideViewport()`, a one-shot width read. Not a hook: it is only ever used to seed initial state, so it has no lifecycle and cannot go stale.
- `src/ui/views/CollapsibleSection.tsx` — controlled collapsible panel. Renders children **only when open**, which is what stops a hidden graph canvas being measured.
- `src/ui/views/chatAirTime.ts` — `textAirSeconds(text)`, derived from the protocol's own exported constants so it cannot drift from the wire format.
- `src/ui/views/ChatMessageList.tsx` — the message list and its per-message status lines.
- `src/ui/views/ChatComposer.tsx` — recipient picker, text input, byte counter, send button.
- Tests: `viewport.test.ts`, `CollapsibleSection.test.tsx`, `chatAirTime.test.ts`, `ChatMessageList.test.tsx`, `ChatComposer.test.tsx`, all in `src/ui/views/`.

Modify:
- `src/ui/views/RoomMode.tsx` — single-column restructure, collapsibles, button row, chat mount, larger touch targets (Task 4)
- `src/ui/app.ts` — one `eardrop-chatter-text` listener (Task 4)

---

### Task 1: Viewport read and the collapsible primitive

**Files:**
- Create: `src/ui/views/viewport.ts`, `src/ui/views/CollapsibleSection.tsx`
- Test: `src/ui/views/viewport.test.ts`, `src/ui/views/CollapsibleSection.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `WIDE_VIEWPORT_MIN_PX = 760`
  - `isWideViewport(): boolean`
  - `CollapsibleSection(props: { title: string; summary?: string; open: boolean; onToggle: () => void; children: ReactNode })`

- [ ] **Step 1: Write the failing tests**

Create `src/ui/views/viewport.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { isWideViewport, WIDE_VIEWPORT_MIN_PX } from './viewport';

afterEach(() => { vi.unstubAllGlobals(); });

describe('isWideViewport', () => {
  it('reports wide when the media query matches', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q }));
    expect(isWideViewport()).toBe(true);
  });

  it('reports narrow when it does not match', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }));
    expect(isWideViewport()).toBe(false);
  });

  it('queries the documented breakpoint', () => {
    let asked = '';
    vi.stubGlobal('matchMedia', (q: string) => { asked = q; return { matches: true, media: q }; });
    isWideViewport();
    expect(asked).toBe(`(min-width: ${WIDE_VIEWPORT_MIN_PX}px)`);
  });

  it('defaults to wide when matchMedia is unavailable', () => {
    // Defaulting to WIDE is deliberate: on a desktop-like environment with no
    // matchMedia the debug panels should be open, and a wrong guess is one
    // click to fix rather than a hidden panel nobody knows exists.
    vi.stubGlobal('matchMedia', undefined);
    expect(isWideViewport()).toBe(true);
  });
});
```

Create `src/ui/views/CollapsibleSection.test.tsx`:

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CollapsibleSection } from './CollapsibleSection';

describe('CollapsibleSection', () => {
  it('shows the title and summary', () => {
    const { getByText } = render(
      <CollapsibleSection title="ROSTER" summary="2 nodes" open={false} onToggle={() => {}}>
        <div>hidden</div>
      </CollapsibleSection>,
    );
    expect(getByText('ROSTER')).toBeTruthy();
    expect(getByText('2 nodes')).toBeTruthy();
  });

  it('does not render children while closed', () => {
    // Load-bearing, not cosmetic: RoomMode's graph canvas is sized by a
    // ResizeObserver, and leaving it mounted in a hidden box would have the
    // observer measuring zero and the canvas never coming back.
    const { queryByText } = render(
      <CollapsibleSection title="GRAPH" open={false} onToggle={() => {}}>
        <div>canvas</div>
      </CollapsibleSection>,
    );
    expect(queryByText('canvas')).toBeNull();
  });

  it('renders children while open', () => {
    const { getByText } = render(
      <CollapsibleSection title="GRAPH" open onToggle={() => {}}>
        <div>canvas</div>
      </CollapsibleSection>,
    );
    expect(getByText('canvas')).toBeTruthy();
  });

  it('calls onToggle when the header is activated', () => {
    const onToggle = vi.fn();
    const { getByRole } = render(
      <CollapsibleSection title="PACKETS" open={false} onToggle={onToggle}>
        <div>list</div>
      </CollapsibleSection>,
    );
    getByRole('button').click();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('exposes its open state to assistive tech', () => {
    const { getByRole } = render(
      <CollapsibleSection title="PACKETS" open onToggle={() => {}}>
        <div>list</div>
      </CollapsibleSection>,
    );
    expect(getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/views/viewport.test.ts src/ui/views/CollapsibleSection.test.tsx`

Expected: FAIL — neither module exists, so both files error on import.

- [ ] **Step 3: Write `viewport.ts`**

```typescript
/**
 * One-shot viewport width read, used ONLY to seed initial collapsed/expanded
 * state on the room page.
 *
 * Deliberately a plain function rather than a hook. The room page has one
 * layout at every width — a single vertical column — so nothing needs to
 * re-render on resize. What width decides is whether the debug panels start
 * open, and after first paint the operator's own toggles own that. A hook
 * would invite re-reading this value later and fighting those toggles.
 */

/** Below this, the debug panels start collapsed. 760px sits above every phone
 *  in portrait and below any real desktop window, so it separates "a screen
 *  where three stacked debug panels bury the chat" from "a screen with room
 *  for them". */
export const WIDE_VIEWPORT_MIN_PX = 760;

export function isWideViewport(): boolean {
  // Default WIDE when matchMedia is missing (jsdom without a stub, an odd
  // embedding): an unexpectedly open panel is one click to close, while an
  // unexpectedly closed one is a feature the operator may never find.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(`(min-width: ${WIDE_VIEWPORT_MIN_PX}px)`).matches;
}
```

- [ ] **Step 4: Write `CollapsibleSection.tsx`**

```tsx
/**
 * CollapsibleSection — a titled panel on the room page that can be shut to a
 * one-line strip.
 *
 * Controlled: the parent owns the boolean, because RoomMode seeds all four
 * sections from `isWideViewport()` at mount and needs them in its own state.
 *
 * Children are NOT rendered while closed, which matters beyond saving a few
 * nodes: the graph and spectrum canvases size themselves from a
 * ResizeObserver, and a canvas left mounted inside a hidden box measures zero
 * and does not recover when reopened. Unmounting means it re-measures cleanly.
 *
 * `summary` is what the section says while shut — a node count, a packet
 * count — so collapsing it costs the number but not the awareness.
 */
import { type CSSProperties, type ReactNode } from 'react';
import { T } from '../theme/labaccent/tokens';

/** Minimum header height. 44px is the smallest comfortable touch target, and
 *  this page is meant to be driven from a phone. */
const HEADER_MIN_HEIGHT = 44;

export function CollapsibleSection({
  title, summary, open, onToggle, children,
}: {
  title: string;
  summary?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const header: CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    width: '100%', minHeight: HEADER_MIN_HEIGHT, padding: '4px 10px',
    background: T.panel, border: `1px solid ${T.panelEdge}`, borderRadius: T.radius,
    fontFamily: T.mono, fontSize: 11, letterSpacing: 1, color: T.panelInk,
    cursor: 'pointer', textAlign: 'left',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <button type="button" style={header} onClick={onToggle} aria-expanded={open}>
        <span>{open ? '▾' : '▸'} {title}</span>
        {summary !== undefined && <span style={{ opacity: 0.7 }}>{summary}</span>}
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: '1 1 auto' }}>
          {children}
        </div>
      )}
    </div>
  );
}
```

Read `src/ui/theme/labaccent/tokens.ts` first to confirm the token names `T.panel`, `T.panelEdge`, `T.panelInk`, `T.mono` and `T.radius` exist — `RoomMode.tsx` uses all of them, so they should, but check rather than assume.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/ui/views/viewport.test.ts src/ui/views/CollapsibleSection.test.tsx`

Expected: PASS, 9 tests.

- [ ] **Step 6: Run the gates and commit**

Run: `npm run typecheck && npm run test && npm run lint`

```bash
git add src/ui/views/viewport.ts src/ui/views/CollapsibleSection.tsx src/ui/views/viewport.test.ts src/ui/views/CollapsibleSection.test.tsx
git commit -m "feat(room): collapsible panel primitive and a one-shot viewport read

The room page becomes one vertical column at every width, so nothing needs
to re-render on resize — width only decides whether the debug panels start
open. isWideViewport is therefore a plain function, not a hook, so nothing
is tempted to re-read it and fight the operator's own toggles.

CollapsibleSection unmounts its children while shut rather than hiding
them: the graph and spectrum canvases size from a ResizeObserver, and one
left mounted in a hidden box measures zero and does not recover."
```

---

### Task 2: Message list and air-time estimate

**Files:**
- Create: `src/ui/views/chatAirTime.ts`, `src/ui/views/ChatMessageList.tsx`
- Test: `src/ui/views/chatAirTime.test.ts`, `src/ui/views/ChatMessageList.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `textAirSeconds(text: string): number`
  - `ChatMessageList(props: { messages: ChatMessage[]; ownDeviceId: number; roomState: string; nowMs: number; onResend: (text: string) => void })`

`ChatMessage` is already exported from `src/ui/Store.ts` as
`{ seq: number; msgId: number; senderId: number; targetId: number; text: string; tMs: number; dir: 'tx' | 'rx'; ackedBy: number[]; state: 'sending' | 'delivered' | 'failed' }`.

- [ ] **Step 1: Write the failing tests**

Create `src/ui/views/chatAirTime.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { textAirSeconds } from './chatAirTime';

describe('textAirSeconds', () => {
  it('estimates a two-character message at about two seconds', () => {
    // The 1.5s preamble dominates a short message: 43 wire bytes is only
    // ~0.55s of symbols. This is why a two-character message is not cheap.
    expect(textAirSeconds('ok')).toBeCloseTo(2.05, 2);
  });

  it('estimates a 140-byte message at about 6.6 seconds', () => {
    expect(textAirSeconds('x'.repeat(140))).toBeCloseTo(6.65, 2);
  });

  it('estimates a maximum-length message at about 10.4 seconds', () => {
    expect(textAirSeconds('x'.repeat(254))).toBeCloseTo(10.45, 2);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // One emoji is 4 bytes, so it costs the same air as 'aaaa'.
    expect(textAirSeconds('🦻')).toBeCloseTo(textAirSeconds('aaaa'), 6);
  });

  it('grows monotonically with length', () => {
    expect(textAirSeconds('x'.repeat(200))).toBeGreaterThan(textAirSeconds('x'.repeat(100)));
  });
});
```

Create `src/ui/views/ChatMessageList.test.tsx`:

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ChatMessageList } from './ChatMessageList';
import type { ChatMessage } from '../Store';

const base: ChatMessage = {
  seq: 1, msgId: 3, senderId: 1, targetId: 0, text: 'hello room',
  tMs: 1000, dir: 'tx', ackedBy: [], state: 'sending',
};
const props = { ownDeviceId: 1, roomState: 'idle', nowMs: 5000, onResend: () => {} };

describe('ChatMessageList', () => {
  it('shows an empty hint when there are no messages', () => {
    const { getByText } = render(<ChatMessageList messages={[]} {...props} />);
    expect(getByText(/no messages/i)).toBeTruthy();
  });

  it('shows air time and elapsed for a message being sent from an idle room', () => {
    const { getByText } = render(<ChatMessageList messages={[base]} {...props} />);
    expect(getByText('hello room')).toBeTruthy();
    // 4s elapsed (5000 - 1000), and 'hello room' is 10 bytes.
    expect(getByText(/sending/i).textContent).toMatch(/4s/);
  });

  it('says the message is waiting when the room cannot transmit', () => {
    // The outbox only drains in idle and joinWait. Anywhere else the message
    // is genuinely held, and saying "sending" would be a lie.
    const { getByText } = render(
      <ChatMessageList messages={[base]} {...props} roomState="collecting" />,
    );
    expect(getByText(/waiting for a clear moment/i)).toBeTruthy();
  });

  it('shows the ack count when delivered', () => {
    const delivered: ChatMessage = { ...base, state: 'delivered', ackedBy: [5, 6] };
    const { getByText } = render(<ChatMessageList messages={[delivered]} {...props} />);
    expect(getByText(/delivered to 2/i)).toBeTruthy();
  });

  it('offers a resend on a failed message and passes the original text back', () => {
    const onResend = vi.fn();
    const failed: ChatMessage = { ...base, state: 'failed' };
    const { getByRole } = render(
      <ChatMessageList messages={[failed]} {...props} onResend={onResend} />,
    );
    getByRole('button', { name: /resend/i }).click();
    expect(onResend).toHaveBeenCalledWith('hello room');
  });

  it('renders a received message with no status line', () => {
    // Delivery state is only meaningful for messages WE sent.
    const rx: ChatMessage = { ...base, dir: 'rx', senderId: 9, state: 'delivered' };
    const { getByText, queryByText } = render(<ChatMessageList messages={[rx]} {...props} />);
    expect(getByText('hello room')).toBeTruthy();
    expect(queryByText(/delivered to/i)).toBeNull();
  });

  it('labels a DM with its addressee', () => {
    const dm: ChatMessage = { ...base, targetId: 0xa7 };
    const { getByText } = render(<ChatMessageList messages={[dm]} {...props} />);
    expect(getByText(/a7/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/ui/views/chatAirTime.test.ts src/ui/views/ChatMessageList.test.tsx`

Expected: FAIL — neither module exists.

- [ ] **Step 3: Write `chatAirTime.ts`**

Every number comes from the protocol's own exported constants so this cannot drift from the wire format.

```typescript
/**
 * How long a text message takes to transmit, in seconds.
 *
 * Shown per message because the wait is the feature's defining property, not
 * an implementation detail: a group message with read receipts is roughly
 * 8-14 s of airtime in a three-device room and the room is blocked
 * throughout. A bare spinner over that reads as a freeze.
 *
 * DERIVED, not copied. Every term comes from the constant the transmitter
 * itself uses, so a change to the frame layout or the handshake band shows up
 * here automatically rather than silently making this display wrong.
 */
import {
  CONTROL_HEADER_WIRE, controlPayloadWireSize, textByteLength,
} from '../../modem/protocol/controlFrame';
import { OFDM_HANDSHAKE, OFDM_SYMBOL_MS, OFDM_CP_MS } from '../../modem/types';

/** Bytes per OFDM symbol on the handshake band: QPSK puts 2 bits on each
 *  tone, so 4 tones carry a byte. Same expression the band-card sizing uses. */
const BYTES_PER_SYMBOL = Math.max(1, Math.floor(OFDM_HANDSHAKE.toneCount / 4));

/** One symbol is its FFT window plus the cyclic prefix. */
const SYMBOL_MS = OFDM_SYMBOL_MS + OFDM_CP_MS;

/**
 * Chirp + settle + training ahead of the payload. A wire constant of the
 * handshake segment, and the reason a two-character message costs ~2 s rather
 * than ~0.5 s.
 */
const PREAMBLE_MS = 1500;

/** The 1-byte msgId a TEXT payload carries ahead of the text itself. */
const MSG_ID_BYTES = 1;

export function textAirSeconds(text: string): number {
  const payloadLen = MSG_ID_BYTES + textByteLength(text);
  const wireBytes = CONTROL_HEADER_WIRE + controlPayloadWireSize(payloadLen);
  const symbols = Math.ceil(wireBytes / BYTES_PER_SYMBOL);
  return (symbols * SYMBOL_MS + PREAMBLE_MS) / 1000;
}
```

If `OFDM_SYMBOL_MS` or `OFDM_CP_MS` is not exported from `src/modem/types.ts`, stop and tell me rather than hardcoding 20 and 5 — the point of this module is that the numbers are derived.

- [ ] **Step 4: Write `ChatMessageList.tsx`**

```tsx
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
```

`hex` is already exported from `src/ui/views/roomModeFormat.ts` and used by `RoomMode.tsx`; confirm its signature before importing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/ui/views/chatAirTime.test.ts src/ui/views/ChatMessageList.test.tsx`

Expected: PASS, 12 tests.

- [ ] **Step 6: Run the gates and commit**

Run: `npm run typecheck && npm run test && npm run lint`

```bash
git add src/ui/views/chatAirTime.ts src/ui/views/ChatMessageList.tsx src/ui/views/chatAirTime.test.ts src/ui/views/ChatMessageList.test.tsx
git commit -m "feat(room): chat transcript with per-message radio status

The wait is this medium's defining property, not a detail to hide: a group
message with receipts is 8-14 s of airtime with the room blocked
throughout, so a bare spinner reads as a freeze. Each pending message
names what the radio is doing and for how long.

A message is only called 'sending' in the states where the outbox can
actually transmit; anywhere else it is genuinely held and says so.
textAirSeconds derives every term from the transmitter's own constants so
the estimate cannot drift from the wire format."
```

---

### Task 3: Composer, recipient picker, byte counter

**Files:**
- Create: `src/ui/views/ChatComposer.tsx`
- Test: `src/ui/views/ChatComposer.test.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `ChatComposer(props: { targetId: number; onTargetChange: (id: number) => void; nodeIds: number[]; onSend: (text: string) => void; disabledReason: string | null })`

`disabledReason` non-null disables send and is displayed. `nodeIds` are the known peers, rendered alongside a `room` option.

- [ ] **Step 1: Write the failing test**

Create `src/ui/views/ChatComposer.test.tsx`:

```typescript
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ChatComposer } from './ChatComposer';
import { TEXT_MAX_BYTES } from '../../modem/protocol/controlFrame';

const props = {
  targetId: 0,
  onTargetChange: () => {},
  nodeIds: [0xa7, 0x3f],
  onSend: () => {},
  disabledReason: null as string | null,
};

describe('ChatComposer', () => {
  it('sends the typed text and clears the input', () => {
    const onSend = vi.fn();
    const { getByRole } = render(<ChatComposer {...props} onSend={onSend} />);
    const input = getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello room' } });
    getByRole('button', { name: /send/i }).click();
    expect(onSend).toHaveBeenCalledWith('hello room');
    expect(input.value).toBe('');
  });

  it('will not send empty or whitespace-only text', () => {
    const onSend = vi.fn();
    const { getByRole } = render(<ChatComposer {...props} onSend={onSend} />);
    const send = getByRole('button', { name: /send/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(getByRole('textbox'), { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    send.click();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('counts UTF-8 bytes rather than characters', () => {
    // 10 emoji are 40 bytes but only 10 (or 20) JS string units. Counting
    // characters would let a message through that packText then throws on.
    const { getByRole, getByText } = render(<ChatComposer {...props} />);
    fireEvent.change(getByRole('textbox'), { target: { value: '🦻'.repeat(10) } });
    expect(getByText(new RegExp(`40\\s*/\\s*${TEXT_MAX_BYTES}`))).toBeTruthy();
  });

  it('allows exactly the cap and refuses one byte more', () => {
    const { getByRole } = render(<ChatComposer {...props} />);
    const input = getByRole('textbox');
    const send = getByRole('button', { name: /send/i }) as HTMLButtonElement;

    fireEvent.change(input, { target: { value: 'x'.repeat(TEXT_MAX_BYTES) } });
    expect(send.disabled).toBe(false);

    fireEvent.change(input, { target: { value: 'x'.repeat(TEXT_MAX_BYTES + 1) } });
    expect(send.disabled).toBe(true);
  });

  it('disables send and shows why when the room is not ready', () => {
    const { getByRole, getByText } = render(
      <ChatComposer {...props} disabledReason="join the room first" />,
    );
    fireEvent.change(getByRole('textbox'), { target: { value: 'hi' } });
    expect((getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(getByText('join the room first')).toBeTruthy();
  });

  it('offers the room plus every known node, and reports a change', () => {
    const onTargetChange = vi.fn();
    const { getByRole } = render(
      <ChatComposer {...props} onTargetChange={onTargetChange} />,
    );
    const picker = getByRole('combobox') as HTMLSelectElement;
    expect(picker.options.length).toBe(3); // room + two nodes
    fireEvent.change(picker, { target: { value: String(0xa7) } });
    expect(onTargetChange).toHaveBeenCalledWith(0xa7);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/views/ChatComposer.test.tsx`

Expected: FAIL — `ChatComposer` does not exist.

- [ ] **Step 3: Write `ChatComposer.tsx`**

```tsx
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
```

Note the input is **not** disabled when `disabledReason` is set — only send is. The protocol's outbox queues correctly and holds a message until the transmitter is free, so blocking typing would fight it and stop the operator drafting a reply while someone else is talking.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/views/ChatComposer.test.tsx`

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the gates and commit**

Run: `npm run typecheck && npm run test && npm run lint`

```bash
git add src/ui/views/ChatComposer.tsx src/ui/views/ChatComposer.test.tsx
git commit -m "feat(room): chat composer with a byte-accurate cap and one recipient picker

The counter is in bytes because the cap is: packText rejects a payload over
TEXT_MAX_BYTES and an emoji spends four of them, so counting characters
would let a message through that then throws. Refusing at the boundary
beats truncating, which can split a codepoint and put invalid UTF-8 on the
air.

The picker targets both text and file sends, so who you are addressing
lives in one place. Send disables when the room is not ready; the input
does not, because the outbox already queues and holds until the
transmitter frees up."
```

---

### Task 4: Restructure the room page and wire it to the controller

The page becomes one vertical column. This is also where the feature becomes reachable.

**Files:**
- Modify: `src/ui/views/RoomMode.tsx` — the layout from `:513` down, the header, the roster's send-file affordances, node hit targets
- Modify: `src/ui/app.ts` — one listener beside the existing `eardrop-chatter-join` / `eardrop-chatter-leave` / `eardrop-file` ones

**Interfaces:**
- Consumes: `isWideViewport()`, `CollapsibleSection`, `ChatMessageList`, `ChatComposer` from Tasks 1-3.
- Produces: the `eardrop-chatter-text` custom event, detail `{ text: string; targetId: number }`.

- [ ] **Step 1: Add the app.ts listener**

In `src/ui/app.ts`, beside the existing chatter listeners (around `:171-180`), following that file's exact idiom:

```typescript
// Chat text — RoomMode holds no protocol logic, so it dispatches and app.ts
// routes, same as join/leave and file selection above.
window.addEventListener('eardrop-chatter-text', ((e: CustomEvent) => {
  const { text, targetId } = e.detail as { text: string; targetId?: number };
  dlog('UI', {
    textSend: textByteLength(text),
    to: targetId || 'broadcast',
  }, { level: 'warn' });
  chatter.sendText(text, targetId ?? 0);
}) as EventListener);
```

Import `textByteLength` from `../modem/protocol/controlFrame` if it is not already imported in `app.ts`. Log the byte length rather than the text itself — the session log is shareable, and a chat message is the operator's content, not diagnostics.

- [ ] **Step 2: Replace the two-column layout**

In `RoomMode.tsx`, the block at `:513` is:

```tsx
<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 340px', gap: 12, flex: '1 1 auto', minHeight: 0 }}>
```

Replace that grid and everything inside it with a single flex column. Add the four collapsed/expanded booleans near the other `useState` calls (around `:149-162`), seeded once from `isWideViewport()`:

```tsx
// Debug panels start open on a desktop-width viewport and shut on a phone,
// then the operator's toggles own them. isWideViewport is read ONCE here for
// that seed — the layout itself is one column at every width, so nothing
// re-reads it (see viewport.ts).
const wide = isWideViewport();
const [graphOpen, setGraphOpen] = useState(true);
const [rosterOpen, setRosterOpen] = useState(wide);
const [spectrumOpen, setSpectrumOpen] = useState(wide);
const [packetsOpen, setPacketsOpen] = useState(wide);
```

The graph starts open regardless — it is the view's centrepiece, and a room page that opens showing nothing but a collapsed strip and a chat box hides what the mode is for.

Structure, top to bottom, inside the existing outer drag-and-drop `div`:

```tsx
<div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: '1 1 auto', minHeight: 0 }}>
  {/* Graph — flexes when open so it takes the slack a phone gives it */}
  <div style={{ display: 'flex', flexDirection: 'column', flex: graphOpen ? '1 1 auto' : '0 0 auto', minHeight: 0 }}>
    <CollapsibleSection
      title={`NODE GRAPH — ${s.chatterOn ? `this device is ${hex(s.chatterDeviceId)}` : 'not joined'}`}
      summary={`${members.length} node${members.length === 1 ? '' : 's'}`}
      open={graphOpen}
      onToggle={() => setGraphOpen((v) => !v)}
    >
      {/* the existing graphBoxRef div and its Screen + hit-target overlay, unchanged */}
    </CollapsibleSection>
  </div>

  {/* Two buttons */}
  <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
    <button type="button" style={actionBtn} onClick={() => document.getElementById('roommode-file')?.click()}>
      send file
    </button>
    <button
      type="button"
      style={actionBtn}
      disabled={pending !== null}
      onClick={() => { /* the existing join/leave onClick body, unchanged */ }}
    >
      {joinLeaveLabel}
    </button>
  </div>

  <CollapsibleSection title="ROSTER" summary={`${members.length} nodes`} open={rosterOpen} onToggle={() => setRosterOpen((v) => !v)}>
    {/* the existing roster list, MINUS the per-node "send file to" button */}
  </CollapsibleSection>

  <CollapsibleSection title="SPECTRUM" summary={focusMember ? `node ${hex(focusMember.deviceId)}` : 'no node selected'} open={spectrumOpen} onToggle={() => setSpectrumOpen((v) => !v)}>
    {/* the existing spectrumBoxRef div and its Screen, unchanged */}
  </CollapsibleSection>

  <CollapsibleSection title="PACKETS" summary={String(s.chatterPackets.length)} open={packetsOpen} onToggle={() => setPacketsOpen((v) => !v)}>
    {/* the existing PacketStream */}
  </CollapsibleSection>

  {/* Chat — flexes so it takes the space the collapsed panels give back */}
  <div style={{ ...panel(false), display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 160 }}>
    <div style={title}>CHAT</div>
    <ChatMessageList
      messages={s.chatterMessages}
      ownDeviceId={s.chatterDeviceId}
      roomState={s.chatterOn ? s.chatterState : 'off'}
      nowMs={now}
      onResend={sendText}
    />
    <ChatComposer
      targetId={sendTargetId}
      onTargetChange={setSendTargetId}
      nodeIds={members.map((m) => m.deviceId)}
      onSend={sendText}
      disabledReason={s.chatterOn ? null : 'join the room to send a message'}
    />
  </div>
</div>
```

Define `actionBtn` beside the existing `btn` helper, with `minHeight: 44` and `flex: '1 1 0'` so the two buttons split the width and are comfortable to tap.

- [ ] **Step 3: Add the send handler and the stale-target guard**

Beside `offerFile`:

```tsx
/** Dispatch a chat message the same way a chosen file is dispatched — as an
 *  event app.ts routes, so this view keeps no protocol logic. */
const sendText = (text: string) => {
  setLocalNotice(null);
  dlog('UI', { textSend: text.length, to: sendTargetId || 'broadcast' }, { level: 'warn' });
  window.dispatchEvent(new CustomEvent('eardrop-chatter-text', {
    detail: { text, targetId: sendTargetId },
  }));
};

// A node the operator addressed can age out of the roster while selected.
// Fall back to the room rather than leaving a target that no longer exists —
// same discipline the file path already uses when it resets to 0 after a send.
useEffect(() => {
  if (sendTargetId !== 0 && !members.some((m) => m.deviceId === sendTargetId)) {
    setSendTargetId(0);
  }
}, [members, sendTargetId]);
```

- [ ] **Step 4: Enlarge the node hit targets**

The overlay divs at `:546-549` are 24×24 px, which is well under a comfortable touch target. Change the size to 44 and the offsets to match:

```tsx
style={{
  position: 'absolute', left: x - 22, top: y - 22, width: 44, height: 44,
  borderRadius: '50%', pointerEvents: 'auto', cursor: 'pointer',
}}
```

- [ ] **Step 5: Remove the superseded file affordances**

Delete the roster's per-node `send file to {hex(...)}` button and the "drop a file anywhere to broadcast — or click to browse" hint. Both are replaced by the `send file` button plus the recipient picker. Keep the hidden `<input id="roommode-file">`, the drag-and-drop overlay, and `offerFile` — but change the picker-driven path so `offerFile` receives `sendTargetId`, which it already supports.

- [ ] **Step 6: Update the file's header comment**

`RoomMode.tsx` opens by describing a "hand-drawn constellation graph … a live packet stream, and a per-node spectrum sparkline" sized "from their container via ResizeObserver … so the graph is a genuine hero at any viewport width". That is now half false — there is no two-column layout, the panels are collapsible, and chat is part of the view. Rewrite it to describe the single column, why it is single (one structure at every width, no fixed track to break a phone), and that children unmount when a section closes so the canvases re-measure cleanly.

- [ ] **Step 7: Run the gates**

Run: `npm run typecheck && npm run test && npm run lint && npm run build`

Expected: typecheck clean, build succeeds, tests green except the 3 known BPSK failures, lint at baseline. `src/ui/views/usePipelinePlayhead.test.ts` and the other view tests must stay green.

- [ ] **Step 8: Commit**

```bash
git add src/ui/views/RoomMode.tsx src/ui/app.ts
git commit -m "feat(room): single-column room page with chat, reachable at last

The page was a two-column grid with a fixed 340px track, which on a 390px
phone left the graph about 50px. One vertical column removes the cause
rather than working around it: there is no second layout tree, because a
single column is responsive by construction.

Roster, spectrum and packets become collapsible rather than cut — they are
the debug surface for a protocol whose failures are invisible. Width is
read once to seed their initial state and never again.

Text messaging existed at the protocol level and could only be triggered
from the console. RoomMode now dispatches eardrop-chatter-text and app.ts
routes it to the controller, the same shape as join/leave and file
selection. Node hit targets go 24px to 44px for touch."
```

- [ ] **Step 9: STOP — hand back for the integration test**

Report to the operator:

> The room page is now a single column with chat, and text messaging is reachable from the UI. All automated gates pass.
>
> This is the point the whole stack becomes testable on real hardware for the first time. Three things are unverified and only a two-device run can settle them:
>
> 1. **The relocated handshake band (2600-2950 Hz) has never been measured over the air.** Every control message rides it, including chat. Compare against the old band's 21-22 dB MER; QPSK needs about 10 dB.
> 2. **A maximum-length message is ~10.4 s of audio**, four times longer than anything the control plane carried before this work. The 5 s sync watchdog was one timing assumption sized against ~3.5 s and it was found by reading; there may be another that only a long message reveals. Send a short message and a 254-byte one, and compare.
> 3. **The whole-branch review of the messaging protocol was skipped** at your instruction, so cross-task interactions are unchecked — that is the review class that caught a Critical on the control-plane branch, where a retried reply silently destroyed file transfers.
>
> Suggested first run: two devices, join, exchange a short broadcast, a DM, and a maximum-length message; then send a small file to confirm chat has not disturbed the file path.

---

## Plan self-review

**Spec coverage.** Section A (single vertical stack, grid removed) → Task 4. Section B (collapsibles, one-shot width read, children unmounted) → Tasks 1 and 4. Section C (picker targeting both paths, stale-target fallback, superseded affordances removed) → Tasks 3 and 4. Section D (message states, air-time estimate, elapsed off the existing 1 s tick, resend) → Task 2. Section E (composer, byte counter, disabled reasons, input never disabled) → Task 3. Section F (`eardrop-chatter-text` + one app.ts listener) → Task 4. Section G (file split) → the File Structure section, realised across Tasks 1-3. Risks: `.at(-1)` is in Global Constraints; the ResizeObserver hazard is handled by `CollapsibleSection` unmounting children and pinned by its test; the 24 px hit targets are Task 4 Step 4.

**Type consistency.** `isWideViewport` / `WIDE_VIEWPORT_MIN_PX` defined in Task 1, consumed in Task 4. `CollapsibleSection`'s five props are defined in Task 1 and used with those exact names in Task 4. `textAirSeconds` defined in Task 2, used only there. `ChatMessageList`'s five props and `ChatComposer`'s five props are defined in Tasks 2-3 and passed with matching names in Task 4. `ChatMessage`'s fields come from `Store.ts` unchanged. `sendText` is the same identifier for the handler in Task 4 and the `onSend`/`onResend` prop it fills.

**Known risks flagged in-plan.** Task 4 is the largest and touches a 650-line file plus `app.ts`; its steps are split so the layout swap, the send handler, the touch targets, the removals and the header comment are separately checkable. Task 2 depends on `OFDM_SYMBOL_MS`/`OFDM_CP_MS` being exported from `types.ts` and instructs the implementer to stop rather than hardcode if they are not.

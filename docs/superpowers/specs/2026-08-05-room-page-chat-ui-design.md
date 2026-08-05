# Room page — chat UI and single-column layout

Date: 2026-08-05
Status: approved, not yet implemented
Scope: the room page only (`RoomMode.tsx` and a new chat component beside it),
plus one event listener in `app.ts` to reach the controller.

Predecessors:
- `2026-08-05-chatter-control-plane-design.md` — fixed the control plane
- `2026-08-05-chatter-text-messaging-design.md` — the protocol this renders

## Why this exists

Text messaging works at the protocol level and is unreachable from the app.
`ChatterController.sendText(text, targetId)` sends, delivery state is tracked,
and a TEXT → ACK → `delivered` exchange is proven over synthesised audio — but
the only way to trigger any of it is from code or the browser console.

Separately, the room page does not work on a phone. Its layout is
`gridTemplateColumns: 'minmax(0,1fr) 340px'`, so on a 390 px screen the graph
gets about 50 px. There is no responsive infrastructure anywhere in `src/ui/` —
no media queries, no `matchMedia`, no `innerWidth` — and all layout is inline
styles. A phone is the device this whole feature exists for.

## Design

### A. One vertical stack

```
┌──────────────────────────────┐
│  ▾ NODE GRAPH                │  collapsible, flexes
│         ·a1      you         │
├──────────────────────────────┤
│ [ send file ]  [ disconnect ]│
├──────────────────────────────┤
│ ▸ ROSTER            2 nodes  │  collapsed strip
│ ▸ SPECTRUM                   │  collapsed strip
│ ▸ PACKETS               (47) │  collapsed strip
├──────────────────────────────┤
│ CHAT              [ room ▾ ] │  flexes, scrolls
│ a1   hello                   │
│ you  ready?           ✓✓2    │
├──────────────────────────────┤
│ [ type a message…  ] [ send ]│  pinned
└──────────────────────────────┘
```

A single column is inherently responsive, so the two-column grid and its fixed
340 px track are removed outright. That deletes the cause of the phone problem
rather than working around it, and it means there is **no second layout tree** —
one structure at every width.

The graph and the chat both flex; the buttons, the collapsed strips and the
composer are fixed-height. The composer stays pinned to the bottom so it never
scrolls away from the messages.

### B. Collapsible sections

Roster, spectrum, packets, and the graph itself are collapsible. Collapsed, each
shows a one-line strip carrying its own summary — node count, packet count — so
it stays informative while shut.

**Default expanded when the viewport is wide, collapsed when narrow; the
operator's toggle then overrides.** This is one `matchMedia` read for initial
state only. It is deliberately not a responsive layout system: the structure
never branches on width, only four booleans' starting values do.

Roster, spectrum and packets are kept rather than cut because they are the
debug surface for an acoustic protocol whose failures are invisible, and they
are wanted on desktop. The packet log also remains reachable through the
existing `▤ log` button, which is unchanged.

The graph is collapsible so a phone can give the whole screen to chat. On
desktop it defaults open and behaves as it does today.

### C. Recipient picker, targeting both send paths

One dropdown in the chat header: `room`, then every known node by its hex id.
It sets the target for **both** the composer and the `send file` button, so
"who am I addressing" is answered in one place instead of the two it takes
today (a roster selection for files, nothing at all for text).

This replaces the roster's `send file to <id>` button and its "drop a file
anywhere — or click to browse" hint. Drag-and-drop onto the page remains a
broadcast, unchanged.

A node that ages out of the roster while selected falls back to `room` rather
than leaving a stale target — the same discipline `sendTargetId` already uses
when it resets to 0 after a file is handed off.

### D. Message states

Each message renders from the store's `ChatMessage`
(`{ seq, msgId, senderId, targetId, text, tMs, dir, ackedBy, state }`) with a
status line derived from state the protocol already reports:

```
you  ready when you are
     ⏳ waiting for a clear moment · 3s
you  hello room
     ⏳ sending — 6.6s of audio · 4s
you  earlier message
     ✓✓ delivered to 2
you  lost one
     ✗ failed — no reply · tap to resend
```

The wait is the point. A group message with read receipts is roughly 8-14 s of
airtime in a three-device room, and the room is blocked throughout — so a bare
spinner reads as a freeze. Showing what the radio is doing, and how long it has
been doing it, makes the delay legible instead of alarming. `PHASE_TEXT` in
`RoomMode.tsx` already describes each protocol phase in plain English; the
per-message line reuses that vocabulary rather than inventing a second one.

"sending — Ns of audio" is computed from the message's own byte length using the
same arithmetic the messaging spec documents: wire bytes ÷ 2 bytes-per-symbol ×
25 ms, plus the 1.5 s preamble.

The elapsed counter uses the 1 s `setInterval` tick `RoomMode` already runs for
`formatAgo`; no new timer.

`tap to resend` on a failed message re-sends the same text, which allocates a
fresh `msgId`. It does not attempt to revive the original — the protocol has
already given up on it and its `sentText` record is gone.

Received messages show sender id and text with no status line; delivery state is
only meaningful for `dir: 'tx'`.

### E. Composer

A text input and a send button. A live counter shows bytes used against the
254-byte cap, **counting UTF-8 bytes rather than characters** — an emoji is 4
bytes and an accented letter 2, so `text.length` would let a message through
that `packText` then throws on. Send is disabled when over the cap or when the
text is empty.

Not joined disables send with the reason on screen, mirroring how the existing
drop handler explains a rejected file rather than silently swallowing it.

Send does **not** disable while the room is busy. The protocol's outbox already
queues correctly and holds a message until the transmitter is free, so blocking
input would fight it and stop the operator typing a reply while someone else is
talking.

### F. Reaching the controller

`RoomMode` holds no protocol logic — it reads the store and dispatches custom
events that `app.ts` routes, and that stays true. Sending text adds one event,
`eardrop-chatter-text`, carrying `{ text, targetId }`, with a matching listener
in `app.ts` calling `chatter.sendText(...)`. That is the same shape as the
existing `eardrop-chatter-join`, `eardrop-chatter-leave` and `eardrop-file`
listeners.

This is the one change outside the room page, and it is one listener.

### G. File structure

`RoomMode.tsx` is 650 lines and this adds a message list, a composer, a
recipient picker and four collapsible sections. The chat — list, composer and
picker — moves into its own component file beside the existing
`RoomModePacketStream.tsx`, which set that precedent. The collapsible strip is
a small local component used four times rather than four hand-rolled headers.

## Non-goals

- **The bench, `MainApp`, `BenchApp`.** Untouched beyond the existing mount.
- **Any protocol change.** The messaging protocol is complete; this renders it.
- **Message history across sessions.** The store ring is in-memory, capped at
  `CHATTER_MESSAGE_LOG_MAX` (100).
- **Typing indicators, edits, deletes, reactions.**
- **Encryption or identity.** Anything in earshot can read the room and a
  `senderId` is 8 bits with no proof of identity. The UI must not imply
  otherwise — no lock icons, no "secure" language.

## Verification

- Collapse and expand each section; the collapsed strip shows its summary.
- Initial state: expanded on a wide viewport, collapsed on a narrow one, and an
  explicit toggle survives subsequent renders.
- Byte counter at exactly 254 bytes using multi-byte characters (63 × 4-byte
  emoji + one 2-byte character), and send disabled at 255.
- The picker targets both paths: choosing a node then using `send file` sends to
  that node, and the composer sends to the same one.
- A selected node ageing out falls back to `room`.
- Each message state renders from a store fixture: `sending` with elapsed,
  `delivered` with an ack count, `failed` with a resend affordance, and a
  received message with no status line.
- `npm run typecheck`, `npm run test`, `npm run lint`, `npm run build`. The 3
  pre-existing `pipeline.test.ts` BPSK Doppler/stress failures stay red; nothing
  else may.
- Manual: the page is usable at 390 px wide and at desktop width.

## Risks

- **`Array.prototype.at` is unavailable.** This repo targets ES2020 with no
  `lib` override, so `.at(-1)` fails `npm run typecheck` with TS2550. Use
  `arr[arr.length - 1]`. This has already cost two tasks on earlier plans.
- **The graph canvas is sized by `ResizeObserver`.** Making its container
  collapsible changes its measured height, and `useMeasuredSize` already guards
  against a feedback loop by bailing on no-op sizes. A collapsed graph must
  unmount or zero-size its canvas rather than leave an observer measuring a
  hidden box.
- **Node hit targets are 24 px** absolutely-positioned divs over the canvas.
  That is below a comfortable touch target, so tapping a node on a phone will be
  fiddly. Enlarging them is in scope for this work.
- **The relocated handshake band and the text protocol are both unmeasured over
  the air.** This UI is how that measurement finally becomes possible, so
  expect the first real run to surface protocol issues that no amount of UI work
  can fix.

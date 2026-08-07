# Room mode mobile usability — design

**Date:** 2026-08-07
**Scope:** `src/ui/views/RoomMode.tsx`, `src/ui/BenchApp.tsx`. Room mode only —
not the bench, not the log panel, not the chat composer internals.

## Problem

Room mode is the surface carried across the room on a phone, and it is still
hard to use there. The operator reported two things specifically: the top bar,
and "the top radar covers the buttons, expands outside its div".

Three distinct defects, each traced to a mechanism in the code rather than
inferred from the symptom.

### 1. The node graph's overlay escapes its box and eats the primary buttons

The graph box (`RoomMode.tsx`, the `graphBoxRef` div) is `position: relative`
with **no overflow clip**. Both of its children are `position: absolute` — the
canvas, and the invisible 44px per-node hit-targets.

`graphMetrics` returns `R = min(w, h) × 0.44`, and a node's `radius` runs up to
0.92, so the outermost node centre sits `0.405 × min(w, h)` from the middle. On
a phone the box floors at `minHeight: 120`, putting that centre at y ≈ 108.6 in
a 120px box; its hit-circle, offset by half of 44, reaches y ≈ 130.6 — about
**11px below the box**.

Because those circles are *positioned* elements, CSS paints them above the
later, non-positioned action-button row regardless of DOM order. They carry
`pointerEvents: 'auto'`. So they overlay `send file` and `JOIN ROOM` and
**swallow the taps aimed at them** — the two controls that put anything on the
air. The canvas has the same escape route whenever its measured size lags a
shrink.

### 2. The top bar overflows and its buttons are too small to hit

The header row is a single `space-between` flex row with **no `flexWrap`**. Its
content: the title at 15px mono (~200px), the state pill (~60px), `▤ log`
(~50px), `← back to bench` (~110px) — roughly **430px of content in a 390px
viewport**. The status row below it has the same problem, squeezing the phase
text against `mic … · out …`.

The `btn()` factory is `padding: '3px 9px'` at fontSize 11, giving buttons about
**19px tall** — against the 44px touch floor `CollapsibleSection`,
`ChatComposer` and `actionBtn` all deliberately honour. `btn()` is also only
ever called as `btn(false)`, so its `active` and `tone` branches are dead code.

### 3. The column's bottom is unreachable on mobile

`BenchApp` pins room mode to `height: '100vh'` with `overflow: hidden`. On
mobile `100vh` is the *large* viewport — taller than what is visible beneath the
URL bar — so the bottom of the column sits off-screen with no page scroll to
recover it. There are no safe-area insets, so on a notched device the composer
can also fall under the home indicator.

## Design

### Contain the graph box

- Add `overflow: 'hidden'` to the graph box. A hard guarantee that no
  positioned descendant can paint or receive taps outside it, whatever the
  measured size does or however stale it is. This is the safety net, not the
  fix.
- Inset node placement so a **whole** hit-target fits inside the box. In
  `graphMetrics`:

  ```
  R = max(0, min(min(w,h) × 0.44, (min(w,h)/2 − NODE_TARGET_PX/2) / MAX_NODE_RADIUS))
  ```

  On a 390×120 phone box this takes R from 52.8 → 41.3, so the outermost node
  centre sits 38px out and its circle stops exactly at the edge.

  The fix belongs in `graphMetrics` and nowhere else: both the canvas draw and
  the overlay already read their geometry from it, so they cannot desync.
- `NODE_TARGET_PX` (44) and `MAX_NODE_RADIUS` (0.92) become named constants
  shared by `graphMetrics` and the hit-target style, so a later edit cannot
  reintroduce the drift between the two.

Trade-off, accepted: the radar is visibly smaller on a phone. A tighter
constellation beats unreachable primary buttons.

### Top bar — let it wrap, at a real touch size

- `flexWrap: 'wrap'` and `rowGap` on the header row, with `marginLeft: 'auto'`
  on the nav-button group. At desktop width it still reads as one
  `space-between` row; at 390px the buttons wrap onto their own line, giving the
  two stacked rows the operator asked for. The descriptive title is kept.
- **No media query and no width read.** Wrapping is responsive by construction.
  This preserves the file's existing "ONE VERTICAL COLUMN, at every width"
  doctrine — a media query would add a second layout tree to keep in step, which
  is the thing that doctrine exists to prevent.
- Replace `btn()` with a single `navBtn` const at `minHeight: 44`,
  `padding: '0 12px'`, `fontSize: 12` — the same floor the rest of the page
  uses. The dead `active`/`tone` branches go with it.
- Same `flexWrap` + `rowGap` on the status row, so `mic … · out …` drops below
  the phase text instead of crushing it. Its `alignItems: 'baseline'` stays.

### Viewport fit

- `BenchApp`: `height: inRoom ? '100dvh' : undefined`. Where `dvh` is
  unsupported the declaration is simply dropped and behaviour falls back to
  today's `minHeight: '100vh'`, so this cannot regress anything.
- `paddingBottom: 'env(safe-area-inset-bottom)'` on the room column so the chat
  composer clears the home indicator.

## Verification

No new UI tests — the operator's explicit call. Verification is the existing
suite plus a real look at the page.

- Existing suite holds at its known-good baseline: **740 pass, 3 fail**, the 3
  being the pre-existing `pipeline.test.ts` Doppler/stress failures present on a
  clean tree.
- `tsc --noEmit` clean.
- ESLint: no newly introduced errors. Pre-existing only — `app.ts` and
  `dlog.ts:310`. Use `rtk proxy npx eslint`; plain `rtk` mangles the output.
- A look at 390×844 in Chrome against the dev server. The arithmetic above says
  the taps are being stolen; the fix should be seen working, not inferred.

## Found during verification (added to scope)

Measuring the rendered page at 390×844 turned up four more defects that the
static reading had missed. All are the same family — a box allowed to shrink
below its contents, in a column that was supposed to scroll instead.

### Sections were squashed and painted over each other

`CollapsibleSection`'s root set `minHeight: 0` at the default `flex-shrink: 1`,
so in the height-constrained column **every** section compressed below its own
content height, and — the root not clipping — its contents painted over the
section beneath. Measured: the roster's text landed under the SPECTRUM header,
the spectrum's label under its canvas, the packet list's under CHAT.

Fix: a non-growing section is `flex: '0 0 auto'`. It must not shrink, because
the column that holds it is `overflowY: auto` — excess height is meant to become
scroll, not overlap.

### The graph escaped onto the buttons one level above the hit-targets

The growing section's wrapper was compressed to ~42px while the graph box inside
held its 120px floor, and the 78px difference painted over the send-file /
join-room buttons. This is the reported symptom again, above the layer the
hit-target clamp addresses.

Fix: the growing section keeps `flex: '1 1 auto'` but **no** `minHeight: 0`, so
its automatic minimum is content-based. It still absorbs surplus; it can no
longer be squashed.

### The chat panel clipped its own send button

`minHeight: 120` against a measured requirement of 203: the composer alone
renders 117px (recipient picker, byte counter, disabled notice, input row).
`ChatMessageList`'s empty-state branch also returned a non-shrinkable
`flex: 0 1 auto` div, unlike its populated branch, so nothing inside could give
way. Once `panel()` began containing its overflow the send button was clipped
away entirely — worse than the overlap it replaced.

Fix: `CHAT_MIN_HEIGHT = 184`, derived from the measurement and documented at the
constant; and the empty-state branch takes the same shrinkable contract as the
populated one.

### The bench header ran 215px off the screen

Not room mode, but on screen in room mode: `BenchApp`'s header put a wordmark
plus five action buttons in an unwrapped `space-between` row. Its buttons were
also 28px tall — and `◎ room mode` and `▤ log` are thumb targets on this
surface. The five repeated one base style, so the touch floor had to be wrong in
five places.

Fix: the same `flexWrap` + `marginLeft: auto` treatment, and one extracted
`headerBtn(active)` at `minHeight: 44`.

## Verified result

At 390×844, room mode reports **zero** overlapping boxes, **zero** horizontal
overflow, **zero** buttons under the 44px touch floor, the chat panel fitting
its contents exactly (184/184) with the send button on screen, and the column
correctly scrolling (556px of content in 422px) rather than squashing anything.

Suite at baseline: 740 pass, 3 pre-existing `pipeline.test.ts` failures.
`tsc --noEmit` clean. ESLint unchanged at 39 problems, all pre-existing in
`BenchApp.tsx` (2 unconfigured-rule errors, 37 indent warnings) — verified
identical against `git show HEAD:src/ui/BenchApp.tsx`.

## Out of scope

Chat composer internals, the log panel, the bench UI, and `style.css`'s global
tap-target sizes — room mode is inline-styled off the `T` token object and
consumes none of the `.ed-*` classes.

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

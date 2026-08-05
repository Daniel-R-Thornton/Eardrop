// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { RoomMode } from './RoomMode';

/**
 * jsdom implements neither ResizeObserver nor layout, so the two inputs
 * useMeasuredSize depends on have to be supplied by hand:
 *
 *  - a no-op ResizeObserver, so constructing one does not throw. The behaviour
 *    under test is the *initial* synchronous measurement taken when a box
 *    mounts, not a later resize callback, so the observer never needs to fire.
 *  - a non-zero getBoundingClientRect, because jsdom returns all-zeros for
 *    every element and a zero measurement is indistinguishable from the bug.
 */
function stubMeasurement() {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 400, height: 300, top: 0, left: 0, right: 400, bottom: 300, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** Narrow viewport: isWideViewport() reads matchMedia once, and false is what
 *  seeds the spectrum/roster/packets sections closed — the phone case. */
function stubNarrowViewport() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

/** Screen renders `<canvas class="lab-screen">` whether or not a 2D context
 *  exists, so counting them counts the canvases the size guards let through. */
const canvasCount = () => document.querySelectorAll('canvas.lab-screen').length;

describe('RoomMode', () => {
  beforeEach(() => {
    stubMeasurement();
    stubNarrowViewport();
  });
  // vitest.config.ts has no test.globals, so RTL's automatic afterEach(cleanup)
  // never registers itself (same reason the other view tests do this).
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('measures a section that mounts after first paint, so a reopened canvas draws', () => {
    // Regression: useMeasuredSize used to attach its observer from a
    // useLayoutEffect with [] deps, capturing ref.current ONCE at RoomMode
    // mount. On a narrow viewport SPECTRUM seeds closed, CollapsibleSection
    // does not render its children, so that ref was null and no measurement
    // ever happened. Expanding the section mounted a fresh box that nothing
    // re-measured: the size stayed {0,0}, the `w > 0 && h > 0` guard never
    // passed, and the spectrum was a permanently blank strip for the rest of
    // the session. A callback ref re-measures whenever the node changes.
    const { getByText } = render(<RoomMode onExit={() => {}} />);

    // Only the graph is open at this width, so only its canvas exists yet.
    expect(canvasCount()).toBe(1);

    fireEvent.click(getByText('SPECTRUM'));

    expect(canvasCount()).toBe(2);
  });

  it('keeps the composer mounted with the debug sections collapsed', () => {
    // The page is pinned to the viewport by BenchApp (height 100vh, overflow
    // hidden), so anything the column cannot fit is simply clipped away with no
    // page scroll to reach it. Chat is the whole point of the mode; assert its
    // controls are present in the default phone layout.
    const { getByRole } = render(<RoomMode onExit={() => {}} />);
    expect(getByRole('textbox')).toBeTruthy();
    expect(getByRole('button', { name: /^send$/i })).toBeTruthy();
  });
});

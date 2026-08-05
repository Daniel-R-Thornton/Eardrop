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

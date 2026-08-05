// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CollapsibleSection } from './CollapsibleSection';

// vitest.config.ts does not set `test.globals`, so @testing-library/react's
// own auto-cleanup (which hooks a global `afterEach`) never registers here.
// Without this, every render() in this file stays mounted into the same
// jsdom document, and the multi-render tests below start finding several
// stray <button> elements left over from earlier tests in this file.
afterEach(cleanup);

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

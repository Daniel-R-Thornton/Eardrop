// src/ui/views/LogShare.reporter.test.tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const mock = vi.hoisted(() => ({
  enabled: false,
  flush: vi.fn(async () => {}),
}));
vi.mock('../../lib/debug/logReporter', () => ({
  logReporterEnabled: () => mock.enabled,
  flushLogReporter: mock.flush,
  onLogReporterChange: () => () => {},
}));

import { LogShare } from './LogShare';

afterEach(() => { cleanup(); mock.enabled = false; mock.flush.mockClear(); });

describe('LogShare reporter row', () => {
  it('shows no PC controls when the reporter is off (Pages)', () => {
    render(<LogShare onClose={() => {}} />);
    expect(screen.queryByText(/send to pc/i)).toBeNull();
  });

  it('shows the chip and sends on click when connected', async () => {
    mock.enabled = true;
    render(<LogShare onClose={() => {}} />);
    expect(screen.getByText(/pc: connected/i)).toBeTruthy();
    fireEvent.click(screen.getByText(/send to pc/i));
    expect(mock.flush).toHaveBeenCalledOnce();
  });
});

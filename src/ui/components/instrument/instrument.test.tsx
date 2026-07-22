// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Panel } from './Panel';
import { Readout } from './Readout';

describe('instrument primitives', () => {
  it('renders a panel with title and child readout', () => {
    const { getByText } = render(
      <Panel title="TX"><Readout label="RATE" value="240" unit="B/s" /></Panel>,
    );
    expect(getByText('TX')).toBeTruthy();
    expect(getByText('RATE')).toBeTruthy();
  });
});

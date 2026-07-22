// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { FrameAnatomy } from './FrameAnatomy';

describe('FrameAnatomy', () => {
  it('renders one labeled segment per field', () => {
    const fields = [
      { name: 'sentinel', offset: 0, length: 3, bytes: [231,159,231] },
      { name: 'bch-header', offset: 3, length: 24, bytes: [] },
      { name: 'rs-payload', offset: 27, length: 208, bytes: [] },
    ];
    const { getByText } = render(<FrameAnatomy fields={fields} />);
    expect(getByText(/sentinel/i)).toBeTruthy();
    expect(getByText(/rs-payload/i)).toBeTruthy();
  });
});

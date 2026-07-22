// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MultiTrace } from './MultiTrace';
import { Spectrum } from './Spectrum';
import { Waterfall } from './Waterfall';
import { Constellation } from './Constellation';
import { ToneBars } from './ToneBars';

describe('Scope components', () => {
  it('renders MultiTrace without throwing', () => {
    const { container } = render(
      <MultiTrace
        width={200}
        height={120}
        traces={[{
          data: new Float32Array([0, 1, 0, -1]), 
          color: '#0f0', 
          label: 'CH1'
        }]}
      />
    );
    expect(container.querySelector('canvas')).toBeTruthy();
  });
  
  it('renders Spectrum without throwing', () => {
    const { container } = render(
      <Spectrum
        width={200}
        height={120}
        bins={new Float32Array([10, 20, 30, 40])}
        maxHz={2000}
      />
    );
    expect(container.querySelector('canvas')).toBeTruthy();
  });
  
  it('renders Waterfall without throwing', () => {
    const { container } = render(
      <Waterfall
        width={200}
        height={120}
        bins={new Float32Array([10, 20, 30, 40])}
      />
    );
    expect(container.querySelector('canvas')).toBeTruthy();
  });
  
  it('renders Constellation without throwing', () => {
    const { container } = render(
      <Constellation
        width={200}
        height={120}
        points={[{ i: 0.5, q: 0.5 }, { i: -0.5, q: -0.5 }]}
      />
    );
    expect(container.querySelector('canvas')).toBeTruthy();
  });
  
  it('renders ToneBars without throwing', () => {
    const { container } = render(
      <ToneBars
        width={200}
        height={120}
        energies={[10, 20, 30, 40]}
      />
    );
    expect(container.querySelector('canvas')).toBeTruthy();
  });
});
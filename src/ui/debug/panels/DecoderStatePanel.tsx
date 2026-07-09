/**
 * DecoderStatePanel.tsx — Shows live decoder state as text.
 */

import React from 'react';
import { useDecoderState } from '../hooks/useDecoderState';

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: '4px 8px',
  fontSize: 10,
  color: '#aaa',
  whiteSpace: 'pre-wrap',
  fontFamily: 'monospace',
  lineHeight: 1.4,
};

const DecoderStatePanel: React.FC = () => {
  const state = useDecoderState();

  const lines: string[] = [];
  lines.push(`Pilot: ${state.pilotFreq?.toFixed(1) ?? '?'} Hz`);
  lines.push(`Sync: ${state.consecutiveSync ?? 0} | InFrame: ${state.inFrame ? 'YES' : 'no'}`);
  lines.push(
    `Bits: ${state.bitsCollected ?? 0} | SNR: ${state.signalToNoise?.toFixed(1) ?? '?'} dB`,
  );
  lines.push(`Blocks: ${state.blocksDecoded} decoded / ${state.blocksCrcFailed} CRC fail`);
  lines.push(`Noise: ${state.noiseFloor.map((n) => n.toExponential(1)).join(' ')}`);
  lines.push(`Energies: ${state.energies.map((e) => e.toExponential(2)).join(' ')}`);

  return <pre style={preStyle}>{lines.join('\n')}</pre>;
};

export default DecoderStatePanel;

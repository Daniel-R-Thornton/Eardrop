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

  if (!state) {
    return <pre style={preStyle}>Waiting for decoder state...</pre>;
  }

  const d = state.debugInfo;
  const lines: string[] = [];

  if (d) {
    lines.push(`Pilot: ${d.pilotFreq?.toFixed(1) ?? '?'} Hz @ ${d.pilotAmp?.toExponential(2) ?? '?'}`);
    lines.push(`Sync: ${d.consecutiveSync ?? 0} | InFrame: ${d.inFrame ? 'YES' : 'no'}`);
    lines.push(`Bits: ${state.bitsCollected ?? 0} | SNR: ${d.signalToNoise?.toFixed(1) ?? '?'} dB`);
    lines.push(`Blocks: ${d.blocksDecoded ?? '?'} decoded / ${d.blocksCrcFailed ?? '?'} CRC fail`);
    lines.push(`Noise: ${(d.noiseFloor ?? []).map((n: number) => n.toExponential(1)).join(' ')}`);
    lines.push(`Energies: ${(d.energies ?? []).map((e: number) => e.toExponential(2)).join(' ')}`);
    if (d.pilotConfidence !== undefined) {
      lines.push(`Pilot conf: ${(d.pilotConfidence * 100).toFixed(0)}%`);
    }
  } else {
    lines.push('No debug info yet');
    lines.push(`Samples buffered: ${state.bitsCollected ?? 0}`);
  }

  lines.push(`Updated: ${new Date(state.timestamp).toLocaleTimeString()}`);

  return <pre style={preStyle}>{lines.join('\n')}</pre>;
};

export default DecoderStatePanel;

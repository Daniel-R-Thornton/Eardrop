/**
 * DebugContainer.tsx — Root component for the React debug UI.
 * Manages floating windows for each debug panel.
 *
 * Windows are independent, draggable, resizable, and closeable.
 * Users arrange their own layout.
 */

import React, { useCallback, useState } from 'react';
import { FloatingWindow } from './components/FloatingWindow';
import { useDecoderState } from './hooks/useDecoderState';

interface WindowState {
  id: string;
  title: string;
  visible: boolean;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
}

export const DebugContainer: React.FC = () => {
  const decoderState = useDecoderState();
  const [windows, setWindows] = useState<WindowState[]>([
    { id: 'constellation', title: 'Constellation', visible: true, position: { x: 60, y: 60 }, size: { width: 420, height: 280 }, zIndex: 1000 },
    { id: 'decoder', title: 'Decoder State', visible: true, position: { x: 500, y: 60 }, size: { width: 380, height: 280 }, zIndex: 999 },
    { id: 'bits', title: 'Bit Stream', visible: true, position: { x: 60, y: 360 }, size: { width: 420, height: 200 }, zIndex: 998 },
    { id: 'squawk', title: 'Squawk History', visible: true, position: { x: 500, y: 360 }, size: { width: 380, height: 200 }, zIndex: 997 },
  ]);
  const [nextZ, setNextZ] = useState(1005);

  const bringToFront = useCallback((id: string) => {
    setWindows(prev => prev.map(w => ({
      ...w,
      zIndex: w.id === id ? nextZ : w.zIndex,
    })));
    setNextZ(z => z + 1);
  }, [nextZ]);

  const closeWindow = useCallback((id: string) => {
    setWindows(prev => prev.map(w => ({
      ...w,
      visible: w.id === id ? false : w.visible,
    })));
  }, []);

  // ─── Constellation Panel ────────────────────────
  const constellationContent = (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
        {[0, 1, 2, 3].map(tone => (
          <div key={tone} style={{
            background: '#0a0a14',
            borderRadius: 4,
            padding: 2,
            textAlign: 'center',
            fontSize: 10,
            color: ['#4a9eff', '#ff6b4a', '#5eead4', '#f472b6'][tone],
          }}>
            {500 + tone * 200}Hz
            <div style={{ fontSize: 9, color: '#888' }}>
              I/Q: ({decoderState.relI[tone]?.toFixed(3)}, {decoderState.relQ[tone]?.toFixed(3)})
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ─── Decoder State Panel ─────────────────────────
  const decoderContent = (
    <div style={{ fontSize: 11, lineHeight: '18px' }}>
      <div>Phase: {decoderState.inFrame ? '📥 DATA' : '🔍 Listening'}</div>
      <div>Pilot: {decoderState.pilotFreq.toFixed(1)} Hz @ {decoderState.pilotAmplitude.toExponential(2)}</div>
      <div>SNR: {decoderState.signalToNoise.toFixed(1)} dB</div>
      <div>Sync: {decoderState.consecutiveSync} frames</div>
      <div>Bits: {decoderState.bitsCollected}</div>
      <div>Blocks: {decoderState.blocksDecoded} OK / {decoderState.blocksCrcFailed} CRC fail</div>
      <div style={{ marginTop: 4, fontSize: 10, color: '#888' }}>
        Floor: {decoderState.noiseFloor.map(n => n.toExponential(1)).join(' | ')}
      </div>
    </div>
  );

  // ─── Bit Stream Panel ────────────────────────────
  const bitsContent = (
    <div style={{ fontSize: 10, lineHeight: '16px' }}>
      <div style={{ color: '#888', marginBottom: 4 }}>Bits decoded per frame</div>
      <div style={{ color: '#4a9eff' }}>
        {decoderState.relI.map((_, t) => {
          const ampBit = decoderState.energies[t] > 0.01 ? 1 : 0;
          const phaseBit = decoderState.relI[t] > 0 ? 1 : 0;
          return `${ampBit}${phaseBit}`;
        }).join(' ')}
      </div>
    </div>
  );

  // ─── Squawk Panel ────────────────────────────────
  const squawkContent = (
    <div style={{ fontSize: 10, lineHeight: '16px' }}>
      <div style={{ color: '#888' }}>Squawk tracking (from debug logger)</div>
      <div style={{ color: '#5eead4', marginTop: 4 }}>
        Δ drift: tracking...
      </div>
    </div>
  );

  return (
    <>
      {windows.filter(w => w.visible).map(w => {
        let content: React.ReactNode;
        switch (w.id) {
          case 'constellation': content = constellationContent; break;
          case 'decoder': content = decoderContent; break;
          case 'bits': content = bitsContent; break;
          case 'squawk': content = squawkContent; break;
          default: content = null;
        }
        return (
          <FloatingWindow
            key={w.id}
            title={w.title}
            initialPosition={w.position}
            initialSize={w.size}
            zIndex={w.zIndex}
            onClose={() => closeWindow(w.id)}
            onFocus={() => bringToFront(w.id)}
          >
            {content}
          </FloatingWindow>
        );
      })}
    </>
  );
};

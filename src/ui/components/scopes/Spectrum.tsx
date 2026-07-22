// src/ui/components/scopes/Spectrum.tsx
import { useMemo } from 'react';
import { Screen } from '../instrument/Screen';
import { T } from '../../theme/labaccent/tokens';

export interface SpectrumProps {
  bins: Float32Array;
  maxHz: number;
  width: number;
  height: number;
}

export function Spectrum({ bins, maxHz, width, height }: SpectrumProps) {
  const draw = useMemo(() => {
    return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (!bins.length) return;
      
      const binWidth = w / bins.length;
      const maxDb = 120;
      
      // Draw spectrum bars
      ctx.fillStyle = T.phosphor;
      for (let i = 0; i < bins.length; i++) {
        const db = Math.max(0, Math.min(maxDb, bins[i]));
        const barHeight = (db / maxDb) * (h - 20); // Leave space for labels
        ctx.fillRect(i * binWidth, h - barHeight, binWidth - 1, barHeight);
      }
      
      // Draw frequency labels
      ctx.fillStyle = T.phosphorDim;
      ctx.font = '10px "SF Mono", monospace';
      ctx.textAlign = 'center';
      const labelStep = Math.max(1, Math.floor(bins.length / 4));
      for (let i = 0; i <= bins.length; i += labelStep) {
        const x = i * binWidth;
        const freq = ((i / bins.length) * maxHz).toFixed(0);
        ctx.fillText(`${freq}Hz`, x, h - 4);
      }
      ctx.textAlign = 'left';
    };
  }, [bins, maxHz]);

  return <Screen width={width} height={height} draw={draw} />;
}
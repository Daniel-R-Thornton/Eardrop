// src/ui/components/scopes/ToneBars.tsx
import { useMemo } from 'react';
import { Screen } from '../instrument/Screen';
import { TONE_TRACE } from '../../theme/labaccent/tokens';

export interface ToneBarsProps {
  energies: number[];
  width: number;
  height: number;
}

export function ToneBars({ energies, width, height }: ToneBarsProps) {
  const draw = useMemo(() => {
    return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (!energies.length) return;
      
      const barWidth = w / energies.length;
      const maxEnergy = Math.max(...energies, 1); // Avoid division by zero
      
      // Draw each tone bar
      energies.forEach((energy, idx) => {
        const barHeight = (energy / maxEnergy) * (h - 20); // Leave space for labels
        const color = TONE_TRACE[idx % TONE_TRACE.length];
        
        ctx.fillStyle = color;
        ctx.fillRect(idx * barWidth, h - barHeight, barWidth - 2, barHeight);
        
        // Draw label
        ctx.fillStyle = color;
        ctx.font = '10px "SF Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`T${idx}`, idx * barWidth + barWidth / 2, h - 4);
      });
      
      ctx.textAlign = 'left';
    };
  }, [energies]);

  return <Screen width={width} height={height} draw={draw} grid={false} />;
}
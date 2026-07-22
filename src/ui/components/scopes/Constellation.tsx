// src/ui/components/scopes/Constellation.tsx
import { useMemo } from 'react';
import { Screen } from '../instrument/Screen';
import { T } from '../../theme/labaccent/tokens';

export interface ConstellationProps {
  points: { i: number; q: number }[];
  width: number;
  height: number;
}

export function Constellation({ points, width, height }: ConstellationProps) {
  const draw = useMemo(() => {
    return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (!points.length) return;
      
      // Draw axes
      ctx.strokeStyle = T.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      
      // Draw points
      ctx.fillStyle = T.phosphor;
      const centerX = w / 2;
      const centerY = h / 2;
      const scale = Math.min(w, h) * 0.4;
      
      points.forEach(point => {
        const x = centerX + point.i * scale;
        const y = centerY - point.q * scale; // Flip Y-axis for canvas coordinates
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      });
    };
  }, [points]);

  return <Screen width={width} height={height} draw={draw} />;
}
// src/ui/components/scopes/Waterfall.tsx
import { useMemo, useRef } from 'react';
import { Screen } from '../instrument/Screen';
import { T } from '../../theme/labaccent/tokens';

export interface WaterfallProps {
  bins: Float32Array;
  width: number;
  height: number;
}

export function Waterfall({ bins, width, height }: WaterfallProps) {
  const historyRef = useRef<Float32Array[]>([]);
  const maxHistory = 64; // Number of rows to keep in history

  const draw = useMemo(() => {
    // Add current bins to history
    if (bins.length > 0) {
      historyRef.current.push(new Float32Array(bins));
      if (historyRef.current.length > maxHistory) {
        historyRef.current.shift();
      }
    }
    
    return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (historyRef.current.length === 0) return;
      
      const binWidth = w / bins.length;
      const rowHeight = h / historyRef.current.length;
      
      // Draw each row from oldest to newest (bottom to top)
      historyRef.current.forEach((row, rowIdx) => {
        const yOffset = rowIdx * rowHeight;
        
        for (let i = 0; i < row.length; i++) {
          const intensity = Math.min(1, row[i] / 60); // Normalize to 60dB range
          const alpha = intensity;
          ctx.fillStyle = `rgba(60, 255, 122, ${alpha})`; // T.phosphor with alpha
          ctx.fillRect(i * binWidth, yOffset, binWidth - 1, rowHeight);
        }
      });
    };
  }, [bins]);

  return <Screen width={width} height={height} draw={draw} grid={false} />;
}
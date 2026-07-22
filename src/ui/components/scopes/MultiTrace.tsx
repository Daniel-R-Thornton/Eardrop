import { useMemo } from 'react';
import { Screen } from '../instrument/Screen';
import { drawWave } from './drawTrace';

interface Trace {
  data: Float32Array;
  color: string;
  label: string;
}

export interface MultiTraceProps {
  traces: Trace[];
  width: number;
  height: number;
}

export function MultiTrace({ traces, width, height }: MultiTraceProps) {
  const draw = useMemo(() => {
    return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      if (traces.length === 0) return;
      const rowHeight = h / traces.length;
      
      traces.forEach((trace, idx) => {
        const offsetY = idx * rowHeight;
        ctx.save();
        ctx.translate(0, offsetY);
        ctx.beginPath();
        ctx.rect(0, 0, w, rowHeight);
        ctx.clip();
        drawWave(ctx, w, rowHeight, trace.data, trace.color);
        ctx.restore();
        ctx.fillStyle = trace.color;
        ctx.font = '12px \"SF Mono\", monospace';
        ctx.fillText(trace.label, 4, offsetY + 14);
      });
    };
  }, [traces]);

  return <Screen width={width} height={height} draw={draw} grid={false} />;
}
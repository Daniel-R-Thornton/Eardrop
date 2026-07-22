import { useMemo } from 'react';
import { Screen, type ScreenProps } from '../instrument/Screen';
import { drawWave } from './drawTrace';
import { T } from '../../theme/labaccent/tokens';

export interface TraceProps {
  data: Float32Array;
  color?: string;
  width: number;
  height: number;
  label?: string;
}

export function Trace({ data, color = T.phosphor, width, height, label }: TraceProps) {
  const draw = useMemo(() => {
    return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
      drawWave(ctx, w, h, data, color);
    };
  }, [data, color]);

  return <Screen width={width} height={height} draw={draw} />;
}

/**
 * ToneMap.tsx — frequency plan for a frame: the pilot (red line) and each data
 * tone (offset above/below) laid out on a frequency axis. Shows how the OFDM
 * subcarriers sit around the pilot.
 */
import { Screen } from '../instrument/Screen';
import { T } from '../../theme/labaccent/tokens';

export interface ToneMapProps {
  pilotHz: number;
  toneFreqsHz: number[];
  width: number;
  height: number;
}

export function ToneMap({ pilotHz, toneFreqsHz, width, height }: ToneMapProps) {
  const draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const all = [pilotHz, ...toneFreqsHz];
    if (!all.length) return;
    const lo = Math.min(...all) - 100;
    const hi = Math.max(...all) + 100;
    const x = (f: number) => ((f - lo) / (hi - lo)) * w;
    const baseY = h - 16;

    // frequency axis
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, baseY); ctx.lineTo(w, baseY); ctx.stroke();
    ctx.fillStyle = 'rgba(210,210,200,0.6)';
    ctx.font = `9px ${T.mono}`;
    ctx.fillText(`${(lo / 1000).toFixed(1)}k`, 2, h - 3);
    ctx.textAlign = 'right'; ctx.fillText(`${(hi / 1000).toFixed(1)}kHz`, w - 2, h - 3); ctx.textAlign = 'left';

    // data tones — green ticks up from the axis
    ctx.strokeStyle = T.phosphor;
    for (const f of toneFreqsHz) {
      const px = x(f);
      ctx.beginPath(); ctx.moveTo(px, baseY); ctx.lineTo(px, baseY - 14); ctx.stroke();
    }

    // pilot — red full-height line + label
    const pilotX = x(pilotHz);
    ctx.strokeStyle = '#ff5a3c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(pilotX, 4); ctx.lineTo(pilotX, baseY); ctx.stroke();
    ctx.fillStyle = '#ff5a3c'; ctx.font = `10px ${T.mono}`;
    const lbl = `PILOT ${pilotHz}Hz`;
    ctx.fillText(lbl, Math.min(pilotX + 4, w - ctx.measureText(lbl).width - 2), 13);

    // count label
    ctx.fillStyle = T.phosphor;
    ctx.fillText(`${toneFreqsHz.length} tones`, 2, 13);
  };

  return <Screen width={width} height={height} draw={draw} grid={false} />;
}

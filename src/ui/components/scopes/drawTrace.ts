export function drawWave(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  data: Float32Array, color: string, opts: { gain?: number } = {},
): void {
  if (!data.length) return;
  const gain = opts.gain ?? 1;
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
  const mid = h / 2;
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1 || 1)) * w;
    const y = mid - Math.max(-1, Math.min(1, data[i] * gain)) * (mid - 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

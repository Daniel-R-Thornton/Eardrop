export function drawWave(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  data: Float32Array, color: string, opts: { gain?: number; autoScale?: boolean } = {},
): void {
  if (!data.length) return;
  // Auto-scale (default): normalise to the data's own peak so low-amplitude
  // signals (e.g. a 32-tone sum ~0.1) fill the screen instead of drawing flat.
  let gain = opts.gain ?? 1;
  if (opts.autoScale !== false && opts.gain === undefined) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
    gain = peak > 1e-4 ? 0.92 / peak : 1;
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
  const mid = h / 2;
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1 || 1)) * w;
    const y = mid - Math.max(-1, Math.min(1, data[i] * gain)) * (mid - 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

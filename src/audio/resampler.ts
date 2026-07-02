/**
 * Resampler — downsamples mic input to modem rate using linear interpolation.
 * Works with any input/output rate ratio.
 */

export function createDownsampler(inRate: number, outRate: number, onSample: (s: number) => void) {
  const ratio = inRate / outRate;          // e.g. 48000/3200 = 15
  let buf: number[] = [];
  let accPos = 0;                          // accumulated fractional position

  return {
    feed(input: Float32Array) {
      buf.push(...input);

      // Process as many output samples as we can
      while (buf.length > 0) {
        const pos = accPos;
        const idx = Math.floor(pos);
        const frac = pos - idx;

        if (idx + 1 >= buf.length) break;  // need more input

        // Linear interpolation
        const a = buf[idx];
        const b = buf[idx + 1];
        const sample = a + (b - a) * frac;
        onSample(sample);

        accPos += ratio;
        // Remove consumed samples from buffer
        const consumed = Math.floor(accPos);
        buf.splice(0, consumed);
        accPos -= consumed;
      }
    },

    flush() {
      // Output whatever's left, zero-padded
      for (let i = 0; i < buf.length; i += ratio) {
        const idx = Math.floor(i);
        const frac = i - idx;
        const a = buf[idx] ?? 0;
        const b = buf[Math.min(idx + 1, buf.length - 1)] ?? 0;
        onSample(a + (b - a) * frac);
      }
      buf = [];
      accPos = 0;
    },
  };
}

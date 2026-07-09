/**
 * Resampler — downsamples mic input to modem rate using block averaging.
 *
 * Uses moving-average decimation: for each output sample at outRate,
 * averages `ratio` input samples from inRate. This provides natural
 * anti-aliasing and eliminates the phase distortion that linear
 * interpolation introduces on sparse waveforms.
 */

export function createDownsampler(inRate: number, outRate: number, onSample: (s: number) => void) {
  const ratio = Math.round(inRate / outRate); // e.g. 48000/3200 = 15
  let buf: number[] = [];

  return {
    feed(input: Float32Array) {
      buf.push(...input);

      // Output one sample for every `ratio` input samples — block average
      while (buf.length >= ratio) {
        let sum = 0;
        for (let i = 0; i < ratio; i++) {
          sum += buf[i];
        }
        onSample(sum / ratio);
        buf.splice(0, ratio);
      }
    },

    flush() {
      // Output whatever's left as-is (partial block)
      if (buf.length > 0) {
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          sum += buf[i];
        }
        onSample(sum / buf.length);
      }
      buf = [];
    },
  };
}

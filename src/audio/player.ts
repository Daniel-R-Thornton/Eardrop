/**
 * Audio playback for encoded modem signals.
 * Wraps Web Audio API buffer playback with output device selection.
 */
export class AudioPlayer {
  private ctx: AudioContext;

  /** Optionally accept a shared AudioContext. If omitted, creates its own. */
  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
  }

  private ensureCtx(): AudioContext {
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  /** Play float32 samples at given sample rate through selected output device */
  async play(samples: Float32Array, sampleRate: number, deviceId?: string): Promise<void> {
    const ctx = this.ensureCtx();

    // Set output device if supported and specified
    if (deviceId && typeof (ctx as any).setSinkId === "function") {
      try { await (ctx as any).setSinkId(deviceId); }
      catch { /* fallback to default */ }
    }

    return new Promise((resolve) => {
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.getChannelData(0).set(samples);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      // Boost gain for acoustic path (speaker→air→mic loses ~40-60dB)
      // 3× gain for acoustic path — browser clips at [-1,1] but preserves zero crossings
      const gain = ctx.createGain();
      gain.gain.value = 3.0;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      source.onended = () => resolve();
    });
  }

  /** Close context only if we own it (wasn't shared) */
  stop() {
    this.ctx.close();
  }

  getSampleRate(): number {
    return this.ensureCtx().sampleRate;
  }
}

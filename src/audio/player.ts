/**
 * Audio playback for encoded modem signals.
 * Wraps Web Audio API buffer playback with output device selection.
 */
export class AudioPlayer {
  private ctx: AudioContext;
  private currentSource: AudioBufferSourceNode | null = null;

  /** Optionally accept a shared AudioContext. If omitted, creates its own. */
  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
  }

  private ensureCtx(): AudioContext {
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  /** Play float32 samples at given sample rate through selected output device.
   *  @param clean — if true, play as-is (no pre-amplification) for clean musical output */
  async play(samples: Float32Array, sampleRate: number, deviceId?: string, clean = false): Promise<void> {
    const ctx = this.ensureCtx();

    // Set output device if supported and specified
    if (deviceId && typeof (ctx as any).setSinkId === "function") {
      try {
        await (ctx as any).setSinkId(deviceId);
        console.log("[Player] output device set to:", deviceId);
      } catch (e) {
        console.warn("[Player] setSinkId failed:", e);
      }
    } else {
      console.log("[Player] default output (deviceId=", deviceId, ")");
    }

    return new Promise((resolve) => {
      // Pre-amplify samples directly in buffer (6×, hard-clip at ±1) unless clean mode
      const buf = new Float32Array(samples.length);
      if (clean) {
        buf.set(samples);
      } else {
        for (let i = 0; i < samples.length; i++) {
          const s = samples[i] * 6.0;
          buf[i] = s > 1.0 ? 1.0 : s < -1.0 ? -1.0 : s;
        }
      }
      const buffer = ctx.createBuffer(1, buf.length, sampleRate);
      buffer.getChannelData(0).set(buf);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      this.currentSource = source;
      source.start(0);
      source.onended = () => { this.currentSource = null; resolve(); };
    });
  }

  /** Stop current playback immediately */
  stopPlayback(): void {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch {}
      this.currentSource = null;
    }
  }

  /** Close context only if we own it (wasn't shared) */
  stop() {
    this.stopPlayback();
    this.ctx.close();
  }

  getSampleRate(): number {
    return this.ensureCtx().sampleRate;
  }
}

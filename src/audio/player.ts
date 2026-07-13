/**
 * Audio playback for encoded modem signals.
 * Wraps Web Audio API buffer playback with output device selection.
 */
import { dlog } from '../lib/debug/dlog';

export class AudioPlayer {
  private ctx: AudioContext;
  private currentSource: AudioBufferSourceNode | null = null;
  /** Playback volume multiplier (1.0 = unity). Default 2× (was 6× — reduced to prevent clipping). */
  public volume = 2.0;

  /** Optionally accept a shared AudioContext. If omitted, creates its own. */
  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
  }

  private ensureCtx(): AudioContext {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** Play float32 samples at given sample rate through selected output device.
   *  @param clean — if true, play as-is (no pre-amplification) for clean musical output */
  async play(
    samples: Float32Array,
    sampleRate: number,
    deviceId?: string,
    clean = false,
  ): Promise<void> {
    dlog('PLAY', {
      rate: sampleRate,
      ms: ((samples.length / sampleRate) * 1000).toFixed(0),
      n: samples.length,
      peak: this.calculatePeak(samples).value,
      vol: clean ? 'clean' : this.volume,
      device: (deviceId || 'default').slice(0, 8),
    });

    const ctx = this.ensureCtx();

    // Set output device if supported and specified
    if (deviceId && typeof (ctx as any).setSinkId === 'function') {
      try {
        await (ctx as any).setSinkId(deviceId);
      } catch (e: any) {
        dlog('PLAY', { setSinkIdFailed: e.message || String(e) }, { level: 'warn' });
      }
    }

    return new Promise((resolve) => {
      // Apply volume, auto-normalize to prevent clipping
      const buf = new Float32Array(samples.length);
      if (clean) {
        buf.set(samples);
      } else {
        // Find peak to auto-normalize
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
          const abs = Math.abs(samples[i]);
          if (abs > peak) peak = abs;
        }
        // Scale so that peak * volume * scale = 0.95 (no clipping)
        const targetPeak = 0.95;
        const scale = peak > 0 ? Math.min(targetPeak / (peak * this.volume), 5.0) : 1.0;

        if (scale < 1.0) {
          dlog('PLAY', { autoNorm: scale, peak, vol: this.volume }, { level: 'debug' });
        }

        let clips = 0;
        for (let i = 0; i < samples.length; i++) {
          const sample = samples[i] * this.volume * scale;
          if (sample > 1.0) {
            buf[i] = 1.0;
            clips++;
          } else if (sample < -1.0) {
            buf[i] = -1.0;
            clips++;
          } else {
            buf[i] = sample;
          }
        }
        if (clips > 0) {
          dlog('PLAY', { clipped: clips }, { level: 'warn' });
        }
      }
      const buffer = ctx.createBuffer(1, buf.length, sampleRate);
      buffer.getChannelData(0).set(buf);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      this.currentSource = source;
      source.start(0);

      source.onended = () => {
        dlog('PLAY', { done: ctx.currentTime.toFixed(2) }, { level: 'debug' });
        this.currentSource = null;
        resolve();
      };
    });
  }

  /** Stop current playback immediately */
  stopPlayback(): void {
    if (this.currentSource) {
      console.debug('[AUDIO-PLAYER] ⏹️  Stopping current playback');
      try {
        this.currentSource.stop();
        console.debug('[AUDIO-PLAYER] Stop command issued');
      } catch (e) {
        console.warn('[AUDIO-PLAYER] Stop failed (may be already stopped):', e);
      }
      this.currentSource = null;
    }
  }

  /** Calculate peak amplitude [-1, +1] */
  private calculatePeak(samples: Float32Array): { value: number } {
    let max = 0;
    for (const element of samples) {
      const abs = Math.abs(element);
      if (abs > max) max = abs;
    }
    return { value: Number.parseFloat(max.toFixed(4)) };
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

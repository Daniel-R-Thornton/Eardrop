/**
 * Audio playback for encoded modem signals.
 * Wraps Web Audio API buffer playback with output device selection.
 */
import { dlog } from '../lib/debug/dlog';

export class AudioPlayer {
  private ctx: AudioContext;
  private currentSource: AudioBufferSourceNode | null = null;
  /** Abort hook for an in-flight streaming playback (set by playStream). */
  private streamStop: (() => void) | null = null;
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
        for (const element of samples) {
          const abs = Math.abs(element);
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

  /**
   * Stream playback: schedule audio chunks back-to-back as they are pulled,
   * keeping ~2 s buffered ahead. `pull()` returns the next chunk or null at end.
   * Gapless — chunks are contiguous slices scheduled at contiguous times.
   * Samples are expected pre-normalized (≈0.95 peak); the UI `volume` control
   * (see batch `play()`) is applied here via a gain node — streaming can't do
   * the whole-signal peak analysis `play()` does, so each chunk is additionally
   * guarded against exceeding unity peak before scheduling (see `schedule()`).
   * Resolves when the last scheduled chunk finishes; rejects if pull() throws.
   * @param onProgress optional — called with seconds of audio scheduled so far.
   */
  async playStream(
    pull: () => Promise<Float32Array | null>,
    sampleRate: number,
    deviceId?: string,
    onProgress?: (scheduledSec: number) => void,
  ): Promise<void> {
    const ctx = this.ensureCtx();
    if (deviceId && typeof (ctx as any).setSinkId === 'function') {
      try {
        await (ctx as any).setSinkId(deviceId);
      } catch (e: any) {
        dlog('PLAY', { setSinkIdFailed: e.message || String(e) }, { level: 'warn' });
      }
    }

    const gain = ctx.createGain();
    // Streamed chunks are pre-normalized to ≈0.95 peak (see class doc above),
    // with no whole-signal analysis to cancel `this.volume` the way batch
    // play()'s auto-norm does (`scale = targetPeak/(peak*volume)`). Above
    // unity, `this.volume` (default 2.0×) would push ≈0.95 peak samples to
    // ≈1.9 post-gain and hard-clip at the DAC on every chunk. Cap the applied
    // gain at 1.0 — volume < 1 (backing the speaker OUT of its compressor's
    // range, the actual use case here) still works; > 1 on this path can only
    // clip, so it's clamped rather than honored.
    gain.gain.value = Math.min(this.volume, 1.0);
    gain.connect(ctx.destination);

    const LOOKAHEAD_SEC = 2.0;
    const START_PAD_SEC = 0.15; // small lead so the first chunk isn't scheduled in the past
    const sources = new Set<AudioBufferSourceNode>();
    let nextTime = ctx.currentTime + START_PAD_SEC;
    let scheduledSamples = 0;
    let aborted = false;
    let producerDone = false;

    const schedule = (chunk: Float32Array): void => {
      // Hard safety clamp: samples should already be ≤1.0 (pre-normalized
      // upstream), but guard against future coherent-symbol regressions
      // reaching the DAC — scale the whole chunk down to unity peak rather
      // than let individual samples clip silently. This is a dormant safety
      // net, not a leveling stage: the scale factor is computed independently
      // per chunk, so if it ever actually fires on a live stream it would
      // step the output level between chunks rather than apply a smooth,
      // stream-wide normalization.
      let peak = 0;
      for (let i = 0; i < chunk.length; i++) {
        const abs = Math.abs(chunk[i]);
        if (abs > peak) peak = abs;
      }
      let safeChunk = chunk;
      if (peak > 1.0) {
        dlog('PLAYER', { clipGuard: true, peak: Number(peak.toFixed(4)) }, { level: 'warn' });
        safeChunk = new Float32Array(chunk.length);
        const scale = 1.0 / peak;
        for (let i = 0; i < chunk.length; i++) safeChunk[i] = chunk[i] * scale;
      }
      const buffer = ctx.createBuffer(1, safeChunk.length, sampleRate);
      buffer.getChannelData(0).set(safeChunk);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      // Guard against underrun scheduling into the past (shouldn't happen — encode
      // runs far faster than realtime — but keeps playback monotonic if it does).
      const startAt = Math.max(nextTime, ctx.currentTime);
      src.start(startAt);
      nextTime = startAt + chunk.length / sampleRate;
      scheduledSamples += chunk.length;
      sources.add(src);
      src.onended = () => sources.delete(src);
    };

    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.streamStop = null;
        try {
          gain.disconnect();
        } catch {
          /* already disconnected */
        }
      };

      this.streamStop = () => {
        aborted = true;
        for (const s of sources) {
          try {
            s.stop();
          } catch {
            /* already stopped */
          }
        }
        sources.clear();
        cleanup();
        resolve();
      };

      let pumping = false;
      const pump = async (): Promise<void> => {
        if (pumping || aborted) return;
        pumping = true;
        try {
          while (!aborted && !producerDone && nextTime - ctx.currentTime < LOOKAHEAD_SEC) {
            const chunk = await pull();
            if (aborted) return;
            if (chunk === null) {
              producerDone = true;
              break;
            }
            schedule(chunk);
            onProgress?.(scheduledSamples / sampleRate);
          }
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        } finally {
          pumping = false;
        }

        if (aborted) return;
        if (producerDone) {
          // Everything is scheduled; resolve once playback reaches the end.
          const remainingMs = Math.max(0, (nextTime - ctx.currentTime) * 1000) + 50;
          setTimeout(() => {
            cleanup();
            resolve();
          }, remainingMs);
          return;
        }
        setTimeout(() => void pump(), 200);
      };

      void pump();
    });
  }

  /** Stop current playback immediately */
  stopPlayback(): void {
    if (this.streamStop) {
      console.debug('[AUDIO-PLAYER] ⏹️  Stopping stream playback');
      this.streamStop();
    }
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

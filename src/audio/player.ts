/**
 * Audio playback for encoded modem signals.
 * Wraps Web Audio API buffer playback with output device selection.
 */
import { dlog } from '../lib/debug/dlog';

/**
 * Peak the batch path normalises every (non-clean) buffer to, regardless of
 * `volume` — so a batch transmission's absolute acoustic level is fixed and
 * volume-independent. Exported because the streaming path has no
 * whole-signal analysis of its own and callers that need to MATCH this level
 * have to derive their fixed scale from it (see `playStream`'s `fixedGain`
 * and chatterController's file path).
 */
export const PLAYBACK_TARGET_PEAK = 0.95;

/**
 * Apply playback volume and the auto-normalise/clamp policy, writing into
 * `out` rather than returning a new array — the caller already has a
 * destination (an AudioBuffer's channel data), and allocating a scratch copy
 * here meant three copies of every waveform were live at once.
 *
 * Extracted from `play` so the level maths is testable without an
 * AudioContext. Getting it wrong is not a cosmetic bug: the receiver trains
 * its amplitude reference on the preamble and applies it to the data, so a
 * scaling error corrupts every channel estimate downstream.
 */
export function shapeForPlayback(
  samples: Float32Array,
  out: Float32Array,
  volume: number,
  clean: boolean,
): { peak: number; scale: number; clips: number } {
  if (clean) {
    out.set(samples);
    return { peak: 0, scale: 1.0, clips: 0 };
  }

  let peak = 0;
  for (const element of samples) {
    const abs = Math.abs(element);
    if (abs > peak) peak = abs;
  }
  // Scale so that peak * volume * scale = 0.95 (no clipping). Capped at 5x so
  // a near-silent buffer is not amplified into noise.
  const targetPeak = PLAYBACK_TARGET_PEAK;
  const scale = peak > 0 ? Math.min(targetPeak / (peak * volume), 5.0) : 1.0;

  // Clamp, never rescale, the samples that still overshoot: the cap above
  // means overshoot is possible, and clamping distorts a handful of samples
  // while a rescale would step the whole buffer's level.
  //
  // In practice this branch is unreachable with the formula above, so `clips`
  // is expected to be 0: if the cap doesn't bind, scale = 0.95/(peak*volume),
  // so peak*volume*scale = 0.95 exactly; if the cap does bind (peak*volume <
  // 0.19), scale = 5.0, so peak*volume*scale = peak*volume*5 < 0.95. Either
  // way the largest-magnitude sample tops out at 0.95, under unity. It's kept
  // as a guard against a future change to `scale` that reopens the
  // possibility, not because it currently fires.
  let clips = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] * volume * scale;
    if (sample > 1.0) {
      out[i] = 1.0;
      clips++;
    } else if (sample < -1.0) {
      out[i] = -1.0;
      clips++;
    } else {
      out[i] = sample;
    }
  }
  return { peak, scale, clips };
}

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
      // Write straight into the AudioBuffer's channel data.
      //
      // This used to build a scratch Float32Array, fill it, then `set()` it
      // into the buffer — so three copies of every waveform were live at once
      // (the caller's samples, the scratch, and the buffer's own backing
      // store). The buffer has to be allocated either way; the scratch does
      // not.
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      const { peak, scale, clips } = shapeForPlayback(samples, buffer.getChannelData(0), this.volume, clean);

      if (!clean && scale < 1.0) {
        dlog('PLAY', { autoNorm: scale, peak, vol: this.volume }, { level: 'debug' });
      }
      if (clips > 0) {
        dlog('PLAY', { clipped: clips }, { level: 'warn' });
      }

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
   *
   * Samples are NOT pre-normalized to any particular peak — this comment used
   * to claim "≈0.95 peak", which is not what the producer emits.
   * `TxEngine.frameSegments` emits every segment at ONE fixed deterministic
   * scale, sized so that |sample| stays under 0.95 for a PAPR budget of
   * PAPR_CREST standard deviations. That is a measured property, not a proof —
   * OFDMQPSKModulator's own scale doc says so in as many words, and accepts
   * occasional tail clipping as the price of not paying a permanent ~9 dB level
   * penalty. So 0.95 is the level the transmitter AIMS under, not a bound
   * anything downstream may rely on. The actual peak of a real transmission
   * lands wherever that maths puts it (measured 0.69-0.74 for chatter-shaped
   * configs, and the sync/training burst lower still).
   *
   * What matters here is the CONSTANT RELATIVE level across chunks, which is a
   * structural property of emitting one fixed scale and does not depend on the
   * PAPR budget holding. That is what makes a single whole-transmission scale
   * safe and per-chunk rescaling forbidden (see `schedule()`), and it is why the
   * clip guard clamps rather than rescales when the budget is exceeded.
   *
   * By default the UI `volume` control is applied via a gain node, clamped to
   * unity. `fixedGain` overrides it with a caller-supplied constant, for paths
   * that must transmit at a specific absolute level rather than at whatever
   * the user's volume slider says — the batch `play()` path normalises volume
   * out entirely, so a streamed transmission that has to match a batch one
   * cannot be volume-dependent (see chatterController's file path).
   *
   * Resolves when the last scheduled chunk finishes; rejects if pull() throws.
   * @param onProgress optional — called with seconds of audio scheduled so far.
   * @param fixedGain optional — constant linear gain instead of the volume-derived one.
   */
  async playStream(
    pull: () => Promise<Float32Array | null>,
    sampleRate: number,
    deviceId?: string,
    onProgress?: (scheduledSec: number) => void,
    fixedGain?: number,
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
    // Streamed chunks arrive at the transmitter's own level, aimed under 0.95
    // (see the doc above), with no whole-signal analysis to cancel `this.volume`
    // the way batch play()'s auto-norm does (`scale = targetPeak/(peak*volume)`).
    // Above unity, `this.volume` (default 2.0×) would push a 0.95-peak chunk to
    // ≈1.9 post-gain and hard-clip at the DAC. Cap the applied gain at 1.0 —
    // volume < 1 (backing the speaker OUT of its compressor's range) still
    // works; > 1 on this path can only clip, so it's clamped rather than
    // honored. `fixedGain` bypasses the slider entirely; it is clamped the same
    // way, because the clipping argument does not care where the number came
    // from.
    //
    // NOTE the ORDER, which is what makes >1 unsafe rather than merely loud:
    // `schedule()`'s clip guard inspects and clamps the RAW chunk, before it
    // ever reaches this gain node. Anything this node adds on top is applied
    // after the only guard in the path, so a gain above unity clips at the
    // destination silently — no clamp, no `clipClamped` dlog, nothing in the
    // log to explain a wrecked transfer. Hence the clamp here rather than trust.
    gain.gain.value = Math.min(fixedGain ?? this.volume, 1.0);
    gain.connect(ctx.destination);

    const LOOKAHEAD_SEC = 2.0;
    const START_PAD_SEC = 0.15; // small lead so the first chunk isn't scheduled in the past
    const sources = new Set<AudioBufferSourceNode>();
    let nextTime = ctx.currentTime + START_PAD_SEC;
    let scheduledSamples = 0;
    let aborted = false;
    let producerDone = false;

    const schedule = (chunk: Float32Array): void => {
      // Safety limiter: CLAMP the few offending samples. It must not rescale
      // the chunk.
      //
      // This used to divide the whole chunk by its own peak, and the previous
      // comment already named the flaw — "the scale factor is computed
      // independently per chunk, so if it ever actually fires it would step the
      // output level between chunks". It fired (measured peak 1.19 on a
      // 32-tone/16-QAM run) and did exactly that: one chunk went out ~1.5 dB
      // below the rest. For a QAM link that is far worse than clipping,
      // because the receiver's amplitude reference is trained on the preamble
      // and applied to the data — if those land in differently-scaled chunks,
      // every channel estimate is wrong by the difference. Observed as a flat
      // 6 dB per-tone profile turning into a 22 dB ramp with the ref-symbol
      // calibration reporting 1.8-3x corrections.
      //
      // Clamping instead distorts only the handful of samples that overshoot,
      // adds a little broadband noise, and leaves every level relationship in
      // the transmission intact. Rare clipping is recoverable; a level step is
      // not.
      let clipped = 0;
      let peak = 0;
      let safeChunk = chunk;
      for (let i = 0; i < chunk.length; i++) {
        const abs = Math.abs(chunk[i]);
        if (abs > peak) peak = abs;
        if (abs > 1.0) clipped++;
      }
      if (clipped > 0) {
        dlog(
          'PLAYER',
          { clipClamped: clipped, peak: Number(peak.toFixed(4)), of: chunk.length },
          { level: 'warn' },
        );
        safeChunk = new Float32Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) {
          const v = chunk[i];
          safeChunk[i] = v > 1.0 ? 1.0 : v < -1.0 ? -1.0 : v;
        }
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

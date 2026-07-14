/**
 * Audio recorder — captures mic input, downsamples to modem rate via
 * Hann-windowed polyphase FIR filter in AudioWorklet, feeds samples to decoder.
 */

import { dbg } from '../lib/debug';
import { dlog } from '../lib/debug/dlog';

export type ChunkCallback = (chunk: Float32Array) => void;

/** AudioWorklet processor — configurable downsampler or pass-through.
 *  `processorOptions.ratio` = 1: native-rate pass-through (no filtering).
 *  ratio > 1: Hann-windowed sinc decimation from ctx rate to modem rate.
 *  The default (15) downsamples 48000→3200 for legacy BPSK. */
const WORKLET_SOURCE = `
// RATIO, TAPS, and coeffs are computed at construction time from processorOptions.
const FILTER_VERSION = 'sinc127-v2';

// Pre-compute Hann-windowed sinc coefficients for the given ratio.
// Anti-alias cutoff at fs/(2*ratio). 127 taps at 48 kHz gives a ~1.25 kHz
// transition band around the cutoff.
function buildCoeffs(ratio) {
  const taps = ratio === 1 ? 1 : 127;
  const halfTaps = (taps - 1) / 2;
  const coeffs = [];
  for (let phase = 0; phase < ratio; phase++) {
    const c = new Float32Array(taps);
    let sum = 0;
    for (let n = 0; n < taps; n++) {
      const t = ((n - halfTaps) - phase / ratio) / ratio;
      if (t === 0) {
        c[n] = 1.0;
      } else {
        c[n] = Math.sin(Math.PI * t) / (Math.PI * t);
      }
      // Hann window — smooth rolloff, good stopband rejection
      c[n] *= 0.5 * (1 - Math.cos(2 * Math.PI * n / (taps - 1)));
      sum += c[n];
    }
    // Normalize to unity DC gain so signal level is preserved
    for (let n = 0; n < taps; n++) c[n] /= sum;
    coeffs.push(c);
  }
  return coeffs;
}

class RecorderProcessor extends AudioWorkletProcessor {
  ratio = 15;
  coeffs = null;
  // Circular buffer (only used when ratio > 1)
  mask = 127;
  history = null;
  head = 0;
  sampleCount = 0;
  outBuf = new Float32Array(128);
  outIdx = 0;

  constructor(options) {
    super();
    const ratio = (options && options.processorOptions && options.processorOptions.ratio) || 15;
    this.ratio = ratio;
    if (ratio > 1) {
      this.coeffs = buildCoeffs(ratio);
      this.history = new Float32Array(128);
      this.mask = 127;
    }
  }

  process(inputs, _outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    if (this.ratio === 1) {
      // Pass-through: forward raw samples directly — no filtering
      this.port.postMessage(new Float32Array(channel));
      return true;
    }

    const coeffs = this.coeffs;
    for (let i = 0; i < channel.length; i++) {
      // Write to circular buffer
      this.history[this.head] = channel[i];
      this.head = (this.head + 1) & this.mask;
      this.sampleCount++;

      // Produce one output sample every RATIO input samples
      if ((this.sampleCount % this.ratio) === 0 && this.sampleCount >= coeffs.length * this.ratio) {
        let sum = 0;
        const c = coeffs[0];
        // Read TAPS newest samples (head-1 = newest, head-TAPS = oldest)
        let pos = (this.head - 1) & this.mask;
        for (let n = 0; n < c.length; n++) {
          sum += this.history[pos] * c[n];
          pos = (pos - 1) & this.mask;
        }
        this.outBuf[this.outIdx++] = sum;
        if (this.outIdx >= 128) {
          this.port.postMessage(this.outBuf.slice(0, this.outIdx));
          this.outIdx = 0;
        }
      }
    }

    if (this.outIdx > 0) {
      this.port.postMessage(this.outBuf.slice(0, this.outIdx));
      this.outIdx = 0;
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
`.trim();

const WORKLET_BLOB = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
const WORKLET_URL = URL.createObjectURL(WORKLET_BLOB);

export class AudioRecorder {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private ctx: AudioContext;
  private running = false;
  private onChunk: ChunkCallback | null = null;
  /** Reference to the live GainNode for dynamic mic gain adjustment */
  private micBoostNode: GainNode | null = null;

  private static workletLoaded = false;

  /** @param ctx - Shared AudioContext (creates own if omitted).
   *  @param micGain - Mic pre-amp multiplier. Default 8.0. */
  constructor(ctx?: AudioContext, public micGain = 8.0) {
    this.ctx = ctx ?? new AudioContext();
  }

  get isRunning() { return this.running; }

  /** Dynamically update mic gain while recording. */
  setMicGain(gain: number) {
    this.micGain = gain;
    if (this.micBoostNode) {
      this.micBoostNode.gain.value = gain;
    }
  }

  async start(_modemRate: number, onChunk: ChunkCallback, deviceId?: string): Promise<void> {
    if (this.running) return;
    this.micBoostNode = null;

    dlog('REC', {
      start: this.ctx.currentTime.toFixed(2),
      ctxRate: this.ctx.sampleRate,
      ctxState: this.ctx.state,
      gain: this.micGain,
      device: (deviceId || 'default').slice(0, 8),
    });

    if (this.ctx.state === 'suspended') {
      console.debug('[Recorder] Resuming suspended AudioContext');
      await this.ctx.resume();
      console.debug('[Recorder] ✅ AudioContext resumed');
    }

    // Load AudioWorklet with Hann-sinc downsampler (once per class lifetime)
    if (!AudioRecorder.workletLoaded) {
      console.debug('[Recorder] Initializing AudioWorklet processor...');
      try {
        await this.ctx.audioWorklet.addModule(WORKLET_URL);
        AudioRecorder.workletLoaded = true;
        console.debug('[Recorder] ✅ AudioWorklet module loaded');
      } catch (err: any) {
        console.error('[Recorder] ❌ AudioWorklet addModule failed:', err);
        throw new Error(`AudioWorklet init failed: ${err.message}`);
      }
    } else {
      console.debug('[Recorder] AudioWorklet already loaded, skipping');
    }

    console.debug('[Recorder] Requesting mic stream (raw 48kHz mono, AGC/NS/EC off)');

    // Get mic — force raw 48kHz mono, no processing
    const constraints: MediaStreamConstraints = {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: 48000 },
        channelCount: { ideal: 1 },
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.onChunk = onChunk;

    // AudioWorklet: compute downsample ratio from ctx rate / modem rate.
    // ratio === 1 means pass-through (native rate OFDM); ratio > 1 uses
    // the Hann-sinc polyphase filter (legacy BPSK at 3200 Hz).
    const workletRatio = Math.round(this.ctx.sampleRate / _modemRate);
    const isNative = workletRatio === 1;
    this.workletNode = new AudioWorkletNode(this.ctx, 'recorder-processor', {
      processorOptions: { ratio: workletRatio },
    });
    // ── AudioWorklet message port: handle both normal data and Chrome’s
    //    occasional "message channel closed" bug that kills the processor.
    //    Log the error so it shows up in the debug dump — the existing
    //    micWatchdog (1500 ms silence) will trigger recovery naturally.
    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.running) return;
      this.onChunk!(e.data);
    };
    // AudioWorkletNode.onmessageerror: catches Chrome's occasional
    // cross-context port teardown errors that would otherwise go silent.
    this.workletNode.port.onmessageerror = () => {
      dlog('REC-ERR', { source: 'worklet-msg-error' });
    };
    // AudioWorkletNode.onprocessorerror: catches unhandled exceptions
    // thrown inside the AudioWorkletProcessor (e.g. NaN, OOM).
    this.workletNode.onprocessorerror = () => {
      dlog('REC-ERR', { source: 'worklet-processor' });
    };

    // Connect: mic → gain boost → worklet → silent destination
    const micBoost = this.ctx.createGain();
    micBoost.gain.value = this.micGain;
    this.micBoostNode = micBoost;
    this.source.connect(micBoost);
    micBoost.connect(this.workletNode);
    const silentGain = this.ctx.createGain();
    silentGain.gain.value = 0;
    this.workletNode.connect(silentGain);
    silentGain.connect(this.ctx.destination);

    this.running = true;
    dlog('REC', { running: true, worklet: isNative ? 'native' : 'sinc127-v2', ratio: workletRatio, gain: this.micGain, outRate: isNative ? this.ctx.sampleRate : _modemRate });
  }

  stop() {
    console.log('[Recorder] ⏹ Stopping recording...');
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.port.onmessageerror = null;
      this.workletNode.onprocessorerror = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.micBoostNode) {
      this.micBoostNode.disconnect();
      this.micBoostNode = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.onChunk = null;
    this.running = false;
    console.log('[Recorder] ✅ stopped');
  }

  getDiag(): {
    rmsDb: number; peak: number; zeroCrossingRate: number;
    ctxState: string; sampleRate: number; calibrationFactor: number;
    recentSamples: Float32Array;
    } {
    return {
      rmsDb: -80, peak: 0, zeroCrossingRate: 0,
      ctxState: this.ctx.state, sampleRate: this.ctx.sampleRate,
      calibrationFactor: 1.0, recentSamples: new Float32Array(0),
    };
  }
}

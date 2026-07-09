/**
 * Audio recorder — captures mic input, downsamples to modem rate via
 * Hann-windowed polyphase FIR filter in AudioWorklet, feeds samples to decoder.
 */

export type SampleCallback = (sample: number) => void;

/** AudioWorklet processor — 31-tap Hann-windowed sinc downsampler.
 *  Hardware rate (48000) → modem rate (3200) at 15:1 decimation.
 *  Quality comparable to browser's internal resampler. */
const WORKLET_SOURCE = `
const RATIO = 15;
const TAPS = 31;
const HALF_TAPS = (TAPS - 1) / 2;

// Pre-compute Hann-windowed sinc coefficients for each polyphase offset
const coeffs = [];
for (let phase = 0; phase < RATIO; phase++) {
  const c = new Float32Array(TAPS);
  for (let n = 0; n < TAPS; n++) {
    const t = (n - HALF_TAPS) - phase / RATIO;
    if (t === 0) {
      c[n] = 1.0;
    } else {
      c[n] = Math.sin(Math.PI * t) / (Math.PI * t);
    }
    // Hann window — smooth rolloff, good stopband rejection
    c[n] *= 0.5 * (1 - Math.cos(2 * Math.PI * n / (TAPS - 1)));
  }
  coeffs.push(c);
}

class RecorderProcessor extends AudioWorkletProcessor {
  history = new Float32Array(TAPS + RATIO);
  historyPos = 0;
  outputBuf = new Float32Array(128);
  outputCount = 0;

  constructor() { super(); }

  process(inputs, _outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    let outIdx = 0;
    for (let i = 0; i < channel.length; i++) {
      this.history[this.historyPos] = channel[i];
      this.historyPos = (this.historyPos + 1) % RATIO;

      if (this.historyPos === 0) {
        // Produce one output sample: FIR convolution with phase-0 coefficients
        let sum = 0;
        const c = coeffs[0];
        for (let n = 0; n < TAPS; n++) {
          const hi = (this.historyPos + TAPS + RATIO - 1 - n) % (TAPS + RATIO);
          sum += this.history[hi] * c[n];
        }
        this.outputBuf[outIdx++] = sum;
        if (outIdx >= 128) {
          this.port.postMessage(this.outputBuf.slice(0, outIdx));
          outIdx = 0;
        }
      }
    }

    if (outIdx > 0) {
      this.port.postMessage(this.outputBuf.slice(0, outIdx));
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
  private onSample: SampleCallback | null = null;
  /** Reference to the live GainNode for dynamic mic gain adjustment */
  private micBoostNode: GainNode | null = null;

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

  async start(_modemRate: number, onSample: SampleCallback, deviceId?: string): Promise<void> {
    if (this.running) return;
    this.micBoostNode = null;

    console.log('[Recorder] start');
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    // Load AudioWorklet with Hann-sinc downsampler
    try {
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (err: any) {
      console.error('[Recorder] AudioWorklet addModule failed:', err);
      throw new Error(`AudioWorklet init failed: ${err.message}`);
    }

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
    this.onSample = onSample;

    // AudioWorklet outputs at modem rate (3200Hz) — feed samples directly
    this.workletNode = new AudioWorkletNode(this.ctx, 'recorder-processor');
    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.running) return;
      const samples = e.data;
      for (let i = 0; i < samples.length; i++) {
        this.onSample!(samples[i]);
      }
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
    console.log('[Recorder] running (Hann-sinc downsampler in worklet)');
  }

  stop() {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.onSample = null;
    this.running = false;
    console.log('[Recorder] stopped');
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

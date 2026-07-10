/**
 * Audio recorder — captures mic input, downsamples to modem rate via
 * Hann-windowed polyphase FIR filter in AudioWorklet, feeds samples to decoder.
 */

import { dbg } from '../lib/debug';
import { dlog } from '../lib/debug/dlog';

export type SampleCallback = (sample: number) => void;

/** AudioWorklet processor — 31-tap Hann-windowed sinc downsampler.
 *  Hardware rate (48000) → modem rate (3200) at 15:1 decimation.
 *  Quality comparable to browser's internal resampler. */
const WORKLET_SOURCE = `
const RATIO = 15;
// 127 taps: a 31-tap sinc at 48 kHz has a ~1.4 kHz transition band, so the
// passband ended near ~900 Hz and tones above bin 67 (837 Hz) arrived 20-100x
// attenuated — that's what killed 8-tone OFDM acoustically. 127 taps pushes
// the passband edge to ~1450 Hz (modem Nyquist is 1600 Hz).
const TAPS = 127;
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
  // Circular buffer with power-of-2 size for fast modulo
  mask = 127; // 128 slots
  history = new Float32Array(128);
  head = 0; // next write position
  sampleCount = 0; // monotonically increasing, used only for decimation trigger
  outBuf = new Float32Array(128);
  outIdx = 0;

  constructor() { super(); }

  process(inputs, _outputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      // Write to circular buffer
      this.history[this.head] = channel[i];
      this.head = (this.head + 1) & this.mask;
      this.sampleCount++;

      // Produce one output sample every RATIO input samples
      if ((this.sampleCount % RATIO) === 0 && this.sampleCount >= TAPS * RATIO) {
        let sum = 0;
        const c = coeffs[0];
        // Read TAPS newest samples (head-1 = newest, head-TAPS = oldest)
        let pos = (this.head - 1) & this.mask;
        for (let n = 0; n < TAPS; n++) {
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
  private onSample: SampleCallback | null = null;
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

  async start(_modemRate: number, onSample: SampleCallback, deviceId?: string): Promise<void> {
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
    this.onSample = onSample;

    // AudioWorklet outputs at modem rate (3200Hz) — feed samples directly
    this.workletNode = new AudioWorkletNode(this.ctx, 'recorder-processor');
    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.running) return;
      const samples = e.data;
      dbg.trace('recorder', 'Processing worklet buffer:', {
        samples: samples.length,
        downscaledFrom: '48000 Hz → 3200 Hz',
      });
      let samplesProcessed = 0;
      for (let i = 0; i < samples.length; i++) {
        this.onSample!(samples[i]);
        samplesProcessed++;
      }
      dbg.trace('recorder', '✅ Processed worklet chunk:', samplesProcessed, 'samples');
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
    dlog('REC', { running: true, worklet: 'hann-sinc', gain: this.micGain, outRate: 3200 });
  }

  stop() {
    console.log('[Recorder] ⏹ Stopping recording...');
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
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
    this.onSample = null;
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

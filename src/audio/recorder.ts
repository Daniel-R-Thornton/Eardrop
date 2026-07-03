/**
 * Audio recorder — captures mic input, downsamples to modem rate,
 * and feeds samples to decoder.
 *
 * Uses AudioWorklet (modern replacement for ScriptProcessorNode).
 * AudioWorklet processes audio on a dedicated thread and communicates
 * back to the main thread via postMessage.
 */

import { createDownsampler } from "./resampler";

export type SampleCallback = (sample: number) => void;

/** Inline AudioWorklet processor source — loaded as a blob URL. */
const WORKLET_SOURCE = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }
  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channel = input[0];
      if (channel && channel.length > 0) {
        // Clone the Float32Array so the buffer isn't recycled
        this.port.postMessage(channel.slice(0));
      }
    }
    return true; // keep alive
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
`.trim();

const WORKLET_BLOB = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
const WORKLET_URL = URL.createObjectURL(WORKLET_BLOB);

export class AudioRecorder {
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private ctx: AudioContext;
  private running = false;
  private onSample: SampleCallback | null = null;
  private downsampler: ReturnType<typeof createDownsampler> | null = null;
  /** Calibrated mic rate — may differ from ctx.sampleRate */
  private calibratedMicRate = 0;

  /** Optionally accept a shared AudioContext. If omitted, creates its own. */
  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
    this.calibratedMicRate = this.ctx.sampleRate;
  }

  /** Set a calibration factor for the mic sample rate (frequency offset detected via sweep) */
  setCalibration(factor: number) {
    this.calibratedMicRate = Math.round(this.ctx.sampleRate * factor);
    console.log(`[Recorder] mic rate calibrated: ${this.ctx.sampleRate} × ${factor} = ${this.calibratedMicRate} Hz`);
  }

  get isRunning() { return this.running; }

  async start(modemRate: number, onSample: SampleCallback, deviceId?: string): Promise<void> {
    if (this.running) return;

    console.log("[Recorder] start");

    console.log("[Recorder] context state:", this.ctx.state);

    if (this.ctx.state === "suspended") {
      console.log("[Recorder] context suspended — resuming…");
      await this.ctx.resume();
      console.log("[Recorder] after resume:", this.ctx.state);
    }

    // Load the AudioWorklet module
    try {
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (err: any) {
      console.error("[Recorder] AudioWorklet addModule failed:", err);
      throw new Error(`AudioWorklet init failed: ${err.message}`);
    }

    // Get mic permission
    const constraints: MediaStreamConstraints = {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: { exact: false },
        noiseSuppression: { exact: false },
        autoGainControl: { exact: false },
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    console.log("[Recorder] stream active:", this.stream.active);

    const micRate = this.calibratedMicRate || this.ctx.sampleRate;
    console.log(`[Recorder] using mic rate: ${micRate} Hz (ctx says ${this.ctx.sampleRate})`);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.onSample = onSample;
    this.downsampler = createDownsampler(micRate, modemRate, onSample);

    // Create AudioWorkletNode
    this.workletNode = new AudioWorkletNode(this.ctx, "recorder-processor");
    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.running || !this.downsampler) return;
      this.downsampler.feed(e.data);
    };

    // Connect: mic → worklet → gain(0) → destination (graph must reach dest)
    this.source.connect(this.workletNode);
    const silentGain = this.ctx.createGain();
    silentGain.gain.value = 0;
    this.workletNode.connect(silentGain);
    silentGain.connect(this.ctx.destination);

    this.running = true;
    console.log("[Recorder] running");
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
    // Don't close ctx — it may be shared with the AudioPlayer
    this.downsampler = null;
    this.onSample = null;
    this.running = false;
    console.log("[Recorder] stopped");
  }
}

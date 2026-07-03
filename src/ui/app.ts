/**
 * app.ts — Background controller for Eardrop.
 *
 * Manages workers, audio, recording, and file transfers.
 * Pushes state into the React Store; React renders the UI.
 *
 * Architecture:
 *   EncoderWorker (TX) ← main thread → BroadcastWorker (RX)
 *                         ↕
 *                    React Store → React UI
 */

import "../style.css";
import { setState, getState } from "./Store";
import { debugLogger } from "../modem/debugger";
import { Encoder } from "../modem/encoder";
import { Decoder } from "../modem/decoder";
import { AudioPlayer } from "../audio/player";
import { AudioRecorder } from "../audio/recorder";
import { Visualizer } from "../modem/visualizer";
import { DEFAULT_CONFIG, TONE_COLORS } from "../modem/types";
import { enumerateDevices, populateSelect } from "../audio/devices";
import { buildPacket, tryParsePreamble, verifyPayload } from "../protocol";

// ─── Debug logging ────────────────────────────────────
let DEBUG = false;
const _origLog = console.log;

// ─── Workers ─────────────────────────────────────────

const encoderWorker = new Worker(
  new URL("../workers/encoder.worker.ts", import.meta.url),
  { type: "module" },
);

const broadcastWorker = new Worker(
  new URL("../workers/broadcast.worker.ts", import.meta.url),
  { type: "module" },
);

// Map of encode task id → { resolve, reject }
const encodeTasks = new Map<number, {
  resolve: (s: { samples: Float32Array; sampleRate: number }) => void;
  reject: (err: Error) => void;
}>();
let encodeIdCounter = 0;

encoderWorker.onmessage = (e) => {
  const msg = e.data;
  const task = encodeTasks.get(msg.id);
  if (!task) return;
  encodeTasks.delete(msg.id);
  if (msg.type === "encoded") {
    task.resolve({ samples: new Float32Array(msg.samples), sampleRate: msg.sampleRate });
  } else if (msg.type === "error") {
    task.reject(new Error(msg.error));
  }
};

function encodeInWorker(data: Uint8Array, config?: Partial<typeof DEFAULT_CONFIG>):
  Promise<{ samples: Float32Array; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const id = ++encodeIdCounter;
    encodeTasks.set(id, { resolve, reject });
    const copy = new Uint8Array(data);
    encoderWorker.postMessage({ type: "encode", id, data: copy, config }, { transfer: [copy.buffer] });
  });
}

function encodeToOutputRateInWorker(data: Uint8Array, outputRate: number, config?: Partial<typeof DEFAULT_CONFIG>):
  Promise<{ samples: Float32Array; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const id = ++encodeIdCounter;
    encodeTasks.set(id, { resolve, reject });
    const copy = new Uint8Array(data);
    encoderWorker.postMessage({ type: "encodeToOutput", id, data: copy, outputRate, config }, { transfer: [copy.buffer] });
  });
}

// ─── Broadcast Worker Messages ──────────────────────

let decodedAccumulated: Uint8Array[] = [];
let totalDecoded = 0;
let parsedPreamble: { preamble: import("../protocol").FilePreamble; consumed: number } | null = null;
let payloadCollected = 0;
let wasInFrame = false;

broadcastWorker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "listening":
      setState({ recvStatus: { type: "info", msg: "Listener started — awaiting signal…" } });
      break;
    case "stopped":
      setState({ recvStatus: { type: "info", msg: "Listener stopped" } });
      break;
    case "frame": {
      const chunk = new Uint8Array(msg.data);
      recvBuf(decodedAccumulated, chunk);
      tryFinalize();
      break;
    }
    case "decoderState": {
      if (msg.debugInfo && msg.debugInfo.inFrame && !wasInFrame) {
        decodedAccumulated = [];
        totalDecoded = 0;
        parsedPreamble = null;
        payloadCollected = 0;
      }
      wasInFrame = msg.debugInfo?.inFrame ?? false;

      if (msg.debugInfo) {
        const d = msg.debugInfo;
        const debug = {
          inFrame: d.inFrame,
          consecutiveSync: d.consecutiveSync,
          bitsCollected: d.bitsCollected,
          pilotFreq: d.pilotFreq || 0,
          pilotAmplitude: d.pilotAmp || 0,
          signalToNoise: d.signalToNoise || 0,
          noiseFloor: d.noiseFloor || [0, 0, 0, 0],
          energies: d.energies || [0, 0, 0, 0],
          relI: d.relI || [0, 0, 0, 0],
          relQ: d.relQ || [0, 0, 0, 0],
          bitPattern: d.bitPattern || 0,
          thresholds: d.thresholds || [0, 0, 0, 0],
          noiseFrames: d.noiseFrames || 0,
          blocksDecoded: d.bitsCollected ? 1 : 0, // approximate
          blocksCrcFailed: 0,
          noiseAvg: d.noiseAvg || 0,
        };
        setState({ debug });

        // Update recv status from decoder state
        const nf = d.noiseFrames ?? 0;
        let recvStatus: { type: string; msg: string };
        if (d.inFrame && d.bitsCollected > 0) {
          recvStatus = { type: "success", msg: `📥 Receiving — ${d.bitsCollected} bits` };
        } else if (nf < 25) {
          recvStatus = { type: "info", msg: `🔊 Noise profiling… ${nf}/25` };
        } else {
          recvStatus = { type: "success", msg: "✅ Ready — listening" };
        }
        setState({ recvStatus });
      }

      // Ingest debug events from the worker thread's debugLogger
      if (msg.debugEvents && Array.isArray(msg.debugEvents)) {
        debugLogger.ingest(msg.debugEvents);
      }

      if (msg.rawBytes) {
        const raw = new Uint8Array(msg.rawBytes);
        const hex = Array.from(raw.slice(0, 48))
          .map(b => b.toString(16).padStart(2, "0"))
          .join(" ");
        // Could show in payload display
      }
      break;
    }
  }
};

// ─── DOM refs (acquired lazily — React creates these) ──
let inputSelect: HTMLSelectElement | null = null;
let outputSelect: HTMLSelectElement | null = null;
let refreshBtn: HTMLButtonElement | null = null;
let fastSyncCb: HTMLInputElement | null = null;

function getDeviceRefs() {
  if (!inputSelect) {
    inputSelect = document.getElementById("inputSelect") as HTMLSelectElement;
    outputSelect = document.getElementById("outputSelect") as HTMLSelectElement;
    refreshBtn = document.getElementById("refreshDevices") as HTMLButtonElement;
    fastSyncCb = document.getElementById("fastSyncCb") as HTMLInputElement;
    refreshBtn?.addEventListener("click", refreshDeviceList);
    inputSelect.addEventListener("change", () => { selectedInputId = inputSelect!.value; });
    outputSelect.addEventListener("change", () => { selectedOutputId = outputSelect!.value; });
  }
}

// ─── State ────────────────────────────────────────────

let selectedFile: File | null = null;
let receivedFileData: Array<{ name: string; bytes: Uint8Array; blob: Blob; url: string }> = [];
const audioCtx = new AudioContext();
const viz = new Visualizer();
const player = new AudioPlayer(audioCtx);

// ─── Device Enumeration ───────────────────────────────

async function refreshDeviceList() {
  getDeviceRefs();
  if (!inputSelect || !outputSelect) return;
  try {
    const { inputs, outputs } = await enumerateDevices();
    populateSelect(inputSelect, inputs, "");
    populateSelect(outputSelect, outputs, "");
  } catch { /* silent */ }
}

// React calls this after mount
(window as any).eardropRefreshDevices = refreshDeviceList;

// ─── Custom Events from React ─────────────────────────

// File selection
window.addEventListener("eardrop-file", ((e: CustomEvent) => {
  selectedFile = e.detail.file;
}) as EventListener);

// Send
window.addEventListener("eardrop-send", (async () => {
  if (!selectedFile) return;
  await refreshDeviceList();
  if (!isListening) await startListening();
  try {
    setState({ isSending: true, sendStatus: { type: "info", msg: "Encoding…" } });
    const raw = new Uint8Array(await selectedFile.arrayBuffer());
    const packet = buildPacket(selectedFile.name, raw);
    showTxPayload(raw, selectedFile.name);

    const cfg = { pilotFreqHz: getState().pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz };
    const outputRate = player.getSampleRate();
    const { samples: playSamples } = await encodeToOutputRateInWorker(packet, outputRate, cfg);
    setState({ sendStatus: { type: "info", msg: `Playing ${selectedFile.name}…` } });
    await player.play(playSamples, outputRate, selectedOutputId || undefined);
    setState({ isSending: false, sendStatus: { type: "success", msg: `✅ Sent ${selectedFile.name}` } });
  } catch (err: any) {
    setState({ isSending: false, sendStatus: { type: "error", msg: `❌ ${err.message}` } });
  }
}) as EventListener);

// Record toggle
window.addEventListener("eardrop-record", (async () => {
  if (isListening) { stopListening(); return; }
  await startListening();
}) as EventListener);

// Debug toggle — enable/disable verbose console logging
window.addEventListener("eardrop-toggle-debug", ((e: CustomEvent) => {
  DEBUG = e.detail?.visible ?? !DEBUG;
  if (DEBUG) {
    console.log = _origLog;
    console.log("🦻 Debug logging ON");
  } else {
    console.log = function() {};
  }
}) as EventListener);

// Expose DEBUG state so broadcast worker can pick it up
(window as any).eardropDebugEnabled = () => DEBUG;

// Self-test
window.addEventListener("eardrop-self-test", (async () => {
  await runSelfTest();
}) as EventListener);

// Send test (hello.txt)
window.addEventListener("eardrop-send-test", (async () => {
  await refreshDeviceList();
  if (!isListening) await startListening();
  const text = "Hello World\n";
  const raw = new TextEncoder().encode(text);
  const packet = buildPacket("hello.txt", raw);
  showTxPayload(raw, "hello.txt");
  setState({ sendStatus: { type: "info", msg: "📤 Sending test…" } });
  try {
    const cfg = { pilotFreqHz: getState().pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz };
    const outputRate = player.getSampleRate();
    const { samples: playSamples } = await encodeToOutputRateInWorker(packet, outputRate, cfg);
    await player.play(playSamples, outputRate, selectedOutputId || undefined);
    setState({ sendStatus: { type: "success", msg: "✅ Test sent" } });
  } catch (err: any) {
    setState({ sendStatus: { type: "error", msg: `❌ ${err.message}` } });
  }
}) as EventListener);

// Acoustic sweep
window.addEventListener("eardrop-acoustic-sweep", (async () => {
  setState({ sendStatus: { type: "info", msg: "🔊 Sweep starting…" }, sweepResults: null });
  if (!isListening) await startListening();
  await new Promise(r => setTimeout(r, 300));

  const modemRate = DEFAULT_CONFIG.sampleRate;
  const outputRate = player.getSampleRate();
  console.log("[SWEEP] audioCtx.sampleRate=", audioCtx.sampleRate, "outputRate=", outputRate, "modemRate=", modemRate);
  console.log("[SWEEP] recvSamples count in last second:", recvSamples.length - Math.max(0, recvSamples.length - 3500));
  const sweepFreqs: number[] = [];
  for (let f = 100; f <= 1500; f += 50) sweepFreqs.push(f);

  const results: Array<{ freq: number; energy: number }> = [];
  const toneSamples = Math.floor(modemRate * 0.12);

  for (let fi = 0; fi < sweepFreqs.length; fi++) {
    const freq = sweepFreqs[fi];
    const tone = new Float32Array(toneSamples);
    for (let i = 0; i < toneSamples; i++) {
      tone[i] = Math.sin(2 * Math.PI * freq * i / modemRate) * 0.8;
    }
    const playBuf = resampleAudio(tone, modemRate, outputRate);
    const recvCount = recvSamples.length;
    await player.play(playBuf, outputRate, selectedOutputId || undefined);
    await new Promise(r => setTimeout(r, 50));

    const newSamples = recvSamples.slice(recvCount);
    if (newSamples.length >= 64) {
      const buf = newSamples.slice(-Math.min(256, newSamples.length));
      // At mid-range tones, scan full band with 5Hz resolution to detect shift
      if (freq >= 400 && freq <= 600) {
        let bestFreq = freq, bestE = 0;
        for (let fb = freq - 50; fb <= freq + 50; fb += 5) {
          const e = detectToneEnergy(buf, fb, modemRate);
          if (e > bestE) { bestE = e; bestFreq = fb; }
        }
        if (bestE > 1e-7) {
          console.log(`[SWEEP] Played ${freq}Hz → peak at ${bestFreq}Hz (${bestE.toExponential(3)}) — ${freq === bestFreq ? '✓ match' : '✗ SHIFTED by ' + (bestFreq - freq) + 'Hz'}`);
        } else {
          console.log(`[SWEEP] Played ${freq}Hz — no peak found above threshold`);
        }
      }
      results.push({ freq, energy: detectToneEnergy(buf, freq, modemRate) });
    } else {
      results.push({ freq, energy: 0 });
    }
    if (fi % 5 === 0 || fi === sweepFreqs.length - 1) {
      setState({ sweepResults: [...results], sendStatus: { type: "info", msg: `🔊 Sweep: ${fi + 1}/${sweepFreqs.length} (${freq}Hz)` } });
    }
  }
  setState({ sweepResults: results, sendStatus: { type: "success", msg: `✅ Sweep done — ${results.length} frequencies` } });
}) as EventListener);

function resampleAudio(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.ceil(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio, idx = Math.floor(pos), frac = pos - idx;
    const a = input[idx] ?? 0, b = input[Math.min(idx + 1, input.length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// ─── Receive ──────────────────────────────────────────

let recorder: AudioRecorder | null = null;
let recvTimer: number | null = null;
let micWatchdog: ReturnType<typeof setTimeout> | null = null;
let recvSamples: number[] = [];
let tickCount = 0;
let isListening = false;
let selectedInputId = "";
let selectedOutputId = "";

// Device change listeners are set up in getDeviceRefs()

function recvBuf(existing: Uint8Array[], chunk: Uint8Array) {
  existing.push(chunk);
  totalDecoded += chunk.length;
}

function tryFinalize() {
  const full = new Uint8Array(totalDecoded);
  let off = 0;
  for (const c of decodedAccumulated) { full.set(c, off); off += c.length; }

  if (totalDecoded < 12) return;

  const parsed = tryParsePreamble(full);
  if (!parsed) {
    if (totalDecoded > 256) {
      const drop = totalDecoded - 128;
      let toDrop = drop;
      while (toDrop > 0 && decodedAccumulated.length > 0) {
        const first = decodedAccumulated[0];
        if (first.length <= toDrop) { toDrop -= first.length; decodedAccumulated.shift(); }
        else { decodedAccumulated[0] = first.slice(toDrop); toDrop = 0; }
      }
      totalDecoded -= drop;
    }
    setState({ recvStatus: { type: "info", msg: `📥 ${totalDecoded}B — waiting for preamble…` } });
    return;
  }

  const payloadStart = parsed.consumed;
  const needTotal = payloadStart + parsed.preamble.totalSize;

  if (full.length < needTotal) {
    payloadCollected = full.length - payloadStart;
    const pct = Math.floor(payloadCollected / parsed.preamble.totalSize * 100);
    setState({
      progress: pct,
      recvStatus: { type: "info", msg: `📥 ${parsed.preamble.fileName} — ${pct}%` },
    });
    return;
  }

  const payload = full.slice(payloadStart, payloadStart + parsed.preamble.totalSize);
  if (!verifyPayload(parsed.preamble, payload)) {
    setState({ recvStatus: { type: "error", msg: "❌ CRC mismatch — file corrupted" } });
    return;
  }

  const blob = new Blob([payload]);
  const url = URL.createObjectURL(blob);
  receivedFileData.push({ name: parsed.preamble.fileName, bytes: payload, blob, url });
  showRxPayload(payload, parsed.preamble.fileName);
  setState({
    receivedFiles: receivedFileData.map(f => ({ name: f.name, url: f.url, size: f.bytes.length })),
    recvStatus: { type: "success", msg: `✅ Received ${parsed.preamble.fileName}` },
    progress: 100,
  });

  decodedAccumulated = [];
  totalDecoded = 0;
  parsedPreamble = null;
  payloadCollected = 0;
}

async function startListening() {
  try {
    isListening = true;
    recvSamples = [];
    tickCount = 0;
    decodedAccumulated = [];
    totalDecoded = 0;
    parsedPreamble = null;
    payloadCollected = 0;
    wasInFrame = false;
    setState({ isListening: true, recvStatus: { type: "info", msg: "🔊 Noise profiling…" }, progress: 0 });

    broadcastWorker.postMessage({ type: "startListening", config: DEFAULT_CONFIG, fastSync: fastSyncCb?.checked ?? false });
    recorder = new AudioRecorder(audioCtx);
    const modemRate = DEFAULT_CONFIG.sampleRate;

    const feedSample = (s: number) => {
      broadcastWorker.postMessage({ type: "feedSample", sample: s });
      recvSamples.push(s);
      if (recvSamples.length > modemRate * 10) recvSamples.splice(0, recvSamples.length - modemRate * 5);
    };
    await recorder.start(modemRate, feedSample, selectedInputId || undefined);

    micWatchdog = setTimeout(() => {
      if (recvSamples.length === 0) {
        setState({ recvStatus: { type: "error", msg: "❌ No mic samples — AudioContext may be blocked" } });
      }
    }, 1500);

    recvTimer = window.setInterval(() => {
      const n = recvSamples.length;
      if (n === 0) return;

      if (micWatchdog) { clearTimeout(micWatchdog); micWatchdog = null; }
      if (n < 64) return;

      const tail = Math.min(n, 256);
      const buf = recvSamples.slice(n - tail, n);

      let sumSq = 0;
      for (const s of buf) sumSq += s * s;
      const rms = Math.sqrt(sumSq / buf.length);
      const rmsDb = rms > 0.0001 ? 20 * Math.log10(rms) : -80;
      const energies = TONES.map(f => detectToneEnergy(buf, f, modemRate));
      setState({ micLevel: rmsDb, toneEnergies: energies });

      // Throttle waveform to ~2fps
      tickCount++;
      if (tickCount % 5 === 0) {
        setState({ debugSamples: new Float32Array(recvSamples) });
      }
    }, 100);
  } catch (err: any) {
    isListening = false;
    setState({ isListening: false, recvStatus: { type: "error", msg: `❌ Mic access: ${err.message}` } });
  }
}

function stopListening() {
  isListening = false;
  if (micWatchdog) { clearTimeout(micWatchdog); micWatchdog = null; }
  recorder?.stop();
  recorder = null;
  if (recvTimer) { clearInterval(recvTimer); recvTimer = null; }
  broadcastWorker.postMessage({ type: "stopListening" });
  setState({ isListening: false, recvStatus: { type: "info", msg: "⏸ Stopped" } });
}

// ─── TX / RX Payload Display ────────────────────────

function formatPayloadHex(bytes: Uint8Array, max = 96): string {
  const slice = bytes.slice(0, max);
  const lines: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const h = Array.from(slice.slice(i, i + 16))
      .map(b => b.toString(16).padStart(2, "0"))
      .join(" ");
    const a = Array.from(slice.slice(i, i + 16))
      .map(b => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${h.padEnd(48)}  ${a}`);
  }
  if (bytes.length > max) lines.push(`... ${bytes.length - max} more bytes`);
  return lines.join("\n");
}

function showTxPayload(bytes: Uint8Array, fileName: string) {
  setState({ txPayload: { name: fileName, bytes: formatPayloadHex(bytes) } });
}

function showRxPayload(bytes: Uint8Array, fileName: string) {
  setState({ rxPayload: { name: fileName, bytes: formatPayloadHex(bytes) } });
}

// ─── Tone Energy Detection ────────────────────────────

const TONES = [675, 875, 1075, 1275];

function detectToneEnergy(samples: number[], freq: number, sampleRate: number): number {
  let sinCorr = 0, cosCorr = 0;
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const phase = (2 * Math.PI * freq * i) / sampleRate;
    sinCorr += samples[i] * Math.sin(phase);
    cosCorr += samples[i] * Math.cos(phase);
  }
  return (sinCorr * sinCorr + cosCorr * cosCorr) / (n * n);
}

// ─── Self Test ────────────────────────────────────────

async function runSelfTest() {
  const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
  setState({ sendStatus: { type: "info", msg: "🧪 Running self-test…" } });

  // Encode the raw test data directly for a clean modem loopback
  const encoder = new Encoder(DEFAULT_CONFIG);
  const samples = encoder.encode(testData);

  const testDecoder = new Decoder(DEFAULT_CONFIG);
  testDecoder.fastSync = true;
  testDecoder.reset();
  for (const s of samples) testDecoder.feedSample(s);

  const blocksOk = testDecoder.framedDecoder.blocksDecoded;
  const crcFail = testDecoder.framedDecoder.blocksCrcFailed;
  // Self-test passes if blocks were decoded with no CRC failures
  // (Data matching is verified by unit tests)
  const passed = blocksOk > 0 && crcFail === 0;

  // Update self-test result in the DOM
  const el = document.getElementById("selfTestResult");
  if (el) {
    el.textContent = passed
      ? `✅ PASS: ${blocksOk} blocks decoded, ${crcFail} CRC failures`
      : `❌ FAIL: ${blocksOk} blocks, ${crcFail} CRC failures`;
  }
  setState({
    sendStatus: { type: passed ? "success" : "error", msg: passed ? "✅ Self-test PASS" : "❌ Self-test FAIL" },
    debugSamples: samples,
  });
}

// Expose self-test for event wiring
(window as any).runSelfTest = runSelfTest;

// ─── Init ─────────────────────────────────────────────

console.log("🦻 Eardrop controller ready");

/**
 * App — main UI thread.
 *
 * Architecture:
 *   ┌─ Main thread ──────────────────────────────────────┐
 *   │  Debug view (visualizer, canvases, stats)          │
 *   │  AudioRecorder (needs AudioContext + getUserMedia)  │
 *   │  AudioPlayer   (needs AudioContext)                 │
 *   │  Thin control layer (button handlers, DOM updates)  │
 *   └────────────────────────────────────────────────────┘
 *          │                              ▲
 *          │  encode task                 │  decoded samples
 *          ▼                              │
 *   ┌─ EncoderWorker ───┐    ┌─ BroadcastWorker ───┐
 *   │  Encoder.encode() │    │  Decoder state      │
 *   │  encodeToOutput() │    │  feedSample()       │
 *   └───────────────────┘    └─────────────────────┘
 *
 * Encoding (TX) runs in encoder.worker → main plays result.
 * Decoding (RX) runs in broadcast.worker → main receives frames.
 * Both are off the main thread so debug view never lags.
 */

import "../style.css";

// Enable verbose debug logging for development. Set to false for production / agentic AI use to keep output concise.
let DEBUG = false;
const _origLog = console.log;
const _origError = console.error;
function setDebug(val: boolean) {
  DEBUG = val;
  if (DEBUG) {
    console.log = _origLog;
    console.error = _origError;
  } else {
    console.log = function () {};
    console.error = function () {};
  }
  // Update UI if element exists
  if (typeof debugToggleBtn !== 'undefined' && debugToggleBtn) {
    debugToggleBtn.textContent = DEBUG ? "Debug: On" : "Debug: Off";
  }
}
// Console silencing will be initialized after UI elements are ready.




import { Encoder } from "../modem/encoder";
import { Decoder } from "../modem/decoder";
import { AudioPlayer } from "../audio/player";
import { AudioRecorder } from "../audio/recorder";
import { Visualizer } from "../modem/visualizer";
import { DEFAULT_CONFIG, getDefaultToneFreqs, TONE_COLORS } from "../modem/types";
import { enumerateDevices, populateSelect } from "../audio/devices";
import { buildPacket, tryParsePreamble, verifyPayload, preambleSize } from "../protocol";

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
const encodeTasks = new Map<
  number,
  {
    resolve: (s: { samples: Float32Array; sampleRate: number }) => void;
    reject: (err: Error) => void;
  }
>();
let encodeIdCounter = 0;

encoderWorker.onmessage = (e) => {
  const msg = e.data;
  const task = encodeTasks.get(msg.id);
  if (!task) return;
  encodeTasks.delete(msg.id);

  if (msg.type === "encoded") {
    task.resolve({
      samples: new Float32Array(msg.samples),
      sampleRate: msg.sampleRate,
    });
  } else if (msg.type === "error") {
    console.error("[EncoderWorker]", msg.error);
    task.reject(new Error(msg.error));
  }
};

/** Encode data in the encoder worker thread — returns once encoding is done. */
function encodeInWorker(
  data: Uint8Array,
  config?: Partial<typeof DEFAULT_CONFIG>,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const id = ++encodeIdCounter;
    encodeTasks.set(id, { resolve, reject });
    // Post a Uint8Array so the worker's Encoder.encode() receives what it expects
    const copy = new Uint8Array(data);
    encoderWorker.postMessage(
      { type: "encode", id, data: copy, config },
      { transfer: [copy.buffer] },
    );
  });
}

function encodeToOutputRateInWorker(
  data: Uint8Array,
  outputRate: number,
  config?: Partial<typeof DEFAULT_CONFIG>,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const id = ++encodeIdCounter;
    encodeTasks.set(id, { resolve, reject });
    const copy = new Uint8Array(data);
    encoderWorker.postMessage(
      { type: "encodeToOutput", id, data: copy, outputRate, config },
      { transfer: [copy.buffer] },
    );
  });
}

// ─── Broadcast worker messages ──────────────────────

/** Last few frames of debug log from the decoder (for display) */
let recentDecodeLog: any[] = [];
/** Hex dump of raw decoded bytes (before preamble parsing) */
let lastRawBytesHex = "";
/** Track decoder inFrame transitions — clear accumulator on new session */
let wasInFrame = false;

broadcastWorker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "listening":
      if (DEBUG) console.log("[APP] broadcast worker alive — listener started");
      decoderStateEl.textContent = "listener started — awaiting first sample…";
      break;
    case "stopped":
      if (DEBUG) console.log("[APP] listener stopped");
      decoderStateEl.textContent = "listener stopped";
      break;
    case "frame": {
      const chunk = new Uint8Array(msg.data);
      if (DEBUG) console.log(`[APP] frame rx: ${chunk.length}B total=${totalDecoded + chunk.length} hex=${Array.from(chunk.slice(0, 16)).map(b=>b.toString(16).padStart(2,"0")).join(" ")}`);
      recvBuf(decodedAccumulated, chunk);
      tryFinalize();
      break;
    }
    case "decoderState": {
      // Clear accumulated garbage when decoder starts a new data session
      if (msg.debugInfo && msg.debugInfo.inFrame && !wasInFrame) {
        if (DEBUG) console.log("[APP] new decode session — clearing accumulator");
        decodedAccumulated = [];
        totalDecoded = 0;
        parsedPreamble = null;
        payloadCollected = 0;
      }
      wasInFrame = msg.debugInfo?.inFrame ?? false;
      // Log every state update to console so user can see energies / noise
      if (msg.debugInfo) {
        const d = msg.debugInfo;
        if (DEBUG) console.log(
          `[DEC] in=${d.inFrame?1:0} sync=${d.consecutiveSync} skip=${d.frameSkip??"?"} bits=${d.bitsCollected}` +
          ` | SNR=${(d.signalToNoise??0).toFixed(1)} fss=${d.framesSinceStrong??"?"} fex=${d.framesSinceExit??"?"}` +
          ` | b=${(d.bitPattern??0).toString(2).padStart(4,"0")}` +
          (d.ratios ? ` r=[${d.ratios.map((v:number)=>v.toFixed(2)).join(" ")}]` : "") +
          ` avg=${d.avg.toExponential(2)}>thr=${(d.burstThreshold??0).toExponential(2)}` +
          ` ${d.strong?"S":"_"}`,
        );
      } else {
        if (DEBUG) console.log(`[DEC] profiling — ${msg.bitsCollected} samples, no frame yet`);
      }

      // ── Update listening status based on phase ──
      if (msg.debugInfo) {
        const nf = (msg.debugInfo as any).noiseFrames ?? 0;
        if (msg.debugInfo.inFrame && msg.debugInfo.strong) {
          setStatus(recvStatus, "success", `📥 Receiving — ${msg.debugInfo.bitsCollected} bits`);
        } else if (nf < 25) {
          setStatus(recvStatus, "info", `🔊 Checking noise floor… ${nf}/25`);
        } else if (msg.debugInfo.inFrame) {
          setStatus(recvStatus, "info", `📥 Receiving — ${msg.debugInfo.bitsCollected} bits`);
        } else {
          setStatus(recvStatus, "success", `✅ Ready — listening for files`);
        }
      }

      // Update raw bytes display
      if (msg.rawBytes) {
        const raw = new Uint8Array(msg.rawBytes);
        lastRawBytesHex = Array.from(raw.slice(0, 64))
          .map((b: number) => b.toString(16).padStart(2, "0"))
          .join(" ");
      }
      if (msg.recentLog) {
        recentDecodeLog = msg.recentLog;
      }

      // Always build state text — even if debugInfo is null (still calibrating)
      if (debugVisible) {
        let s: string;
        if (msg.debugInfo) {
          const last = msg.debugInfo;
          const thresholds = last.thresholds?.map((t: number) => t.toFixed(4)) ?? ["?"];
          const noiseMax = (last as any).noiseMax?.map((n: number) => n.toFixed(4)) ?? ["?"];

          s = `sync: ${last.consecutiveSync} | inFrame: ${last.inFrame} | bits: ${last.bitsCollected}\n` +
            `eng: ${last.energies.map((e: number) => e.toFixed(4))} | avg: ${last.avg.toFixed(4)}\n` +
            `noise: ${last.noiseAvg.toFixed(4)} | floor: ${last.noiseFloor.map((n: number) => n.toFixed(4))}\n` +
            `max: ${noiseMax.join(" ")} | thr: ${thresholds.join(" ")}`;

          // Add recent frames
          if (recentDecodeLog.length >= 2) {
            s += `\n--- last ${recentDecodeLog.length} frames ---`;
            for (const f of recentDecodeLog) {
              const bits = f.bitsCollected ?? 0;
              const eng = f.energies?.map((e: number) => e.toFixed(3)).join(" ") ?? "";
              const fStrong = f.strong ? "S" : "_";
              s += `\n  ${fStrong} bits=${bits} e=[${eng}]`;
            }
          }

          // Update live decode SNR
          const noise = last.noiseAvg;
          const avg = last.avg;
          if (noise > 1e-12 && avg > 1e-12) {
            const snrDb = 20 * Math.log10(avg / noise);
            const color = snrDb > 10 ? "#22c55e" : snrDb > 3 ? "#eab308" : "#ef4444";
            debugDecodeSnr.textContent = `${snrDb.toFixed(1)} dB`;
            debugDecodeSnr.style.color = color;
          } else if (avg > 0.001) {
            debugDecodeSnr.textContent = `sig ${avg.toFixed(4)}`;
            debugDecodeSnr.style.color = "#eab308";
          } else {
            debugDecodeSnr.textContent = `—`;
            debugDecodeSnr.style.color = "#666";
          }
        } else {
          s = `noise profiling: ${msg.bitsCollected} samples accumulated\n` +
            `waiting for sync… (mic level should show activity)`;
        }

        if (lastRawBytesHex) {
          s += `\n--- raw bytes (first 64) ---\n${lastRawBytesHex}`;
        }

        decoderStateEl.textContent = s;
      }
      updateProgress(msg.bitsCollected);
      break;
    }
  }
};

// ─── DOM refs: main UI ────────────────────────────────
const dropZone = document.getElementById("dropZone")!;
const fileInput = document.getElementById("fileInput") as HTMLInputElement;
const fileInfo = document.getElementById("fileInfo")!;
const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
const sendStatus = document.getElementById("sendStatus")!;
const recordBtn = document.getElementById("recordBtn") as HTMLButtonElement;
const recvStatus = document.getElementById("recvStatus")!;
const recvProgress = document.getElementById("recvProgress")!;
const recvBar = document.getElementById("recvBar")!;
const recvBits = document.getElementById("recvBits")!;
const downloadArea = document.getElementById("downloadArea")!;

// ─── DOM refs: device picker ──────────────────────────
const inputSelect = document.getElementById("inputSelect") as HTMLSelectElement;
const outputSelect = document.getElementById("outputSelect") as HTMLSelectElement;
const refreshBtn = document.getElementById("refreshDevices") as HTMLButtonElement;

// ─── DOM refs: debug panel ────────────────────────────
const debugPanel = document.getElementById("debugPanel")!;
const debugBadge = document.getElementById("debugBadge")!;
const debugHeader = document.getElementById("debugHeader")!;
const debugClose = document.getElementById("debugClose")!;
const debugMinimize = document.getElementById("debugMinimize")!;
const debugResizeHandle = document.getElementById("debugResizeHandle")!;
const debugStats = document.getElementById("debugStats")!;
const dbgWaveform = document.getElementById("dbgWaveform") as HTMLCanvasElement;
const dbgSpectrogram = document.getElementById("dbgSpectrogram") as HTMLCanvasElement;
const dbgToneEnergy = document.getElementById("dbgToneEnergy") as HTMLCanvasElement;
const dbgSplitCarriers = document.getElementById("dbgSplitCarriers") as HTMLCanvasElement;
const selfTestBtn = document.getElementById("selfTestBtn") as HTMLButtonElement;
const sendTestBtn = document.getElementById("sendTestBtn") as HTMLButtonElement;
const debugToggleBtn = document.getElementById("debugToggleBtn") as HTMLButtonElement;
const fastSyncCb = document.getElementById("fastSyncCb") as HTMLInputElement;
// Initialize debug flag UI and console behavior
setDebug(DEBUG);
const selfTestResult = document.getElementById("selfTestResult")!;
const decoderStateEl = document.getElementById("decoderState")!;
const dbgTxPayload = document.getElementById("dbgTxPayload")!;
const dbgRxPayload = document.getElementById("dbgRxPayload")!;
const debugMicMeter = document.getElementById("debugMicMeter")!;
const debugMicLevelNum = document.getElementById("debugMicLevelNum")!;
const debugToneRow = document.getElementById("debugToneRow")!;
const debugDecodeSnr = document.getElementById("debugDecodeSnr")!;

/** Tone frequencies used by the modem */
const TONES = getDefaultToneFreqs();

// ─── State ────────────────────────────────────────────
let selectedFile: File | null = null;
let receivedFiles: Array<{ name: string; bytes: Uint8Array; blob: Blob; url: string }> = [];
let receivedFileName = "received.dat";
let debugVisible = false;
let debugAnimId: number | null = null;
let debugSamples: Float32Array | null = null;
let selectedInputId = "";
let selectedOutputId = "";

// Shared AudioContext — Chrome suspends secondary contexts, so player and
// recorder must use the same one to both work simultaneously.
const audioCtx = new AudioContext();
const viz = new Visualizer();
const player = new AudioPlayer(audioCtx);

// ─── Device enumeration ───────────────────────────────

async function refreshDeviceList() {
  try {
    const { inputs, outputs } = await enumerateDevices();
    populateSelect(inputSelect, inputs, selectedInputId);
    populateSelect(outputSelect, outputs, selectedOutputId);
  } catch { /* silent */ }
}

inputSelect.addEventListener("change", () => { selectedInputId = inputSelect.value; });
outputSelect.addEventListener("change", () => { selectedOutputId = outputSelect.value; });
refreshBtn.addEventListener("click", refreshDeviceList);

// Enumerate on load
refreshDeviceList();

// ─── Debug panel toggle (Ctrl+Shift+D) ────────────────

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === "D") {
    e.preventDefault();
    toggleDebug();
  }
});
// ─── Debug window drag/resize/minimize ─────────────

let dragOffsetX = 0, dragOffsetY = 0;

function startDrag(e: MouseEvent) {
  if ((e.target as HTMLElement).closest(".debug-header-btns")) return;
  const rect = debugPanel.getBoundingClientRect();
  dragOffsetX = e.clientX - rect.left;
  dragOffsetY = e.clientY - rect.top;
  document.addEventListener("mousemove", onDrag);
  document.addEventListener("mouseup", stopDrag);
}
function onDrag(e: MouseEvent) {
  debugPanel.style.left = `${e.clientX - dragOffsetX}px`;
  debugPanel.style.top = `${e.clientY - dragOffsetY}px`;
}
function stopDrag() {
  document.removeEventListener("mousemove", onDrag);
  document.removeEventListener("mouseup", stopDrag);
}

debugHeader.addEventListener("mousedown", startDrag);

// Resize
let resizeStartX = 0, resizeStartY = 0, resizeStartW = 0, resizeStartH = 0;

debugResizeHandle.addEventListener("mousedown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const rect = debugPanel.getBoundingClientRect();
  resizeStartX = e.clientX;
  resizeStartY = e.clientY;
  resizeStartW = rect.width;
  resizeStartH = rect.height;
  document.addEventListener("mousemove", onResize);
  document.addEventListener("mouseup", stopResize);
});
function onResize(e: MouseEvent) {
  const w = Math.max(320, resizeStartW + (e.clientX - resizeStartX));
  const h = Math.max(240, resizeStartH + (e.clientY - resizeStartY));
  debugPanel.style.width = `${w}px`;
  debugPanel.style.height = `${h}px`;
  // Trigger canvas re-render
  if (debugVisible && debugSamples) renderDebug();
}
function stopResize() {
  document.removeEventListener("mousemove", onResize);
  document.removeEventListener("mouseup", stopResize);
}

// Minimize / badge
debugClose.addEventListener("click", () => { toggleDebug(false); });
debugMinimize.addEventListener("click", () => { toggleDebug(false); showBadge(); });
debugBadge.addEventListener("click", () => { hideBadge(); toggleDebug(true); });

function showBadge() { debugBadge.classList.remove("hidden"); }
function hideBadge() { debugBadge.classList.add("hidden"); }

function toggleDebug(force?: boolean) {
  debugVisible = force !== undefined ? force : !debugVisible;
  debugPanel.classList.toggle("hidden", !debugVisible);
  if (debugVisible && debugSamples) {
    renderDebug();
  } else if (!debugVisible && debugAnimId) {
    cancelAnimationFrame(debugAnimId);
    debugAnimId = null;
  }
  if (!debugVisible) hideBadge();
  setTimeout(() => window.dispatchEvent(new Event("resize")), 100);
}

function renderDebug() {
  if (!debugSamples || !debugVisible) return;
  viz.drawWaveform(dbgWaveform, debugSamples);
  viz.drawSpectrogram(dbgSpectrogram, debugSamples);
  viz.drawToneEnergy(dbgToneEnergy, debugSamples);
  viz.drawSplitCarriers(dbgSplitCarriers, debugSamples);

  const dur = debugSamples.length / DEFAULT_CONFIG.sampleRate;
  debugStats.textContent =
    `🔊 ${debugSamples.length.toLocaleString()} samples | ${dur.toFixed(1)}s | ${DEFAULT_CONFIG.sampleRate} Hz` +
    (selectedInputId ? ` | 🎤 ${inputSelect.options[inputSelect.selectedIndex]?.text ?? "default"}` : "") +
    (selectedOutputId ? ` | 🔊 ${outputSelect.options[outputSelect.selectedIndex]?.text ?? "default"}` : "");

  debugAnimId = requestAnimationFrame(renderDebug);
}

// ─── Self-test (encode → decode in software) ────────

selfTestBtn.addEventListener("click", async () => {
  const testData = new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]); // "Hello"
  const packet = buildPacket("self-test.txt", testData);

  selfTestResult.textContent = `Encoding ${packet.length} bytes (preamble+payload) in worker…`;
  selfTestResult.className = "self-test-result";

  // Encode in worker thread — main thread stays responsive
  const { samples } = await encodeInWorker(packet);

  // Decode on main thread (fast for tiny data, keeps debugLog accessible for failure output)
  const testDecoder = new Decoder(DEFAULT_CONFIG);
  testDecoder.logging = true;
  testDecoder.fastSync = true;
  testDecoder.reset();
  for (const s of samples) {
    testDecoder.feedSample(s);
  }

  const decoded = testDecoder.flush();
  const match =
    decoded.length === packet.length &&
    decoded.every((b, i) => b === packet[i]);

  if (match) {
    selfTestResult.textContent = `✅ PASS: ${decoded.length} bytes roundtrip OK`;
    selfTestResult.className = "self-test-result pass";
  } else {
    const hex = Array.from(decoded)
      .map((b) => "0x" + b.toString(16).padStart(2, "0"))
      .join(" ");
    const expected = Array.from(testData)
      .map((b) => "0x" + b.toString(16).padStart(2, "0"))
      .join(" ");
    selfTestResult.textContent =
      decoded.length > 0
        ? `⚠️ MISMATCH: got ${decoded.length} bytes (expected ${packet.length})\n  sent: ${expected}\n  recv: ${hex}`
        : `❌ FAIL: no decoded data — check console for decoder log`;
    selfTestResult.className = "self-test-result fail";
    console.table(testDecoder.debugLog.slice(-25));
  }

  // Show in debug view
  showTxPayload(testData, "self-test.txt");
  if (decoded.length > 0) {
    showRxPayload(decoded, "self-test.txt");
  }
  debugSamples = samples;
  if (debugVisible) renderDebug();
});

// ─── Send Test (hello world as .txt) ──────────────────

debugToggleBtn.addEventListener("click", () => {
  setDebug(!DEBUG);
});

sendTestBtn.addEventListener("click", async () => {
  await refreshDeviceList();
  if (!isListening) await startListening();
  const text = "Hello World\n";
  const raw = new TextEncoder().encode(text);
  const fileName = "hello.txt";

  if (DEBUG) console.log("[SEND] Sending test:", { text: text.trim(), bytes: raw.length, fileName });

  try {
    setStatus(sendStatus, "info", `Sending test "${text.trim()}"…`);

    // Wrap with preamble
    const packet = buildPacket(fileName, raw);
    if (DEBUG) console.log("[SEND] Packet built:", { packetSize: packet.length });
    showTxPayload(raw, fileName);

    // Encode at modem rate
    if (DEBUG) console.log("[SEND] Encoding at modem rate…");
    const { samples: modemSamples, sampleRate: modemRate } = await encodeInWorker(packet);
    if (DEBUG) console.log("[SEND] Encoded at modem rate:", { samples: modemSamples.length, sampleRate: modemRate });
    debugSamples = modemSamples;
    if (debugVisible) renderDebug();

    // Encode at output rate for playback
    const outputRate = player.getSampleRate();
    if (DEBUG) console.log("[SEND] Encoding at output rate:", { outputRate });
    const { samples: playSamples, sampleRate: playRate } = await encodeToOutputRateInWorker(packet, outputRate);
    if (DEBUG) console.log("[SEND] Playing:", { samples: playSamples.length, sampleRate: playRate });

    // Play through speaker
    await player.play(playSamples, outputRate, selectedOutputId || undefined);
    if (DEBUG) console.log("[SEND] Playback complete");
    setStatus(sendStatus, "success", `✅ Sent "${fileName}" — check receiver`);
  } catch (err: any) {
    if (DEBUG) console.error("[SEND] FAILED:", err);
    setStatus(sendStatus, "error", `❌ Test send failed: ${err.message}`);
  }
});

// ─── Send ─────────────────────────────────────────────

dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropZone.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (file) selectFile(file);
});
// Label has for="fileInput" — native click opens the dialog, no JS needed.
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) selectFile(file);
  // Reset so selecting the same file again still fires change
  fileInput.value = "";
});

function selectFile(file: File) {
  selectedFile = file;
  fileInfo.textContent = `${file.name} (${formatSize(file.size)})`;
  fileInfo.classList.remove("hidden");
  sendBtn.disabled = false;
  receivedFileName = file.name;
}

sendBtn.addEventListener("click", async () => {
  await refreshDeviceList();
  if (!isListening) await startListening();
  if (!selectedFile) return;
  try {
    setStatus(sendStatus, "info", "Building preamble + encoding in worker…");

    const raw = new Uint8Array(await selectedFile.arrayBuffer());

    // ── Wrap with preamble: [nameLen|fileName|totalSize|crc32|payload] ──
    const packet = buildPacket(selectedFile.name, raw);
    setStatus(sendStatus, "info", `Encoding ${formatSize(packet.length)} total in worker…`);

    showTxPayload(raw, selectedFile.name);

    // ── Encode at modem rate (for debug view) — in worker ──
    const { samples: modemSamples } = await encodeInWorker(packet);
    debugSamples = modemSamples;
    if (debugVisible) renderDebug();

    // ── Encode at output rate (for playback) — in worker ──
    const outputRate = player.getSampleRate();
    setStatus(sendStatus, "info", `Encoding at ${outputRate} Hz in worker…`);
    const { samples: playSamples } = await encodeToOutputRateInWorker(packet, outputRate);

    // ── Play on main thread (non-blocking AudioContext) ──
    setStatus(sendStatus, "info", `Playing ${selectedFile!.name}…`);
    await player.play(playSamples, outputRate, selectedOutputId || undefined);
    setStatus(sendStatus, "success", `✅ Sent ${selectedFile!.name} (${formatSize(raw.length)})`);
  } catch (err: any) {
    setStatus(sendStatus, "error", `❌ Send failed: ${err.message}`);
  }
});

// ─── Receive ──────────────────────────────────────────

let recorder: AudioRecorder | null = null;
let recvTimer: number | null = null;
let micWatchdog: ReturnType<typeof setTimeout> | null = null;
let recvSamples: number[] = [];
let isListening = false;

// Preamble-aware receive state
let decodedAccumulated: Uint8Array[] = [];
let totalDecoded = 0;
let parsedPreamble: { preamble: import("../protocol").FilePreamble; consumed: number } | null = null;
let payloadCollected = 0;

recordBtn.addEventListener("click", async () => {
  if (isListening) {
    stopListening();
    return;
  }
  await startListening();
});

/** Append decoded chunk to the accumulation, try to finalize. */
function recvBuf(existing: Uint8Array[], chunk: Uint8Array) {
  existing.push(chunk);
  totalDecoded += chunk.length;
}

function tryFinalize() {
  // Concatenate all accumulated chunks
  const full = new Uint8Array(totalDecoded);
  let off = 0;
  for (const c of decodedAccumulated) {
    full.set(c, off);
    off += c.length;
  }

  // Don't scan for preamble until we have at least a full header
  if (totalDecoded < 12) {
    setStatus(recvStatus, "info", `📥 ${totalDecoded} raw bytes — buffering…`);
    return;
  }

  // Try to parse preamble
  const parsed = tryParsePreamble(full);
  if (!parsed) {
    if (DEBUG) console.log(`[APP] preamble scan: no valid preamble in ${totalDecoded}B`);
    // If garbage accumulates beyond a reasonable limit with no preamble, discard oldest
    if (totalDecoded > 256) {
      const drop = totalDecoded - 128;
      let toDrop = drop;
      while (toDrop > 0 && decodedAccumulated.length > 0) {
        const first = decodedAccumulated[0];
        if (first.length <= toDrop) {
          toDrop -= first.length;
          decodedAccumulated.shift();
        } else {
          decodedAccumulated[0] = first.slice(toDrop);
          toDrop = 0;
        }
      }
      totalDecoded -= drop;
      if (DEBUG) console.log(`[APP] discarded ${drop}B of garbage, ${totalDecoded}B remaining`);
    }
    setStatus(recvStatus, "info", `📥 ${totalDecoded} raw bytes — waiting for preamble…`);
    return;
  }

  if (DEBUG) console.log(`[APP] preamble FOUND: "${parsed.preamble.fileName}" ${parsed.preamble.totalSize}B off=${parsed.consumed}`);

  // Preamble found — check if we have the full payload
  const payloadStart = parsed.consumed;
  const needTotal = payloadStart + parsed.preamble.totalSize;

  // Tell decoder to auto-stop at exact byte count
  broadcastWorker.postMessage({ type: "setExpectedTotal", count: needTotal });

  if (full.length < needTotal) {
    payloadCollected = full.length - payloadStart;
    setStatus(recvStatus, "info",
      `📥 Receiving ${parsed.preamble.fileName} — ` +
      `${Math.min(payloadCollected, parsed.preamble.totalSize)}/${parsed.preamble.totalSize} bytes`);
    updateProgress(Math.floor(payloadCollected / parsed.preamble.totalSize * 200));
    return;
  }

  // ── Complete payload received ──
  const payload = full.slice(payloadStart, payloadStart + parsed.preamble.totalSize);

  if (!verifyPayload(parsed.preamble, payload)) {
    setStatus(recvStatus, "error", "❌ CRC mismatch — file corrupted during transfer");
    return;
  }

  receivedFileName = parsed.preamble.fileName;
  const blob = new Blob([payload]);
  const url = URL.createObjectURL(blob);
  receivedFiles.push({ name: parsed.preamble.fileName, bytes: payload, blob, url });
  showRxPayload(payload, parsed.preamble.fileName);
  setStatus(recvStatus, "success",
    `✅ Received ${parsed.preamble.fileName} (${formatSize(payload.length)}) — CRC OK  [${receivedFiles.length} file(s) total]`);
  updateProgress(200);
  showDownloads();

  // Reset accumulation
  decodedAccumulated = [];
  totalDecoded = 0;
  parsedPreamble = null;
  payloadCollected = 0;
}

async function startListening() {
  try {
    isListening = true;
    recvSamples = [];
    decodedAccumulated = [];
    totalDecoded = 0;
    parsedPreamble = null;
    payloadCollected = 0;
    wasInFrame = false;

    // Start decoder in broadcast worker
    broadcastWorker.postMessage({ type: "startListening", config: DEFAULT_CONFIG, fastSync: fastSyncCb.checked });

    recorder = new AudioRecorder(audioCtx);
    const modemRate = DEFAULT_CONFIG.sampleRate;

    const feedSample = (s: number) => {
      // Forward sample to broadcast worker (decoder runs off main thread)
      broadcastWorker.postMessage({ type: "feedSample", sample: s });
      // Keep a rolling buffer for debug visualization (small, fast)
      recvSamples.push(s);
      if (recvSamples.length > modemRate * 10) {
        recvSamples.splice(0, recvSamples.length - modemRate * 5);
      }
    };
    await recorder.start(modemRate, feedSample, selectedInputId || undefined);

    recordBtn.textContent = "⏹ Stop Listening";
    recordBtn.className = "btn danger";
    setStatus(recvStatus, "info", "🔊 Checking noise floor…");

    recvProgress.classList.remove("hidden");
    updateProgress(0);

    // Check if samples arrive within 1.5s — if not, the audio pipeline is broken
    micWatchdog = setTimeout(() => {
      if (recvSamples.length === 0) {
        const errMsg = "❌ Mic started but no samples after 1.5s — AudioContext may be blocked by browser autoplay policy. Click the page, then Stop + Start again.";
        setStatus(recvStatus, "error", errMsg);
        console.warn("[Mic] No samples from recorder — AudioContext may be suspended");
      }
    }, 1500);

    // Periodic debug view update — level meter, tone energies, waveform
    recvTimer = window.setInterval(() => {
      const n = recvSamples.length;

      if (n === 0) {
        debugMicMeter.style.width = `0%`;
        debugMicLevelNum.textContent = `⚠ no mic data`;
        debugMicLevelNum.style.color = "#ef4444";
        return;
      }

      // First sample arrived — clear watchdog
      if (micWatchdog) { clearTimeout(micWatchdog); micWatchdog = null; }

      if (n < 64) {
        // Too few samples for reliable RMS
        debugMicLevelNum.textContent = `⏳ buffering ${n}…`;
        debugMicLevelNum.style.color = "#eab308";
        return;
      }

      // Use the last 256 samples for live readings
      const tail = Math.min(n, 256);
      const buf = recvSamples.slice(n - tail, n);

      // ── Mic level RMS + peak ──
      let sumSq = 0;
      let peak = 0;
      for (const s of buf) {
        sumSq += s * s;
        const abs = Math.abs(s);
        if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const rmsDb = rms > 0.0001 ? 20 * Math.log10(rms) : -80;
      const pct = Math.min(100, (rms / 0.3) * 100);  // 0.3 = full scale reference
      debugMicMeter.style.width = `${pct}%`;
      debugMicLevelNum.textContent = `${rmsDb.toFixed(1)} dB`;
      debugMicLevelNum.style.color = rmsDb > -30 ? "#22c55e" : rmsDb > -50 ? "#eab308" : "#666";

      // ── Tone energy per carrier ──
      if (debugVisible) {
        const energies = TONES.map((freq) => detectToneEnergy(buf, freq, modemRate));
        let maxE = Math.max(...energies, 1e-12);
        updateToneBars(energies, maxE);

        // Update waveform canvas for debug view
        debugSamples = new Float32Array(recvSamples);
      }
    }, 100);
  } catch (err: any) {
    isListening = false;
    setStatus(recvStatus, "error", `❌ Mic access denied: ${err.message}`);
  }
}

function stopListening() {
  isListening = false;
  if (micWatchdog) { clearTimeout(micWatchdog); micWatchdog = null; }
  recorder?.stop();
  recorder = null;
  if (recvTimer) {
    clearInterval(recvTimer);
    recvTimer = null;
  }

  // Flush & stop the decoder in the broadcast worker
  broadcastWorker.postMessage({ type: "stopListening" });

  recordBtn.textContent = "🎙 Start Listening";
  recordBtn.className = "btn danger";
  recvProgress.classList.add("hidden");
  // Check if any files were received
  if (receivedFiles.length === 0) {
    setStatus(recvStatus, "info", "⏸ Stopped listening — no data received");
  } else {
    setStatus(recvStatus, "info", `⏸ Stopped — ${receivedFiles.length} file(s) received`);
  }
}

function showDownloads() {
  if (receivedFiles.length === 0) return;
  downloadArea.classList.remove("hidden");
  const items = receivedFiles.map(f =>
    `<a href="${f.url}" download="${f.name}" class="download-link">⬇ ${f.name} (${formatSize(f.bytes.length)})</a>`
  ).join("\n");
  downloadArea.innerHTML = `
    <div class="download-header">📥 ${receivedFiles.length} file(s) received</div>
    ${items}
    <button id="clearDownloadsBtn" class="btn-small" style="margin-top:8px">🗑 Clear</button>
  `;
  setTimeout(() => {
    const btn = document.getElementById("clearDownloadsBtn");
    if (btn) btn.addEventListener("click", () => {
      for (const f of receivedFiles) URL.revokeObjectURL(f.url);
      receivedFiles = [];
      downloadArea.classList.add("hidden");
      downloadArea.innerHTML = "";
    });
  }, 0);
}

function updateProgress(bits: number) {
  recvBits.textContent = String(bits);
  const pct = Math.min(bits / 200, 100);
  recvBar.style.width = `${pct}%`;
}

// ─── TX / RX Payload Display ────────────────────────

let lastTxPayload: Uint8Array | null = null;
let lastTxFileName = "";

function formatPayloadHex(bytes: Uint8Array, max = 96): string {
  const slice = bytes.slice(0, max);
  const hex = Array.from(slice)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const ascii = Array.from(slice)
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
    .join("");
  const lines: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const h = Array.from(slice.slice(i, i + 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ");
    const a = Array.from(slice.slice(i, i + 16))
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`${h.padEnd(48)}  ${a}`);
  }
  if (bytes.length > max) lines.push(`... ${bytes.length - max} more bytes`);
  return lines.join("\n");
}

function showTxPayload(bytes: Uint8Array, fileName: string) {
  lastTxPayload = bytes;
  lastTxFileName = fileName;
  let text = `📄 ${fileName}  (${formatSize(bytes.length)})\n${formatPayloadHex(bytes)}`;
  dbgTxPayload.textContent = text;
}

function showRxPayload(bytes: Uint8Array, fileName: string) {
  let text = `📄 ${fileName}  (${formatSize(bytes.length)})\n${formatPayloadHex(bytes)}`;
  dbgRxPayload.textContent = text;
}

/** Compute energy at a given frequency using sine/cosine correlation. */
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

/** Render live per-tone energy bars into the debug panel. */
let toneBarEls: HTMLDivElement[] | null = null;
function updateToneBars(energies: number[], maxE: number) {
  if (!toneBarEls) {
    toneBarEls = [];
    debugToneRow.innerHTML = "";
    for (let i = 0; i < TONES.length; i++) {
      const wrap = document.createElement("div");
      wrap.className = "debug-tone-bar-wrap";
      const fill = document.createElement("div");
      fill.className = "debug-tone-bar-fill";
      fill.style.background = TONE_COLORS[i];
      wrap.appendChild(fill);
      const label = document.createElement("span");
      label.className = "debug-tone-bar-label";
      label.textContent = `${TONES[i]}Hz`;
      wrap.appendChild(label);
      debugToneRow.appendChild(wrap);
      toneBarEls.push(fill);
    }
  }
  for (let i = 0; i < energies.length && i < toneBarEls.length; i++) {
    const pct = maxE > 0 ? Math.min(100, (energies[i] / maxE) * 100) : 0;
    toneBarEls[i].style.width = `${pct}%`;
  }
}

// ─── Helpers ──────────────────────────────────────────

function setStatus(el: HTMLElement, type: string, msg: string) {
  el.className = `status ${type}`;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

if (DEBUG) console.log("🦻 Eardrop ready — encoding/broadcast in workers, press Ctrl+Shift+D for debug view");

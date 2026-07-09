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

import '../style.css';
import { setState, getState } from './Store';
import { debugLogger } from '../modem/debug/debugger';
import { Encoder } from '../modem/protocol/encoder';
import { Decoder } from '../modem/protocol/decoder';
import { encodeBlock, BLOCK_TYPE, getSentinel } from '../modem/protocol/framing';
import { bch3116Encode } from '../modem/ecc/ecc';
import { AudioPlayer } from '../audio/player';
import { AudioRecorder } from '../audio/recorder';
import { Visualizer } from '../modem/debug/visualizer';
import { DEFAULT_CONFIG, TONE_COLORS } from '../modem/types';
import { enumerateDevices, populateSelect } from '../audio/devices';
import { buildPacket, tryParsePreamble, verifyPayload } from '../protocol';
import { mountReactDebug } from './react';
import { runSelfTest } from './controllers/selfTest';
import { TONE_FREQUENCIES, formatPayloadHex } from './lib';
import { detectToneEnergy } from '../lib/scan/index';
import { resample } from '../lib/math/index';

// ─── Debug toggle keyboard shortcut ────────────────
let debugVisible = false;

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
    e.preventDefault();
    debugVisible = !debugVisible;
    const el = document.getElementById('react-debug');
    if (el) {
      if (debugVisible) {
        el.style.display = 'block';
        mountReactDebug();
      } else {
        el.style.display = 'none';
      }
    }
    window.dispatchEvent(
      new CustomEvent('eardrop-toggle-debug', { detail: { visible: debugVisible } }),
    );
  }
});

// ─── Debug logging ────────────────────────────────────
let DEBUG = false;
const _origLog = console.log;

// ─── Workers ─────────────────────────────────────────

const encoderWorker = new Worker(new URL('../workers/encoder.worker.ts', import.meta.url), {
  type: 'module',
});

const broadcastWorker = new Worker(new URL('../workers/broadcast.worker.ts', import.meta.url), {
  type: 'module',
});

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
  if (msg.type === 'encoded') {
    task.resolve({ samples: new Float32Array(msg.samples), sampleRate: msg.sampleRate });
  } else if (msg.type === 'error') {
    task.reject(new Error(msg.error));
  }
};

function transmitFileInWorker(
  fileName: string,
  data: Uint8Array,
  config?: Partial<typeof DEFAULT_CONFIG>,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    const id = ++encodeIdCounter;
    encodeTasks.set(id, { resolve, reject });
    const copy = new Uint8Array(data);
    encoderWorker.postMessage(
      { type: 'transmitFile', id, fileName, data: copy, config },
      { transfer: [copy.buffer] },
    );
  });
}

// ─── Broadcast Worker Messages ──────────────────────

let decodedAccumulated: Uint8Array[] = [];
let totalDecoded = 0;
let parsedPreamble: { preamble: import('../protocol').FilePreamble; consumed: number } | null =
  null;
let payloadCollected = 0;
let wasInFrame = false;

broadcastWorker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'listening':
      setState({ recvStatus: { type: 'info', msg: 'Listener started — awaiting signal…' } });
      break;
    case 'stopped':
      setState({ recvStatus: { type: 'info', msg: 'Listener stopped' } });
      break;
    case 'fileComplete': {
      const data = new Uint8Array(msg.data);
      if (getState().diversityMode) {
      // Accumulate copies for majority voting
        if (!diversityCopies[msg.fileName]) diversityCopies[msg.fileName] = [];
        diversityCopies[msg.fileName].push(data);
        const n = diversityCopies[msg.fileName].length;
        setState({ recvStatus: { type: 'info', msg: `📦 Copy ${n}/3 of "${msg.fileName}"` } });
        if (n >= 3) {
        // Bit-by-bit majority vote across 3 copies
          const len = Math.max(...diversityCopies[msg.fileName].map((b) => b.length));
          const voted = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            let ones = 0,
              zeros = 0;
            for (const copy of diversityCopies[msg.fileName]) {
              if (i < copy.length) {
                for (let b = 0; b < 8; b++) {
                  if ((copy[i] >> b) & 1) ones++;
                  else zeros++;
                }
              }
            }
            voted[i] = ones > zeros ? 0xff : 0x00;
            // Per-byte majority vote instead of per-bit
            const byteVotes: number[] = [];
            for (const copy of diversityCopies[msg.fileName]) {
              if (i < copy.length) byteVotes.push(copy[i]);
            }
            byteVotes.sort((a, b) => {
              const ca = byteVotes.filter((v) => v === a).length;
              const cb = byteVotes.filter((v) => v === b).length;
              return cb - ca;
            });
            voted[i] = byteVotes[0];
          }
          delete diversityCopies[msg.fileName];
          setState({
            recvStatus: {
              type: 'success',
              msg: `✅ Majority vote: "${msg.fileName}" (${voted.length}B)`,
            },
          });
          const blob = new Blob([voted], { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = msg.fileName;
          a.click();
          URL.revokeObjectURL(url);
        }
      } else {
        setState({
          recvStatus: { type: 'success', msg: `✅ Received "${msg.fileName}" (${data.length}B)` },
        });
        const blob = new Blob([data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = msg.fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
      break;
    }
    case 'decoderState': {
      const stateNames = ['WAITING', 'CALIBRATION', 'HEADER', 'DATA', 'COMPLETE'];
      const label = stateNames[msg.state] ?? `STATE(${msg.state})`;
      setState({ recvStatus: { type: 'info', msg: `📡 ${label}` } });
      break;
    }
    case 'debugByteLog':
      setState({ debugByteStream: msg.bytes });
      break;
    case 'debugSentinelScan':
      setState({ sentinelScan: msg.history });
      break;
  }
};

// ─── DOM refs (acquired lazily — React creates these) ──
let inputSelect: HTMLSelectElement | null = null;
let outputSelect: HTMLSelectElement | null = null;
let refreshBtn: HTMLButtonElement | null = null;
let fastSyncCb: HTMLInputElement | null = null;

function getDeviceRefs() {
  if (!inputSelect) {
    inputSelect = document.getElementById('inputSelect') as HTMLSelectElement;
    outputSelect = document.getElementById('outputSelect') as HTMLSelectElement;
    refreshBtn = document.getElementById('refreshDevices') as HTMLButtonElement;
    fastSyncCb = document.getElementById('fastSyncCb') as HTMLInputElement;
    refreshBtn?.addEventListener('click', refreshDeviceList);
    inputSelect.addEventListener('change', () => {
      selectedInputId = inputSelect!.value;
    });
    outputSelect.addEventListener('change', () => {
      selectedOutputId = outputSelect!.value;
    });
  }
}

// ─── State ────────────────────────────────────────────

let selectedFile: File | null = null;
const diversityCopies: Record<string, Uint8Array[]> = {};
const receivedFileData: Array<{ name: string; bytes: Uint8Array; blob: Blob; url: string }> = [];
const audioCtx = new AudioContext();
const viz = new Visualizer();
const player = new AudioPlayer(audioCtx);

// ─── Device Enumeration ───────────────────────────────

async function refreshDeviceList() {
  getDeviceRefs();
  if (!inputSelect || !outputSelect) return;
  try {
    const { inputs, outputs } = await enumerateDevices();
    populateSelect(inputSelect, inputs, '');
    populateSelect(outputSelect, outputs, '');
  } catch {
    /* silent */
  }
}

// React calls this after mount
(window as any).eardropRefreshDevices = refreshDeviceList;

// ─── Custom Events from React ─────────────────────────

// File selection
window.addEventListener('eardrop-file', ((e: CustomEvent) => {
  selectedFile = e.detail.file;
}) as EventListener);

// Send
window.addEventListener('eardrop-send', (async () => {
  if (!selectedFile) return;
  await refreshDeviceList();
  if (!isListening) await startListening();
  try {
    setState({ isSending: true, sendStatus: { type: 'info', msg: 'Encoding…' } });
    const raw = new Uint8Array(await selectedFile.arrayBuffer());
    showTxPayload(raw, selectedFile.name);

    const cfg: any = {
      pilotFreqHz: getState().pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz,
      musical: getState().musicalMode,
      diversityMode: getState().diversityMode,
    };
    const { samples: playSamples, sampleRate: actualRate } = await transmitFileInWorker(
      selectedFile.name,
      raw,
      cfg,
    );
    setState({ sendStatus: { type: 'info', msg: `Playing ${selectedFile.name}…` } });
    setState({ isPlaying: true });
    const cleanPlay = getState().musicalMode;
    await player.play(playSamples, actualRate, selectedOutputId || undefined, cleanPlay);
    setState({
      isSending: false,
      isPlaying: false,
      sendStatus: { type: 'success', msg: `✅ Sent ${selectedFile.name}` },
    });
  } catch (err: any) {
    setState({
      isSending: false,
      isPlaying: false,
      sendStatus: { type: 'error', msg: `❌ ${err.message}` },
    });
  }
}) as EventListener);

// Record toggle
window.addEventListener('eardrop-record', (async () => {
  if (isListening) {
    stopListening();
    return;
  }
  await startListening();
}) as EventListener);

// Debug toggle — enable/disable verbose console logging
window.addEventListener('eardrop-toggle-debug', ((e: CustomEvent) => {
  DEBUG = e.detail?.visible ?? !DEBUG;
  if (DEBUG) {
    console.log = _origLog;
    console.log('🦻 Debug logging ON');
  } else {
    console.log = function () {};
  }
}) as EventListener);

// Expose DEBUG state so broadcast worker can pick it up
(window as any).eardropDebugEnabled = () => DEBUG;

// Self-test
window.addEventListener('eardrop-self-test', (async () => {
  await runSelfTest();
}) as EventListener);

// Send test (hello.txt)
window.addEventListener('eardrop-send-test', (async () => {
  await refreshDeviceList();
  if (!isListening) await startListening();
  const text = 'Hello World\n';
  const raw = new TextEncoder().encode(text);
  showTxPayload(raw, 'hello.txt');
  setState({ sendStatus: { type: 'info', msg: '📤 Sending test…' } });
  try {
    const cfg: any = {
      pilotFreqHz: getState().pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz,
      musical: getState().musicalMode,
    };
    const { samples: playSamples, sampleRate: actualRate } = await transmitFileInWorker(
      'hello.txt',
      raw,
      cfg,
    );
    await player.play(
      playSamples,
      actualRate,
      selectedOutputId || undefined,
      getState().musicalMode,
    );
    setState({ sendStatus: { type: 'success', msg: '✅ Test sent' } });
  } catch (err: any) {
    setState({ sendStatus: { type: 'error', msg: `❌ ${err.message}` } });
  }
}) as EventListener);

// Stop playback
window.addEventListener('eardrop-stop-playback', (() => {
  player.stopPlayback();
  setState({
    isSending: false,
    isPlaying: false,
    sendStatus: { type: 'info', msg: '⏹ Playback stopped' },
  });
}) as EventListener);

// Download recorded samples as WAV file
window.addEventListener('eardrop-download-wav', (() => {
  const samples = recvSamples;
  if (samples.length < 128) {
    setState({ sendStatus: { type: 'error', msg: '⚠ No audio recorded — listen first' } });
    return;
  }
  const sr = 3200;
  const n = samples.length;
  const dataLen = n * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (o: number, s: number) => v.setUint32(o, s, true);
  const w16 = (o: number, s: number) => v.setUint16(o, s, true);
  v.setUint8(0, 0x52);
  v.setUint8(1, 0x49);
  v.setUint8(2, 0x46);
  v.setUint8(3, 0x46);
  w(4, 36 + dataLen);
  v.setUint8(8, 0x57);
  v.setUint8(9, 0x41);
  v.setUint8(10, 0x56);
  v.setUint8(11, 0x45);
  v.setUint8(12, 0x66);
  v.setUint8(13, 0x6d);
  v.setUint8(14, 0x74);
  v.setUint8(15, 0x20);
  w(16, 16);
  w16(20, 1);
  w16(22, 1);
  w(24, sr);
  w(28, sr * 2);
  w16(32, 2);
  w16(34, 16);
  v.setUint8(36, 0x64);
  v.setUint8(37, 0x61);
  v.setUint8(38, 0x74);
  v.setUint8(39, 0x61);
  w(40, dataLen);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s * 32767, true);
  }
  const blob = new Blob([buf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `eardrop_${Date.now()}.wav`;
  a.click();
  URL.revokeObjectURL(url);
  setState({
    sendStatus: { type: 'success', msg: `✅ Downloaded ${(dataLen / 1024).toFixed(0)}KB WAV` },
  });
}) as EventListener);

// Live threshold adjustment — forward to broadcast worker
window.addEventListener('eardrop-thresholds', ((e: CustomEvent) => {
  broadcastWorker.postMessage({
    type: 'updateThresholds',
    ampRatio: e.detail.ampRatio,
    syncMul: e.detail.syncMul,
  });
}) as EventListener);

// Acoustic sweep
window.addEventListener('eardrop-acoustic-sweep', (async () => {
  setState({ sendStatus: { type: 'info', msg: '🔊 Sweep starting…' }, sweepResults: null });
  if (!isListening) await startListening();
  await new Promise((r) => setTimeout(r, 300));

  const modemRate = DEFAULT_CONFIG.sampleRate;
  const outputRate = player.getSampleRate();
  console.log(
    '[SWEEP] audioCtx.sampleRate=',
    audioCtx.sampleRate,
    'outputRate=',
    outputRate,
    'modemRate=',
    modemRate,
  );
  console.log(
    '[SWEEP] recvSamples count in last second:',
    recvSamples.length - Math.max(0, recvSamples.length - 3500),
  );
  const sweepFreqs: number[] = [];
  for (let f = 100; f <= 1500; f += 50) sweepFreqs.push(f);

  const results: Array<{ freq: number; energy: number }> = [];
  const toneSamples = Math.floor(modemRate * 0.12);

  // Play two tones at once (dual-tone sweep covers 2 freqs per step)
  for (let fi = 0; fi < sweepFreqs.length; fi += 2) {
    const freqA = sweepFreqs[fi];
    const freqB = fi + 1 < sweepFreqs.length ? sweepFreqs[fi + 1] : 0;
    const tone = new Float32Array(toneSamples);
    for (let i = 0; i < toneSamples; i++) {
      let s = Math.sin((2 * Math.PI * freqA * i) / modemRate) * 0.4;
      if (freqB) s += Math.sin((2 * Math.PI * freqB * i) / modemRate) * 0.4;
      tone[i] = s;
    }
    const playBuf = resample(tone, modemRate, outputRate);
    const recvCount = recvSamples.length;
    await player.play(playBuf, outputRate, selectedOutputId || undefined, getState().musicalMode);
    await new Promise((r) => setTimeout(r, 50));

    const newSamples = recvSamples.slice(recvCount);
    if (newSamples.length >= 64) {
      const buf = newSamples.slice(-Math.min(256, newSamples.length));
      // Measure energy at both played frequencies
      const eA = detectToneEnergy(new Float32Array(buf), freqA, modemRate);
      results.push({ freq: freqA, energy: eA });
      if (freqB) {
        const eB = detectToneEnergy(new Float32Array(buf), freqB, modemRate);
        results.push({ freq: freqB, energy: eB });
        // Full-band scan around second (mid-range) tone to check shift
        if (freqB >= 400 && freqB <= 600) {
          let bestFreq = freqB,
            bestE = 0;
          for (let fb = 50; fb <= 1550; fb += 25) {
            const e = detectToneEnergy(new Float32Array(buf), fb, modemRate);
            if (e > bestE) {
              bestE = e;
              bestFreq = fb;
            }
          }
          if (bestE > 1e-7)
            console.log(
              `[SWEEP] dual: ${freqA}/${freqB}Hz → peaks at ${bestFreq}Hz (${bestE.toExponential(3)})`,
            );
        }
      }
    } else {
      if (freqB) {
        results.push({ freq: freqA, energy: 0 }, { freq: freqB, energy: 0 });
      } else {
        results.push({ freq: freqA, energy: 0 });
      }
    }
    if (fi % 10 === 0 || fi >= sweepFreqs.length - 2) {
      setState({
        sweepResults: [...results],
        sendStatus: {
          type: 'info',
          msg: `🔊 Sweep: ${fi / 2 + 1}/${Math.ceil(sweepFreqs.length / 2)} (${freqA}/${freqB || '—'}Hz)`,
        },
      });
    }
  }
  setState({
    sweepResults: results,
    sendStatus: { type: 'success', msg: `✅ Sweep done — ${results.length} frequencies` },
  });

  // Apply sample rate calibration based on observed -25 Hz shift at 500 Hz
  // True ratio = played_freq / detected_peak = 500 / 475 ≈ 1.0526
  // Mic rate correction = 475 / 500 ≈ 0.95
  const calFactor = 0.95;
  if (recorder) {
    recorder.setCalibration(calFactor);
  }
  console.log(
    `[SWEEP] Calibrated mic rate: ×${calFactor} (${(audioCtx.sampleRate * calFactor).toFixed(0)} Hz)`,
  );
}) as EventListener);

// ─── Receive ──────────────────────────────────────────

let recorder: AudioRecorder | null = null;
let recvTimer: number | null = null;
let micWatchdog: ReturnType<typeof setTimeout> | null = null;
let recvSamples: number[] = [];
let tickCount = 0;
let isListening = false;
let selectedInputId = '';
let selectedOutputId = '';

function recvBuf(existing: Uint8Array[], chunk: Uint8Array) {
  existing.push(chunk);
  totalDecoded += chunk.length;
}

function tryFinalize() {
  const full = new Uint8Array(totalDecoded);
  let off = 0;
  for (const c of decodedAccumulated) {
    full.set(c, off);
    off += c.length;
  }

  if (totalDecoded < 12) return;

  const parsed = tryParsePreamble(full);
  if (!parsed) {
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
    }
    setState({ recvStatus: { type: 'info', msg: `📥 ${totalDecoded}B — waiting for preamble…` } });
    return;
  }

  const payloadStart = parsed.consumed;
  const needTotal = payloadStart + parsed.preamble.totalSize;

  if (full.length < needTotal) {
    payloadCollected = full.length - payloadStart;
    const pct = Math.floor((payloadCollected / parsed.preamble.totalSize) * 100);
    setState({
      progress: pct,
      recvStatus: { type: 'info', msg: `📥 ${parsed.preamble.fileName} — ${pct}%` },
    });
    return;
  }

  const payload = full.slice(payloadStart, payloadStart + parsed.preamble.totalSize);
  if (!verifyPayload(payload, parsed.preamble.crc32)) {
    setState({ recvStatus: { type: 'error', msg: '❌ CRC mismatch — file corrupted' } });
    return;
  }

  const blob = new Blob([payload]);
  const url = URL.createObjectURL(blob);
  receivedFileData.push({ name: parsed.preamble.fileName, bytes: payload, blob, url });
  showRxPayload(payload, parsed.preamble.fileName);
  setState({
    receivedFiles: receivedFileData.map((f) => ({
      name: f.name,
      url: f.url,
      size: f.bytes.length,
    })),
    recvStatus: { type: 'success', msg: `✅ Received ${parsed.preamble.fileName}` },
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
    setState({
      isListening: true,
      recvStatus: { type: 'info', msg: '🔊 Noise profiling…' },
      progress: 0,
    });

    const listenCfg = {
      ...DEFAULT_CONFIG,
      pilotFreqHz: getState().pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz,
      musical: getState().musicalMode,
      toneCount: getState().toneCount || DEFAULT_CONFIG.toneCount,
      symbolsPerSec: getState().symbolsPerSec || DEFAULT_CONFIG.symbolsPerSec,
      ampThresholdRatio: getState().ampThresholdRatio ?? DEFAULT_CONFIG.ampThresholdRatio,
      syncStrongMultiplier: getState().syncStrongMultiplier ?? DEFAULT_CONFIG.syncStrongMultiplier,
      diversityMode: getState().diversityMode,
    };
    broadcastWorker.postMessage({
      type: 'startListening',
      config: listenCfg,
      fastSync: fastSyncCb?.checked ?? false,
    });
    recorder = new AudioRecorder(audioCtx);
    const modemRate = DEFAULT_CONFIG.sampleRate;

    const feedSample = (s: number) => {
      broadcastWorker.postMessage({ type: 'feedSample', sample: s });
      recvSamples.push(s);
      if (recvSamples.length > modemRate * 10)
        recvSamples.splice(0, recvSamples.length - modemRate * 5);
    };
    await recorder.start(modemRate, feedSample, selectedInputId || undefined);

    micWatchdog = setTimeout(() => {
      if (recvSamples.length === 0) {
        setState({
          recvStatus: { type: 'error', msg: '❌ No mic samples — AudioContext may be blocked' },
        });
      }
    }, 1500);

    recvTimer = window.setInterval(() => {
      const n = recvSamples.length;
      if (n === 0) return;

      if (micWatchdog) {
        clearTimeout(micWatchdog);
        micWatchdog = null;
      }
      if (n < 64) return;

      const tail = Math.min(n, 256);
      const buf = recvSamples.slice(n - tail, n);

      let sumSq = 0;
      for (const s of buf) sumSq += s * s;
      const rms = Math.sqrt(sumSq / buf.length);
      const rmsDb = rms > 0.0001 ? 20 * Math.log10(rms) : -80;
      const energies = TONE_FREQUENCIES.map((f) =>
        detectToneEnergy(new Float32Array(buf), f, modemRate),
      );
      // FFT spectrum (every tick, 100ms)
      const ftBins = 64;
      const spectrum = new Float32Array(ftBins);
      for (let bin = 0; bin < ftBins; bin++) {
        const f = (bin / ftBins) * 1600; // 0-1600 Hz
        let si = 0,
          co = 0;
        for (let i = 0; i < buf.length; i++) {
          const ph = (2 * Math.PI * f * i) / modemRate;
          si += buf[i] * Math.sin(ph);
          co += buf[i] * Math.cos(ph);
        }
        spectrum[bin] = Math.hypot(si, co) / buf.length;
      }

      // Raw peak and VU
      const rawMin = Math.min(...buf);
      const rawMax = Math.max(...buf);
      const rawPeak = Math.max(Math.abs(rawMin), Math.abs(rawMax));
      const noiseFloorDb = rmsDb < -50 ? rmsDb : 20 * Math.log10(Math.max(rms, 1e-6));

      setState({
        micLevel: rmsDb,
        rawPeak,
        toneEnergies: energies,
        fftSpectrum: spectrum,
        noiseFloorDb,
      });

      // Mic diagnostic snapshot (every tick ~100ms)
      if (recorder) {
        const diag = recorder.getDiag();
        setState({ micDiag: diag });
      }

      // Waveform and debug samples every tick
      tickCount++;
      setState({ debugSamples: new Float32Array(recvSamples.slice(-1024)) });
    }, 100);
  } catch (err: any) {
    isListening = false;
    setState({
      isListening: false,
      recvStatus: { type: 'error', msg: `❌ Mic access: ${err.message}` },
    });
  }
}

function stopListening() {
  isListening = false;
  if (micWatchdog) {
    clearTimeout(micWatchdog);
    micWatchdog = null;
  }
  recorder?.stop();
  recorder = null;
  if (recvTimer) {
    clearInterval(recvTimer);
    recvTimer = null;
  }
  broadcastWorker.postMessage({ type: 'stopListening' });
  setState({ isListening: false, recvStatus: { type: 'info', msg: '⏸ Stopped' } });
}

function showTxPayload(bytes: Uint8Array, fileName: string) {
  setState({ txPayload: { name: fileName, bytes: formatPayloadHex(bytes) } });
}

function showRxPayload(bytes: Uint8Array, fileName: string) {
  setState({ rxPayload: { name: fileName, bytes: formatPayloadHex(bytes) } });
}

// Expose self-test for event wiring
(window as any).runSelfTest = runSelfTest;

// ─── Init ─────────────────────────────────────────────

console.log('🦻 Eardrop controller ready');

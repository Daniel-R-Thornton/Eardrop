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
import { setState, getState, subscribe, type SpeedTestResult } from './Store';
import { Encoder } from '../modem/protocol/encoder';
import { Decoder } from '../modem/protocol/decoder';
import { encodeBlock, BLOCK_TYPE, getSentinel } from '../modem/protocol/framing';
import { bch3116Encode } from '../modem/ecc/ecc';
import { AudioPlayer } from '../audio/player';
import { type AudioRecorder } from '../audio/recorder';
import { runAutoCalibration } from './controllers/calibration';
import { Visualizer } from '../modem/debug/visualizer';
import { DEFAULT_CONFIG, OFDM_TUNING, ofdmSamples } from '../modem/types';
import { enumerateDevices, resolveInputDevice } from '../audio/devices';
import { TxEngine } from '../modem/protocol/txEngine';
import { encodeFrame, PAYLOAD_DATA_SIZE } from '../modem/protocol/atomicFrame';
import { tryParsePreamble, verifyPayload } from '../protocol';
import { mountReactDebug } from './react';
import { runSelfTest } from './controllers/selfTest';
import { TONE_FREQUENCIES, formatPayloadHex } from './lib';
import { coordinateDescent, type DescentAxis } from './lib/coordinateDescent';
import { scoreTrial } from './lib/speedTestScore';
import { detectToneEnergy } from '../lib/scan/index';
import { resample } from '../lib/math/index';
import { dlog, dlogDump, dlogInject, dlogInjectRecord, dlogReset, dlogSetFocus, dlogSetMode, DLOG_RING_MAX, dlogRingLength } from '../lib/debug/dlog';
import { ModemController } from './controllers/modemController';
import { buildModemConfig } from './controllers/buildModemConfig';
import { ChatterController } from './controllers/chatterController';
/**
 * Resolve the persisted mic selection to an id that exists right now, and keep
 * the store in step.
 *
 * Chrome's deviceId rotates (salted hash; the salt changes across restarts,
 * profile changes and permission changes, and Linux device re-enumeration can
 * change it too). A stale id does not error — getUserMedia simply omits the
 * constraint and captures from the browser default, i.e. possibly a different
 * physical microphone, which is indistinguishable from the channel changing.
 * Matching on the stored LABEL survives that.
 */
async function resolveMic(): Promise<{ id: string | undefined; label: string }> {
  const st = getState();
  const resolved = await resolveInputDevice(st.selectedInputId, st.selectedInputLabel);
  if (resolved.matchedBy === 'label' && resolved.id !== st.selectedInputId) {
    dlog('REC', {
      deviceIdRotated: true,
      label: resolved.label,
      note: 'stored deviceId no longer exists; matched by label',
    }, { level: 'warn' });
    setState({ selectedInputId: resolved.id });
  }
  if (resolved.matchedBy === 'default' && (st.selectedInputId || st.selectedInputLabel)) {
    dlog('REC', {
      deviceUnresolved: true,
      storedLabel: st.selectedInputLabel || '(none)',
      note: 'falling back to browser default — re-pick the mic',
    }, { level: 'warn' });
  }
  return { id: resolved.id || undefined, label: resolved.label };
}

/**
 * Stored pre-emphasis for the current mic and band, or undefined.
 *
 * Keyed by input device AND band because the gains are per tone index — see
 * AppState.toneGainsByDevice. Applied to TX only; the receiver needs no
 * knowledge of it, since it trains its channel estimate on a preamble that
 * carries the same gains as the data.
 */
function currentToneGains(): number[] | undefined {
  const st = getState();
  const key = `${st.pilotFreqHz}:${st.toneStartHz}:${st.toneCount}`;
  // Label first — deviceId rotates, so an id-keyed lookup silently stops
  // matching and the correction just stops being applied. Falls back to the id
  // so calibrations measured before the key changed are still found.
  const device = st.selectedInputLabel || st.selectedInputId;
  const gains = st.toneGainsByDevice?.[device]?.[key]
    ?? st.toneGainsByDevice?.[st.selectedInputId]?.[key];
  return gains && gains.length === st.toneCount ? gains : undefined;
}

import { setTelemetry } from './telemetryStore';
import { DEMO_PAYLOAD } from './demoPayload';

// Main thread: clear-and-reprint the whole log as ONE console entry per update
// so a single copy grabs the entire session. Worker lines arrive via 'dlog'
// messages and merge into the same ring.
dlogSetMode('redraw');

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
// Legacy broadcast/encoder workers removed in Task 6 of modem-worker-architecture.
// All modem logic runs in the unified modem.worker.ts via ModemController.

let decodedAccumulated: Uint8Array[] = [];
let totalDecoded = 0;
let parsedPreamble: { preamble: import('../protocol').FilePreamble; consumed: number } | null =
  null;
let payloadCollected = 0;
let wasInFrame = false;

// ─── State ────────────────────────────────────────────

let selectedFile: File | null = null;
const diversityCopies: Record<string, Uint8Array[]> = {};
const receivedFileData: Array<{ name: string; bytes: Uint8Array; blob: Blob; url: string }> = [];
const audioCtx = new AudioContext();
const viz = new Visualizer();
const player = new AudioPlayer(audioCtx);

const modem = new ModemController(audioCtx);

// ─── Chatter room ─────────────────────────────────────
// ModemController satisfies ChatterController's ModemWorkerHandle structurally
// (on/configure/startListening/stopListening/encodeFile plus the six chatter
// passthroughs + sampleRate added alongside this wiring). Reuses the same
// AudioPlayer as every other TX path rather than spinning up a second
// AudioContext.
const chatter = new ChatterController(modem, { player });
// ChatterPanel (mounted inside BenchApp's own grid, see BenchApp.tsx) talks to
// this controller purely through the Store + the custom-event bus below —
// same wiring every other view/app.ts pair uses.

window.addEventListener('eardrop-chatter-join', (() => {
  dlog('UI', { action: 'joinRoom' }, { level: 'warn' });
  void chatter.joinRoom();
}) as EventListener);

window.addEventListener('eardrop-chatter-leave', (() => {
  dlog('UI', { action: 'leaveRoom' }, { level: 'warn' });
  void chatter.leaveRoom();
}) as EventListener);

/**
 * Tags worth seeing while the room is on screen: what the room decided, what
 * control traffic was demodulated, and the audio devices behind both. The
 * modem's per-symbol OFDM/sync/frame logging is excluded — it is the bulk of
 * the output and it buries these.
 */
const ROOM_LOG_TAGS = [
  'ROOM', 'CHATTER-RX', 'REC', 'REC-CAP', 'REC-ERR', 'PLAY', 'APP', 'UI',
  // The decode ladder for a control message, needed to tell "heard nothing"
  // from "heard it and could not read it": OFDM-SYNC = the chirp was found,
  // RX-OFDM cardInvalid = a sentinel arrived but its header would not decode.
  // These are noisy during a file transfer but near-silent while a room idles,
  // which is exactly when we need them.
  'OFDM-SYNC', 'RX-OFDM',
];

// Room mode narrows debug output to the room's own story. Applied on BOTH
// sides: the worker does most of the logging, the main thread the rest.
window.addEventListener('eardrop-room-focus', ((e: CustomEvent) => {
  const { focused } = e.detail as { focused: boolean };
  const tags = focused ? ROOM_LOG_TAGS : null;
  dlogSetFocus(tags);
  modem.setLogFocus(tags);
}) as EventListener);

let speedTestActive = false;
let speedTestExpectedFile: string | null = null;

modem.on('fileComplete', (ev) => {
  if (speedTestActive && ev.fileName === speedTestExpectedFile) {
    return;
  }
  const data = new Uint8Array(ev.data);
  const blob = new Blob([data]);
  const url = URL.createObjectURL(blob);
  setState({ recvStatus: { type: 'success', msg: `✅ Received ${ev.fileName}` } });
  setState({
    receivedFiles: [...getState().receivedFiles, { name: ev.fileName, url, size: data.length }],
  });
});
modem.on('dlog', (ev) => {
  if (ev.line !== undefined) dlogInject(ev.line);
  if (ev.rec) dlogInjectRecord(ev.rec);
});
modem.on('telemetry', (ev) => setTelemetry(ev.telemetry));

dlog('APP', { hwRate: audioCtx.sampleRate });

// ─── Device Enumeration ───────────────────────────────
// The device dropdowns are rendered and populated by React (MainApp). Here we
// only prime the mic permission before send/record so device labels resolve and
// the selected deviceId can be honoured.

async function refreshDeviceList() {
  try {
    await enumerateDevices();
  } catch {
    /* permission denied — recorder falls back to the default device */
  }
}

// ─── Auto-restart listener on OFDM setting changes ──
let lastOfdmSettings = { useOFDM: false, symbolsPerSec: 50, toneCount: 4 };
subscribe(() => {
  const s = getState();
  const cur = { useOFDM: s.useOFDM, symbolsPerSec: s.symbolsPerSec, toneCount: s.toneCount };
  if (
    isListening &&
    (cur.useOFDM !== lastOfdmSettings.useOFDM ||
      cur.symbolsPerSec !== lastOfdmSettings.symbolsPerSec ||
      cur.toneCount !== lastOfdmSettings.toneCount)
  ) {
    dlog('OFDM-CONFIG', { restart: true });
    stopListening();
    // Re-start will happen on next send/record click
  }
  lastOfdmSettings = cur;
});

// ─── Custom Events from React ─────────────────────────

// File selection — while in a chatter room, a dropped file broadcasts to the
// room instead of feeding the point-to-point send flow (selectedFile/eardrop-send).
window.addEventListener('eardrop-file', ((e: CustomEvent) => {
  // `targetId` addresses one member; absent or 0 means the whole room.
  const { file, targetId } = e.detail as { file: File; targetId?: number };
  dlog('UI', {
    fileEvent: file.name, bytes: file.size,
    route: getState().chatterOn ? 'room' : 'bench',
    to: targetId || 'broadcast',
  }, { level: 'warn' });
  if (getState().chatterOn) {
    void file.arrayBuffer().then(
      (buf) => chatter.broadcastFile(file.name, new Uint8Array(buf), targetId ?? 0),
    );
    return;
  }
  selectedFile = file;
}) as EventListener);

// Demo — the full experience: capture the pipeline stages for the visual AND
// actually transmit the same payload as audio (so you hear it + the RX side
// receives it), just like the test-send.
window.addEventListener('eardrop-demo-encode', (async () => {
  // Real acoustic loopback: mic ON, play out the speaker, decode what the mic
  // actually hears. NO software shortcut — the sound genuinely carries the data.
  await refreshDeviceList();
  if (!isListening) await startListening();
  modem.configure(
    buildModemConfig({
      useOFDM: getState().useOFDM,
      pilotFreqHz: getState().pilotFreqHz,
      toneStartHz: getState().toneStartHz,
      toneCount: getState().toneCount,
      symbolsPerSec: getState().symbolsPerSec,
      musicalMode: getState().musicalMode,
      diversityMode: getState().diversityMode,
      hwSampleRate: audioCtx.sampleRate,
      bandHandshake: getState().bandHandshake,
        dataQamBits: getState().dataQamBits,
      qamScaleOverride: getState().qamScaleOverride,
      toneGains: currentToneGains(),
      trainingSettleSymbols: getState().trainingSettleSymbols,
    }),
  );
  showTxPayload(DEMO_PAYLOAD.bytes, DEMO_PAYLOAD.name);
  setState({ sendStatus: { type: 'info', msg: '📤 Demo…' } });
  try {
    // Capture per-frame stage bundles → drives the pipeline animation (display only).
    const run = await modem.demoEncode(DEMO_PAYLOAD.name, DEMO_PAYLOAD.bytes);
    setState({ demoRun: run, demoFrameIndex: 0, demoStageIndex: 0 });
    // Encode + play out the speaker. The mic (startListening above) hears it and
    // the RxEngine decodes it in real time — the file only arrives if the real
    // acoustic transmission decodes.
    const { samples, sampleRate } = await modem.encodeFile(DEMO_PAYLOAD.name, DEMO_PAYLOAD.bytes);
    setState({ isPlaying: true, progress: 0 });
    await playWithProgress(
      samples,
      sampleRate,
      getState().selectedOutputId || undefined,
      getState().musicalMode,
    );
    setState({ progress: 100, sendStatus: { type: 'success', msg: '✅ Demo played — listening for decode' } });
  } catch (err: any) {
    setState({ isPlaying: false, sendStatus: { type: 'error', msg: `❌ demo: ${err.message}` } });
  }
}) as EventListener);

// Send
window.addEventListener('eardrop-send', (async () => {
  if (!selectedFile) return;
  await refreshDeviceList();
  if (!isListening) await startListening();
  try {
    // Auto-calibrate when this mic+band has no stored pre-emphasis. An
    // uncalibrated band measured 3-4 dB worse MER — the whole FEC margin at
    // 32+ tones — so sending without it mostly wastes the transmission.
    if (getState().useOFDM && !currentToneGains()) {
      setState({
        isSending: true,
        sendStatus: { type: 'info', msg: '🎚 No calibration for this band — calibrating first…' },
      });
      const cal = await runAutoCalibration();
      if (cal.failed) {
        setState({
          sendStatus: {
            type: 'info',
            msg: `⚠ Calibration failed (${cal.failed}) — sending uncalibrated`,
          },
        });
      } else {
        setState({
          sendStatus: {
            type: 'info',
            msg: `🎚 Calibrated: spread ${cal.beforeSpread.toFixed(1)} → ${cal.afterSpread.toFixed(1)} dB`,
          },
        });
      }
    }
    setState({ isSending: true, sendStatus: { type: 'info', msg: 'Encoding…' } });
    const raw = new Uint8Array(await selectedFile.arrayBuffer());
    showTxPayload(raw, selectedFile.name);

    modem.configure(
      buildModemConfig({
        useOFDM: getState().useOFDM,
        pilotFreqHz: getState().pilotFreqHz,
        toneStartHz: getState().toneStartHz,
        toneCount: getState().toneCount,
        symbolsPerSec: getState().symbolsPerSec,
        musicalMode: getState().musicalMode,
        diversityMode: getState().diversityMode,
        hwSampleRate: audioCtx.sampleRate,
        bandHandshake: getState().bandHandshake,
        dataQamBits: getState().dataQamBits,
      qamScaleOverride: getState().qamScaleOverride,
      toneGains: currentToneGains(),
      trainingSettleSymbols: getState().trainingSettleSymbols,
      }),
    );
    setState({ isPlaying: true, progress: 0 });
    // Stream-encode + play: memory stays bounded for large files.
    await playFileStreaming(selectedFile.name, raw, getState().selectedOutputId || undefined);
    setState({
      isSending: false,
      isPlaying: false,
      progress: 100,
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

/** Cancel hook for an in-flight streaming send (aborts the worker generator). */
let currentStreamCancel: (() => void) | null = null;

/**
 * Stream-encode a file in the worker and play it as chunks arrive. Memory stays
 * bounded regardless of file size (unlike the batch encodeFile path, which
 * builds the whole waveform up front). Progress/ETA from wall-clock vs the
 * estimated total duration; playback runs in realtime so the two track closely.
 */
async function playFileStreaming(
  fileName: string,
  raw: Uint8Array,
  deviceId?: string,
): Promise<void> {
  const { sampleRate, totalSamples, pull, cancel } = await modem.startFileStream(fileName, raw);
  currentStreamCancel = cancel;
  const totalSec = totalSamples / sampleRate;
  const startTime = Date.now();
  const interval = setInterval(() => {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const pct = totalSec > 0 ? Math.min(99, Math.round((elapsedSec / totalSec) * 100)) : 0;
    const remainingSec = Math.max(0, totalSec - elapsedSec);
    setState({
      progress: pct,
      sendStatus: {
        type: 'info',
        msg: `📤 ${pct}% · ${remainingSec < 60 ? `${remainingSec.toFixed(0)}s` : `${(remainingSec / 60).toFixed(1)}m`} remaining`,
      },
    });
  }, 200);
  try {
    await player.playStream(pull, sampleRate, deviceId);
  } finally {
    clearInterval(interval);
    currentStreamCancel = null;
  }
}

/** Play audio with progress tracking and ETA display. */
async function playWithProgress(
  samples: Float32Array,
  sampleRate: number,
  deviceId?: string,
  clean = false,
): Promise<void> {
  const durationSec = samples.length / sampleRate;
  const startTime = Date.now();
  const interval = setInterval(() => {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const pct = Math.min(99, Math.round((elapsedSec / durationSec) * 100));
    const remainingSec = Math.max(0, durationSec - elapsedSec);
    setState({
      progress: pct,
      sendStatus: {
        type: 'info',
        msg: `📤 ${pct}% · ${remainingSec < 60 ? `${remainingSec.toFixed(0)}s` : `${(remainingSec / 60).toFixed(1)}m`} remaining`,
      },
    });
  }, 200);
  try {
    await player.play(samples, sampleRate, deviceId, clean);
  } finally {
    clearInterval(interval);
  }
}

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
    modem.configure(
      buildModemConfig({
        useOFDM: getState().useOFDM,
        pilotFreqHz: getState().pilotFreqHz,
        toneStartHz: getState().toneStartHz,
        toneCount: getState().toneCount,
        symbolsPerSec: getState().symbolsPerSec,
        musicalMode: getState().musicalMode,
        diversityMode: getState().diversityMode,
        hwSampleRate: audioCtx.sampleRate,
        bandHandshake: getState().bandHandshake,
        dataQamBits: getState().dataQamBits,
      qamScaleOverride: getState().qamScaleOverride,
      toneGains: currentToneGains(),
      trainingSettleSymbols: getState().trainingSettleSymbols,
      }),
    );
    setState({ isPlaying: true, progress: 0 });
    await playFileStreaming('hello.txt', raw, getState().selectedOutputId || undefined);
    setState({ progress: 100, sendStatus: { type: 'success', msg: '✅ Test sent' } });
  } catch (err: any) {
    setState({ sendStatus: { type: 'error', msg: `❌ ${err.message}` } });
  }
}) as EventListener);

// Stop playback
window.addEventListener('eardrop-stop-playback', (() => {
  currentStreamCancel?.();
  currentStreamCancel = null;
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

// Live threshold adjustment — legacy, superseded by unified worker
window.addEventListener('eardrop-thresholds', (() => {}) as EventListener);

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
    await player.play(
      playBuf,
      outputRate,
      getState().selectedOutputId || undefined,
      getState().musicalMode,
    );
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
  console.log(`[SWEEP] Sweep complete — ${results.length} frequencies tested`);
}) as EventListener);

// ─── Receive ──────────────────────────────────────────

let recorder: AudioRecorder | null = null;
let unsubMicGain: (() => void) | null = null;
let recvTimer: number | null = null;
let micWatchdog: ReturnType<typeof setTimeout> | null = null;
let recvSamples: number[] = [];
let tickCount = 0;
let isListening = false;
/** Guard against concurrent start/stop racing */
let recvStarting = false;

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
  if (recvStarting) {
    dlog('APP', { startListeningBusy: true });
    return;
  }
  recvStarting = true;
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

    const cfg = buildModemConfig({
      useOFDM: getState().useOFDM,
      pilotFreqHz: getState().pilotFreqHz,
      toneStartHz: getState().toneStartHz,
      toneCount: getState().toneCount,
      symbolsPerSec: getState().symbolsPerSec,
      musicalMode: getState().musicalMode,
      diversityMode: getState().diversityMode,
      hwSampleRate: audioCtx.sampleRate,
      bandHandshake: getState().bandHandshake,
        dataQamBits: getState().dataQamBits,
      qamScaleOverride: getState().qamScaleOverride,
      toneGains: currentToneGains(),
      trainingSettleSymbols: getState().trainingSettleSymbols,
    });
    modem.configure(cfg);
    const mic = await resolveMic();
    await modem.startListening(getState().micGain, mic.id, mic.label);

    // Sync mic gain slider → live GainNode while listening
    let lastMicGain = getState().micGain;
    const unsub = subscribe(() => {
      const g = getState().micGain;
      if (g !== lastMicGain) {
        lastMicGain = g;
        modem.setMicGain(g);
      }
    });
    unsubMicGain = unsub;

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
      const modRate = audioCtx.sampleRate;
      const energies = TONE_FREQUENCIES.map((f) =>
        detectToneEnergy(new Float32Array(buf), f, modRate),
      );
      // FFT spectrum (every tick, 100ms)
      const ftBins = 64;
      const spectrum = new Float32Array(ftBins);
      for (let bin = 0; bin < ftBins; bin++) {
        const f = (bin / ftBins) * 1600; // 0-1600 Hz
        let si = 0,
          co = 0;
        for (let i = 0; i < buf.length; i++) {
          const ph = (2 * Math.PI * f * i) / audioCtx.sampleRate;
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
  } finally {
    recvStarting = false;
  }
}

function stopListening() {
  recvStarting = false;
  isListening = false;
  if (micWatchdog) {
    clearTimeout(micWatchdog);
    micWatchdog = null;
  }
  recorder?.stop();
  recorder = null;
  modem.stopListening();
  if (unsubMicGain) {
    unsubMicGain();
    unsubMicGain = null;
  }
  if (recvTimer) {
    clearInterval(recvTimer);
    recvTimer = null;
  }
  setState({ isListening: false, recvStatus: { type: 'info', msg: '⏸ Stopped' } });
}

function showTxPayload(bytes: Uint8Array, fileName: string) {
  setState({ txPayload: { name: fileName, bytes: formatPayloadHex(bytes) } });
}

function showRxPayload(bytes: Uint8Array, fileName: string) {
  setState({ rxPayload: { name: fileName, bytes: formatPayloadHex(bytes) } });
}

// ─── Debug: Single-frame acoustic tests ──────────────

/** Capture received audio buffer for offline analysis. Exposed as window.dumpRxBuffer(). */
function dumpRxBuffer(durationSec = 2): {
  samples: Float32Array;
  rms: number;
  peak: number;
  sampleRate: number;
} {
  const modemRate = DEFAULT_CONFIG.sampleRate;
  const count = Math.min(recvSamples.length, Math.floor(modemRate * durationSec));
  const tail = recvSamples.slice(-count);
  const buf = new Float32Array(tail);
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]);
    sumSq += v * v;
    if (v > peak) peak = v;
  }
  const rms = Math.sqrt(sumSq / buf.length);
  return { samples: buf, rms, peak, sampleRate: modemRate };
}
(window as any).dumpRxBuffer = dumpRxBuffer;

/** Convert Float32Array samples to a WAV blob and trigger download. */
function exportSamplesAsWav(samples: Float32Array, sampleRate: number, filename: string) {
  const wav = encodeWAV(samples, sampleRate);
  const blob = new Blob([wav], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Encode Float32Array mono PCM as WAV (16-bit little-endian). */
function encodeWAV(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  /* RIFF identifier */
  writeString(view, 0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + samples.length * 2, true);
  /* RIFF type */
  writeString(view, 8, 'WAVE');
  /* format chunk */
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  /* data chunk */
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  floatTo16BitPCM(view, 44, samples);
  return buffer;
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    output.setInt16(offset, s, true);
  }
}

/** Transmit just the preamble + calibration, no data frames. */
async function sendCalibrationOnly() {
  player.volume = getState().playbackVolume;
  dlog('CAL-TEST', { start: true });
  setState({ sendStatus: { type: 'info', msg: '🔊 Sending calibration only…' } });
  await refreshDeviceList();
  if (!isListening) await startListening();

  // Wait a moment for noise profiling
  await new Promise((r) => setTimeout(r, 300));
  const noiseFloor = dumpRxBuffer(0.5);
  dlog('CAL-TEST', {
    noiseRms: noiseFloor.rms,
    noisePeak: noiseFloor.peak,
    n: noiseFloor.samples.length,
  });

  const pilotFreq = getState().pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz;
  const {useOFDM} = getState();
  const modemRate = useOFDM ? audioCtx.sampleRate : DEFAULT_CONFIG.sampleRate;
  const tx = new TxEngine({
    sampleRate: modemRate,
    pilotFreqHz: pilotFreq,
    symbolsPerSec: getState().symbolsPerSec,
    toneCount: getState().toneCount,
    useOFDM,
  });
  const preamble = tx.transmitPreamble();

  let txPeak = 0;
  let txSumSq = 0;
  for (let i = 0; i < preamble.length; i++) {
    const v = Math.abs(preamble[i]);
    txSumSq += v * v;
    if (v > txPeak) txPeak = v;
  }
  const txRms = Math.sqrt(txSumSq / preamble.length);
  dlog('CAL-TEST', { txSamples: preamble.length, txPeak, txRms, pilot: pilotFreq });
  // Show first 16 samples for waveform inspection
  dlog('CAL-TEST', { txHead: Array.from(preamble.slice(0, 8)).map((v) => v.toFixed(2)) });

  const silence = new Float32Array(Math.round((modemRate / getState().symbolsPerSec) * 6));
  const full = new Float32Array(preamble.length + silence.length);
  full.set(preamble, 0);
  full.set(silence, preamble.length);

  // Snapshot received samples count before play
  const preCount = recvSamples.length;
  setState({ isPlaying: true });
  await player.play(full, modemRate, getState().selectedOutputId || undefined);

  // Wait for all received audio to buffer
  await new Promise((r) => setTimeout(r, 500));

  const rxDump = dumpRxBuffer(2);
  const newSampleCount = recvSamples.length - preCount;
  dlog('CAL-TEST', { rxSamples: newSampleCount, rxPeak: rxDump.peak, rxRms: rxDump.rms });
  if (rxDump.samples.length >= 16) {
    dlog('CAL-TEST', { rxHead: Array.from(rxDump.samples.slice(0, 8)).map((v) => v.toFixed(2)) });
  }
  dlog('CAL-TEST', { done: true });

  setState({
    isPlaying: false,
    sendStatus: { type: 'success', msg: '✅ Calibration sent — check console' },
  });
}

/** Transmit a single atomic frame (79 bytes) — tests sentinel detection. */
async function sendSingleFrame() {
  player.volume = getState().playbackVolume;
  dlog('FRAME-TEST', { start: true });
  setState({ sendStatus: { type: 'info', msg: '🔊 Sending single frame…' } });
  await refreshDeviceList();
  if (!isListening) await startListening();

  await new Promise((r) => setTimeout(r, 300));
  const noiseFloor = dumpRxBuffer(0.5);
  dlog('FRAME-TEST', { noiseRms: noiseFloor.rms, noisePeak: noiseFloor.peak });

  const pilotFreq = getState().pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz;
  const {useOFDM} = getState();
  const modemRate = useOFDM ? audioCtx.sampleRate : DEFAULT_CONFIG.sampleRate;
  const tx = new TxEngine({
    sampleRate: modemRate,
    pilotFreqHz: pilotFreq,
    symbolsPerSec: getState().symbolsPerSec,
    toneCount: getState().toneCount,
    useOFDM,
  });

  // Build one header frame with known data
  const payload = new Uint8Array(40);
  payload[0] = 0xde;
  payload[1] = 0xad;
  payload[2] = 0xbe;
  payload[3] = 0xef;
  const header = { type: 0x01 as const, seqNum: 0, totalFrames: 1, crc: 0 };
  const rawFrame = encodeFrame(header, payload);

  dlog('FRAME-TEST', {
    txBytes: rawFrame.length,
    head: Array.from(rawFrame.slice(0, 12))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
    sentinel: '0xE79FE7',
  });

  // Generate frame audio: OFDM or BPSK depending on mode
  const frameAudio = ((): Float32Array => {
    if (getState().useOFDM && (tx as any).ofdmEngine) {
      const rawFrame = encodeFrame(header, payload);
      dlog('FRAME-TEST', { mode: 'ofdm' });
      return (tx as any).ofdmEngine.modulateFrame(rawFrame);
    }
    return tx.transmitFrame(header, payload);
  })();

  let txPeak = 0;
  for (let i = 0; i < frameAudio.length; i++) {
    const v = Math.abs(frameAudio[i]);
    if (v > txPeak) txPeak = v;
  }
  dlog('FRAME-TEST', { txSamples: frameAudio.length, txPeak });

  // Normalize frame audio if it's too quiet (HMR may cache old OFDM code)
  if (txPeak > 0 && txPeak < 0.5) {
    const boost = 0.9 / txPeak;
    dlog('FRAME-TEST', { boost, wasPeak: txPeak });
    for (let i = 0; i < frameAudio.length; i++) frameAudio[i] *= boost;
    txPeak = 0.9;
  }

  // Prepend preamble so RxEngine can sync
  // OFDM mode uses sync burst, BPSK mode uses warble preamble
  const preamble =
      getState().useOFDM && (tx as any).ofdmEngine
        ? (tx as any).ofdmEngine.generateSyncBurst(OFDM_TUNING.syncBurstSymbols)
        : tx.transmitPreamble();
  const silence = new Float32Array(Math.round((modemRate / getState().symbolsPerSec) * 6));
  const full = new Float32Array(preamble.length + frameAudio.length + silence.length);
  full.set(preamble, 0);
  full.set(frameAudio, preamble.length);
  full.set(silence, preamble.length + frameAudio.length);

  dlog('FRAME-TEST', {
    preamble: preamble.length,
    frame: frameAudio.length,
    silence: silence.length,
  });

  const preCount = recvSamples.length;
  setState({ isPlaying: true });
  await player.play(full, modemRate, getState().selectedOutputId || undefined);

  // Wait and inspect what we got
  await new Promise((r) => setTimeout(r, 800));
  const rxDump = dumpRxBuffer(3);
  const newCount = recvSamples.length - preCount;
  dlog('FRAME-TEST', {
    done: true,
    rxSamples: newCount,
    rxPeak: rxDump.peak,
    rxRms: rxDump.rms,
    snrDb: 20 * Math.log10(rxDump.rms / Math.max(noiseFloor.rms, 1e-12)),
  });

  setState({
    isPlaying: false,
    sendStatus: { type: 'success', msg: '✅ Single frame sent — check console' },
  });
}

/** Transmit just the 24-bit sentinel pattern as raw BPSK symbols (~0.8s).
   *  Tests if the sentinel scanner can detect the pattern in isolation. */
async function sendSentinelOnly() {
  player.volume = getState().playbackVolume;
  console.warn('━━━ [SENTINEL-TEST] Sending raw sentinel pattern ━━━');
  setState({ sendStatus: { type: 'info', msg: '🔊 Sending sentinel…' } });
  await refreshDeviceList();
  if (!isListening) await startListening();
  await new Promise((r) => setTimeout(r, 300));

  const pilotFreq = getState().pilotFreqHz || DEFAULT_CONFIG.pilotFreqHz;
  const tx = new TxEngine({
    pilotFreqHz: pilotFreq,
    symbolsPerSec: getState().symbolsPerSec,
    toneCount: getState().toneCount,
    useOFDM: getState().useOFDM,
  });

  // Build the 24-bit sentinel 0xE79FE7 as 12 BPSK symbols (2 bits/symbol)
  // Actually use 4 tones = 4 bits/symbol = 6 symbols for 24 bits
  const sentinel = 0xe79fe7;
  const bits: number[] = [];
  for (let i = 23; i >= 0; i--) bits.push((sentinel >> i) & 1);
  console.warn(`[SENTINEL-TEST] Sentinel bits (24): ${bits.join('')}`);

  // Pad to 8 symbols (32 bits) with zeros for clean symbol boundaries
  while (bits.length < 32) bits.push(0);

  // Generate raw BPSK audio using TxEngine's modulator
  const preamble = tx.transmitPreamble();
  const symbols = bits.length / 4; // 8 symbols
  const SPS = 256;
  const totalSamples = symbols * SPS;
  const audio = new Float32Array(totalSamples);
  const bitIdx = 0;

  // Build a minimal frame-like header for transmitFrame
  const payload = new Uint8Array(40);
  // Just use the sentinel bytes directly in the payload for visual confirmation
  payload[0] = 0xe7;
  payload[1] = 0x9f;
  payload[2] = 0xe7;
  const frameAudio = tx.transmitFrame({ type: 0x01, seqNum: 0, totalFrames: 1, crc: 0 }, payload);
  // But strip to just the first 8 symbols (sentinel + 2 more symbols)
  const shortAudio = frameAudio.slice(0, 8 * SPS);

  console.warn(
    `[SENTINEL-TEST] Audio: ${shortAudio.length} samples = ${(shortAudio.length / DEFAULT_CONFIG.sampleRate).toFixed(2)}s`,
  );

  const silence = new Float32Array(
    Math.round((DEFAULT_CONFIG.sampleRate / getState().symbolsPerSec) * 2),
  );
  const full = new Float32Array(preamble.length + shortAudio.length + silence.length);
  full.set(preamble, 0);
  full.set(shortAudio, preamble.length);
  full.set(silence, preamble.length + shortAudio.length);

  setState({ isPlaying: true });
  await player.play(full, DEFAULT_CONFIG.sampleRate, getState().selectedOutputId || undefined);
  await new Promise((r) => setTimeout(r, 500));
  console.warn('━━━ [SENTINEL-TEST] Done — check for sentinel detection ━━━');
  setState({
    isPlaying: false,
    sendStatus: { type: 'success', msg: '✅ Sentinel sent — check console' },
  });
}

// ─── Speed / auto-tune sweep ─────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => { window.setTimeout(r, ms); });

/** Speaker→mic→worklet→worker latency to absorb after playback ends. */
const ACOUSTIC_DRAIN_MS = 250;
/** Ceiling on the post-flush wait for the async decompress + fileComplete hop. */
const DECODE_GRACE_MS = 300;
/**
 * Quiet gap between acoustic trials. Room reverb and late-arriving audio from
 * the previous transmission would otherwise reach the next trial's freshly
 * constructed RxEngine, which can sync onto the tail of the wrong signal.
 */
const ACOUSTIC_SETTLE_MS = 300;
/** Repeats per point on the acoustic path — it is not a repeatable measurement. */
const ACOUSTIC_ATTEMPTS = 2;

function parseLastMer(log: string): { merDb: number; evmPct: number; verdict: string } | null {
  const lines = log.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(
      /\[OFDM-MER\]\s+merDb=([\d.]+)\s+evmPct=([\d.]+)\s+symbols=\d+\s+verdict=(.+)/,
    );
    if (m) {
      return { merDb: parseFloat(m[1]), evmPct: parseFloat(m[2]), verdict: m[3].trim() };
    }
  }
  return null;
}

/**
 * Best staged MER seen across the failed frames of a trial (`smer=` on RX-FAIL).
 * Unlike the committed OFDM-MER report this exists even when every frame fails,
 * which is what makes a gradient available in the region the hunt cares about.
 */
function parseRawMer(log: string): number | null {
  let best: number | null = null;
  for (const m of log.matchAll(/\[RX-FAIL\][^\n]*\bsmer=(-?[\d.]+)/g)) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && (best === null || v > best)) best = v;
  }
  return best;
}

/**
 * How far the receiver got, so trials that decode nothing still rank against
 * each other: 0 nothing · 1 chirp seen · 2 boundary handoff · 3 trained.
 *
 * Deliberately tops out at 3. A decoded PROFILE frame also means "trained" and
 * nothing more — and only 16/64-QAM emit profiles at all (QPSK must not, or the
 * waveform changes), so scoring it as a separate higher level handed every QAM
 * trial a free bonus over every QPSK trial.
 */
function parseSyncLevel(log: string): number {
  if (/\[RX-PROFILE\]\s+(?!invalid)/.test(log)) return 3;
  if (log.includes('[OFDM-TRAIN]')) return 3;
  if (/\[OFDM-SYNC\][^\n]*\b(chirpHandoff|aligned)=true/.test(log)) return 2;
  if (/\[OFDM-SYNC\][^\n]*\b(chirp|detected)=true/.test(log)) return 1;
  return 0;
}


function parseFrameStats(log: string): { ok: number; fail: number; total: number; dataOk: number } {
  const ok = (log.match(/\[RX-FRAME\]\s+ok=true/g) ?? []).length;
  const fail = (log.match(/\[RX-FRAME\]\s+ok=false/g) ?? []).length;
  // PROFILE frames (0x04) are sent at the base QPSK rate whatever the data
  // constellation is, so they decode even when every data frame fails. Counting
  // them as progress let a 16-QAM config that carried zero payload score as if
  // it were partly working. Only header/payload/tail frames prove data got
  // through at the constellation under test.
  let dataOk = 0;
  for (const m of log.matchAll(/\[RX-FRAME\]\s+ok=true\s+t=(0x[0-9a-f]+)/g)) {
    if (m[1] !== '0x4' && m[1] !== '0x04') dataOk++;
  }
  return { ok, fail, total: ok + fail, dataOk };
}

async function runSpeedTest() {
  if (speedTestActive) return;
  if (!getState().useOFDM) {
    setState({ sendStatus: { type: 'error', msg: 'TEST SPEED is OFDM-only' } });
    return;
  }

  speedTestActive = true;
  setState({ speedTestRunning: true, speedTestResults: [], speedTestBest: null });

  const state = getState();
  const loopback = state.speedTestLoopback;

  if (loopback) {
    if (isListening) stopListening();
  } else {
    await refreshDeviceList();
    if (!isListening) await startListening();
  }

  const originalMicGain = state.micGain;
  const originalCfg = buildModemConfig({
    useOFDM: true,
    pilotFreqHz: state.pilotFreqHz,
    toneStartHz: state.toneStartHz,
    toneCount: state.toneCount,
    symbolsPerSec: state.symbolsPerSec,
    musicalMode: state.musicalMode,
    diversityMode: state.diversityMode,
    hwSampleRate: audioCtx.sampleRate,
    dataQamBits: state.dataQamBits,
    qamScaleOverride: state.qamScaleOverride,
  });

  const hunt = state.speedTestMode === 'hunt';

  // Tune these arrays to sweep wider or finer. In hunt mode they are the ladder
  // of values each axis may step along, so a longer, finer list costs nothing
  // unless the climb actually walks into it.
  const toneCounts = [state.toneCount];
  // Mic gain is applied by the recorder, which loopback bypasses entirely —
  // sweeping it there would just re-run identical trials.
  // Spans the UI slider's full 1-20 range: a hunt that settles on the ladder's
  // last value has not found a maximum, it has hit the edge of the search.
  const micGains = loopback ? [state.micGain] : [1, 2, 4, 6, 8, 12, 16, 20];
  const basePilot = state.pilotFreqHz;
  // Pilot steps must be whole FFT bins. buildModemConfig snaps the pilot to the
  // nearest bin (CP continuity needs integer cycles per symbol), so a sub-bin
  // ladder entry silently becomes its neighbour — the hunt would then "probe" a
  // config identical to the incumbent, score it equal, and call that a local
  // maximum. Build the ladder in bin units and dedupe instead.
  const pilotBinHz = audioCtx.sampleRate / ofdmSamples(audioCtx.sampleRate).fftSamples;
  const snapPilot = (f: number) => Math.round(f / pilotBinHz) * pilotBinHz;
  const pilotFreqs = [...new Set(
    [-3, -2, -1, 0, 1, 2, 3].map((bins) => snapPilot(basePilot) + bins * pilotBinHz),
  )].filter((f) => f >= 200 && f <= 3500).sort((a, b) => a - b);
  const qamBitsList: Array<2 | 4 | 6> = [2, 4, 6];
  // Sentinel meaning "no override" — buildModemConfig omits qamScaleOverride
  // entirely (see runOnce), so the modulator falls back to its own derived
  // safe scale (0.95/worstCasePeak). Never a real transmitted scale (0 would
  // silence the signal), so it can't collide with a ladder rung.
  const AUTO_SCALE = 0;
  const qamScales = [AUTO_SCALE, 0.01, 0.02, 0.03, 0.05, 0.075, 0.1, 0.15, 0.2];
  const scaleLabel = (s: number) => (s === AUTO_SCALE ? 'auto' : s.toFixed(3));

  // Short payload: enough frames to exercise the pipeline but short enough
  // that the loopback path finishes processing well inside the wait window.
  const dataLen = PAYLOAD_DATA_SIZE * 4;
  const data = new Uint8Array(dataLen);
  for (let i = 0; i < dataLen; i++) data[i] = Math.floor(Math.random() * 256);

  const results: SpeedTestResult[] = [];

  interface Combo { toneCount: number; micGain: number; pilotFreqHz: number; qamBits: 2 | 4 | 6; qamScale: number }

  // qamScale is now part of the transmission for EVERY constellation order,
  // QPSK included: Task 8 (TX level flattening) removed the per-symbol
  // peak-normalize QPSK used to rely on, so a QPSK combo differing only in
  // scale is now a physically different transmission and must NOT share a
  // cache entry with another scale (that used to be true and isn't anymore —
  // merging them silently biased the hunt's QPSK trials to whatever scale
  // the search happened to be carrying).
  //
  // The pilot is keyed post-snap, since that is the config that actually runs.
  // toneStartHz is read live from state per trial (see runOnce), not carried
  // on Combo itself — but the cache still has to key on it, or dragging the
  // slider mid-hunt makes a later re-probe of an otherwise-identical combo
  // silently reuse a result computed under a different tone grid.
  const keyOf = (c: Combo) =>
    `${c.toneCount}|${c.micGain}|${snapPilot(c.pilotFreqHz)}|${c.qamBits}|${c.qamScale}|${state.toneStartHz}`;

  let currentCombo = 0;
  let lastMicGain: number | null = null;
  const cache = new Map<string, SpeedTestResult>();
  const attemptsPerPoint = loopback ? 1 : ACOUSTIC_ATTEMPTS;

  if (!loopback) player.volume = state.playbackVolume;

  /**
   * Run one trial and report whether the file decoded.
   *
   * Both paths use the worker's `flush()` barrier instead of waiting out a
   * timeout: once flush resolves, every sample posted has already been
   * demodulated, so `fileReady === false` means the trial failed and no file is
   * coming. Only the success path waits, and only for the short async
   * decompress + postMessage hop. A failed trial used to cost 1.5–5 s.
   */
  async function transmitAndWait(
    samples: Float32Array,
    fileName: string,
    cfg: ReturnType<typeof buildModemConfig>,
    graceMs: number,
  ): Promise<boolean> {
    speedTestExpectedFile = fileName;
    dlogReset();
    let done = false;
    const off = modem.on('fileComplete', (ev) => { if (ev.fileName === fileName) done = true; });
    try {
      modem.configure(cfg);
      if (loopback) {
        // Commands run in post order, so configure is applied before the feed.
        modem.feedSamples(samples);
      } else {
        setState({ isPlaying: true });
        await player.play(samples, cfg.sampleRate, state.selectedOutputId || undefined);
        setState({ isPlaying: false });
        // Let the last of the audio travel speaker→mic→worklet→worker.
        await sleep(ACOUSTIC_DRAIN_MS);
      }
      const ready = await modem.flush();
      if (!ready && !done) return false;
      for (let waited = 0; waited < graceMs && !done; waited += 5) await sleep(5);
      return done;
    } finally {
      off();
    }
  }

  /**
   * Run one combo `attempts` times and keep the WORST-scoring attempt, or return
   * the cached result if this exact combo already ran.
   *
   * Repeats exist because the acoustic path is not repeatable: across two runs
   * the identical config (1900 Hz, gain 6, QPSK) scored 25.0 dB with 6/6 frames
   * once and 7.2 dB with 0 frames the next. Coordinate descent assumes a stable
   * score per point, so a single lucky trial can anchor the whole climb and make
   * consecutive runs disagree. Taking the worst attempt is deliberately
   * pessimistic: a config only wins if it works when it is not lucky.
   * Loopback is deterministic, so it stays at one attempt.
   */
  async function runTrial(combo: Combo, phase: string, total: number): Promise<SpeedTestResult> {
    const key = keyOf(combo);
    const hit = cache.get(key);
    if (hit) return hit;

    let worst: SpeedTestResult | null = null;
    const scores: number[] = [];
    for (let attempt = 0; attempt < attemptsPerPoint; attempt++) {
      const r = await runOnce(combo, phase, total);
      scores.push(r.score ?? 0);
      if (!worst || (r.score ?? 0) < (worst.score ?? 0)) worst = r;
    }
    const chosen: SpeedTestResult = { ...worst!, attempts: attemptsPerPoint, attemptScores: scores };
    cache.set(key, chosen);
    return chosen;
  }

  /** One transmission + decode + parse. */
  async function runOnce(combo: Combo, phase: string, total: number): Promise<SpeedTestResult> {
    const { toneCount, micGain, pilotFreqHz, qamBits, qamScale } = combo;
    if (!loopback && micGain !== lastMicGain) {
      modem.setMicGain(micGain);
      lastMicGain = micGain;
      await sleep(50);
    }
    currentCombo++;
    setState({ speedTestProgress: { current: currentCombo, total } });

    const fileName = `__speed_${pilotFreqHz.toFixed(0)}_${qamBits}_${scaleLabel(qamScale)}_${micGain}_${toneCount}.txt`;
    const cfg = buildModemConfig({
      useOFDM: true,
      pilotFreqHz,
      toneStartHz: state.toneStartHz,
      toneCount,
      symbolsPerSec: state.symbolsPerSec,
      musicalMode: state.musicalMode,
      diversityMode: state.diversityMode,
      hwSampleRate: audioCtx.sampleRate,
      dataQamBits: qamBits,
      // AUTO_SCALE (0) means "no override" — omit the field so the modulator
      // falls back to its own derived safe scale, instead of materialising an
      // explicit (and possibly suboptimal) scale for every trial.
      qamScaleOverride: qamScale === AUTO_SCALE ? undefined : qamScale,
    });

    const tx = new TxEngine(cfg);
    const samples = tx.transmitFile(fileName, data, 0, data.length);
    const durationMs = (samples.length / cfg.sampleRate) * 1000;

    const decoded = await transmitAndWait(samples, fileName, cfg, DECODE_GRACE_MS);

    // Take the WHOLE ring: these lines get counted, not just eyeballed, and a
    // short tail silently evicts early RX-FRAME lines while keeping later
    // OFDM-MER ones — producing "0 frames, MER 21 dB" nonsense. If the ring
    // saturated, the counts are still suspect, so flag it rather than trust it.
    const log = dlogDump(DLOG_RING_MAX);
    const logTruncated = dlogRingLength() >= DLOG_RING_MAX;
    const mer = parseLastMer(log);
    const frames = parseFrameStats(log);
    const throughputKbps = (dataLen * 8) / 1000 / (durationMs / 1000);

    const result: SpeedTestResult = {
      toneCount,
      micGain,
      pilotFreqHz,
      qamBits,
      qamScale,
      success: decoded,
      passes: decoded ? 1 : 0,
      framesOk: frames.ok,
      framesTotal: frames.total,
      dataFramesOk: frames.dataOk,
      merDb: mer?.merDb ?? null,
      evmPct: mer?.evmPct ?? null,
      throughputKbps,
      durationMs,
      rawMerDb: parseRawMer(log),
      syncLevel: parseSyncLevel(log),
      logTruncated,
      phase,
    };
    result.score = scoreTrial(result);
    results.push(result);
    setState({ speedTestResults: [...results] });

    dlog('SPEED-TEST', {
      combo: `${currentCombo}/${total}`,
      ax: phase,
      tones: toneCount,
      gain: micGain,
      pilot: pilotFreqHz,
      qam: qamBits,
      scale: scaleLabel(qamScale),
      ok: decoded,
      f: `${frames.dataOk}d ${frames.ok}/${frames.total}`,
      sync: result.syncLevel,
      mer: mer ? mer.merDb.toFixed(1) : '—',
      raw: result.rawMerDb?.toFixed(1) ?? '—',
      ...(logTruncated ? { logTruncated: 1 } : {}),
      score: result.score!.toFixed(1),
      kbps: throughputKbps.toFixed(1),
    });

    // Loopback needs no settle between trials. The acoustic path does: room
    // reverb and late-arriving audio from this trial otherwise bleed into the
    // next one's fresh RxEngine and corrupt its sync.
    if (!loopback) await sleep(ACOUSTIC_SETTLE_MS);
    return result;
  }

  /**
   * Coordinate descent (a.k.a. compass/pattern search) over the sweep axes.
   *
   * Axes are ordered by what has to work first: sync (pilot, then mic gain)
   * before the QAM slicer (scale), before pushing constellation density. For
   * each axis we probe one step either side of the incumbent; if a probe scores
   * better we keep stepping that same direction until it stops improving —
   * i.e. we walk to the local maximum on that axis — then move to the next. A
   * full pass that moves nothing means converged.
   *
   * Caveat worth knowing: on the acoustic path a single trial per point is a
   * noisy measurement, so a marginal config can win a probe by luck and anchor
   * the rest of the climb. Loopback is deterministic and has no such problem.
   */
  async function runHunt(): Promise<void> {
    // Scales tried when stepping the qam axis up (see probeVariants below).
    // Spread across the ladder rather than adjacent, because the right scale for
    // a new constellation order is not near the old order's — and reaching the
    // TOP of the ladder, because 16-QAM's first success came at the highest
    // scale probed, which means the real optimum may be past it. AUTO_SCALE
    // (no override, modulator's own derived safe scale) is included and
    // tried FIRST — it's a reasonable default for any order, not just QPSK,
    // and cheaper to rule in/out than assuming an explicit small scale is
    // always better.
    const QAM_PROBE_SCALES = [AUTO_SCALE, 0.02, 0.03, 0.05, 0.1, 0.15, 0.2];

    const allAxes: Array<DescentAxis<Combo>> = [
      { name: 'pilot', values: pilotFreqs, get: (c) => c.pilotFreqHz, set: (c, v) => ({ ...c, pilotFreqHz: v }) },
      { name: 'gain', values: micGains, get: (c) => c.micGain, set: (c, v) => ({ ...c, micGain: v }) },
      { name: 'scale', values: qamScales, get: (c) => c.qamScale, set: (c, v) => ({ ...c, qamScale: v }) },
      {
        name: 'qam',
        values: qamBitsList,
        get: (c) => c.qamBits,
        set: (c, v) => ({ ...c, qamBits: v as 2 | 4 | 6 }),
        // qamScale and qamBits are coupled: scale is meaningless at QPSK and
        // order-specific above it. Judging a step to 16/64-QAM at whatever scale
        // the QPSK incumbent happened to hold rejects the denser constellation
        // for the wrong reason. Try a spread of scales and let the order be
        // judged at its own best.
        probeVariants: (c, v) => {
          const bits = v as 2 | 4 | 6;
          if (bits === 2) return [{ ...c, qamBits: bits }];
          return QAM_PROBE_SCALES.map((qamScale) => ({ ...c, qamBits: bits, qamScale }));
        },
      },
      { name: 'tones', values: toneCounts, get: (c) => c.toneCount, set: (c, v) => ({ ...c, toneCount: v }) },
    ];

    // Start from the most robust corner that still resembles the user's
    // settings: QPSK, current pilot/gain/tone count. Climbing from a config
    // that at least syncs gives the score something to improve on.
    const nearest = (values: number[], want: number) =>
      values.reduce((best, v) => (Math.abs(v - want) < Math.abs(best - want) ? v : best), values[0]);
    const start: Combo = {
      toneCount: state.toneCount,
      micGain: nearest(micGains, state.micGain),
      pilotFreqHz: snapPilot(basePilot),
      qamBits: 2,
      // Prefer Auto (no override -> the modulator's own derived worst-case-safe
      // scale) as the starting candidate rather than always materialising an
      // explicit small scale: Task 8 made that derived scale the safe default
      // for every constellation order, including QPSK, so it's the natural
      // place to start refining from. Only start away from Auto if the user
      // has actually dialed in an override.
      qamScale: state.qamScaleOverride === undefined
        ? AUTO_SCALE
        : nearest(qamScales, state.qamScaleOverride),
    };

    // Budget is an upper bound on trials, not a target: convergence usually
    // stops the hunt far earlier. Sized so a worst case still beats a grid,
    // with headroom for the qam axis's multi-scale probes.
    const budget = Math.max(
      32,
      allAxes.reduce((n, a) => n + a.values.length, 0) * 2 + qamBitsList.length * QAM_PROBE_SCALES.length,
    );

    // The budget counts points evaluated; each point costs `attemptsPerPoint`
    // transmissions, and the progress counter counts transmissions.
    const shownTotal = budget * attemptsPerPoint;

    const outcome = await coordinateDescent<Combo>({
      axes: allAxes,
      start,
      budget,
      // runTrial caches by config-identity, so a re-probed point costs nothing
      // and the walk sees a stable score for it.
      evaluate: async (point, axisName) => (await runTrial(point, axisName, shownTotal)).score ?? 0,
      onAxisSettled: (name, at, score) => {
        // Settling on the first/last rung means the climb ran out of ladder, not
        // that it found a peak — the real optimum may lie outside the range.
        const values = allAxes.find((a) => a.name === name)?.values ?? [];
        const atEdge = values.length > 1 && (at === values[0] || at === values[values.length - 1]);
        dlog('SPEED-HUNT', {
          axis: name,
          at,
          score: score.toFixed(1),
          ...(atEdge ? { atLadderEdge: true } : {}),
        });
      },
    });

    dlog('SPEED-HUNT', {
      done: true,
      converged: outcome.converged,
      passes: outcome.passes,
      trials: currentCombo,
      score: outcome.score.toFixed(1),
    });
  }

  let aborted: string | null = null;
  try {
    if (hunt) {
      await runHunt();
    } else {
      const combos: Combo[] = [];
      for (const toneCount of toneCounts) {
        for (const micGain of micGains) {
          for (const pilotFreqHz of pilotFreqs) {
            // qamScale now affects QPSK too (Task 8 removed QPSK's per-symbol
            // peak-normalize), so it's swept across the full ladder for every
            // order — QPSK is no longer special-cased to a single scale.
            for (const qamBits of qamBitsList) {
              for (const qamScale of qamScales) combos.push({ toneCount, micGain, pilotFreqHz, qamBits, qamScale });
            }
          }
        }
      }
      for (const combo of combos) await runTrial(combo, 'grid', combos.length * attemptsPerPoint);
    }
  } catch (err) {
    // A throw part-way through used to end the sweep silently, which looked
    // exactly like an early convergence. Keep the results gathered so far and
    // say plainly that it stopped.
    aborted = (err as Error).message;
    dlog('SPEED-TEST', { aborted: aborted }, { level: 'warn' });
  } finally {
    speedTestActive = false;
    speedTestExpectedFile = null;
    setState({ speedTestRunning: false, speedTestProgress: null });
    if (!loopback) {
      modem.configure(originalCfg);
      modem.setMicGain(originalMicGain);
    }
    setState({
      sendStatus: aborted
        ? { type: 'error', msg: `Speed test stopped after ${results.length} trials: ${aborted}` }
        : { type: 'info', msg: `Speed test done — ${results.length} trials` },
    });
  }

  // Same objective the hunt climbed, so "best" means the same thing in both
  // modes. Only successes can be "best"; a run where nothing decoded reports
  // no winner (the results table still shows how close each trial got).
  const passing = results
    .filter((r) => r.success)
    .sort((a, b) => (b.score ?? scoreTrial(b)) - (a.score ?? scoreTrial(a)));
  const best = passing[0] ?? null;
  setState({ speedTestBest: best });

  if (!best) {
    const closest = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (closest) {
      dlog('SPEED-TEST', {
        nothingDecoded: true,
        closest: `pilot=${closest.pilotFreqHz} qam=${closest.qamBits} scale=${scaleLabel(closest.qamScale)}`,
        sync: closest.syncLevel,
        frames: `${closest.framesOk}/${closest.framesTotal}`,
        mer: (closest.merDb ?? closest.rawMerDb)?.toFixed(1) ?? '—',
      });
    }
  }

  // eslint-disable-next-line no-console -- debug summary
  console.table(results.map((r) => ({
    // The constellation name, not the bit count: qamBits=4 is 16-QAM.
    QAM: r.qamBits === 2 ? 'QPSK' : r.qamBits === 4 ? '16-QAM' : '64-QAM',
    Hz: r.pilotFreqHz,
    // qamScale now affects every order, QPSK included (Task 8) — no more
    // em-dash special-case for QPSK.
    Scale: scaleLabel(r.qamScale),
    Gain: r.micGain,
    Tones: r.toneCount,
    OK: r.success ? 'Y' : 'N',
    // Data frames are the honest count; profile frames ride at QPSK regardless
    // of the constellation under test, so they decode even when nothing works.
    Data: `${r.dataFramesOk ?? r.framesOk}`,
    Frames: `${r.framesOk}/${r.framesTotal}`,
    // MER is committed-only, i.e. measured on frames that PASSED — survivor
    // biased. rawMER is the staged MER of frames that FAILED, which is the
    // number that explains a failure.
    MER: r.merDb?.toFixed(1) ?? '—',
    rawMER: r.rawMerDb?.toFixed(1) ?? '—',
    Sync: r.syncLevel ?? 0,
    // 2dp: at 8 tones QPSK and 16-QAM both round to 0.3 at 1dp, which hid the
    // throughput difference the ranking depends on.
    kbps: r.throughputKbps.toFixed(2),
    // Worst of N attempts is what ranked; spread shows how unrepeatable the
    // point is. '!' marks counts parsed from a saturated debug ring.
    Tries: r.attemptScores?.length ?? 1,
    Trunc: r.logTruncated ? '!' : '',
  })));
  if (best) {
    dlog('SPEED-TEST', {
      best: `${best.qamBits === 2 ? 'QPSK' : `${best.qamBits}-QAM`}`,
      pilot: best.pilotFreqHz,
      scale: scaleLabel(best.qamScale),
      gain: best.micGain,
      tones: best.toneCount,
      kbps: best.throughputKbps.toFixed(1),
      mer: best.merDb?.toFixed(1) ?? '—',
    });
  }
}

// ─── Audio Path Validation Sweep ─────────────────────

/** Quick audio loopback validation: play tones, measure mic response. */
async function runAudioValidation() {
  console.warn('━━━ [AUDIO-VAL] Audio path validation sweep ━━━');
  setState({ sendStatus: { type: 'info', msg: '🔊 Audio validation…' } });
  await refreshDeviceList();
  if (!isListening) await startListening();
  await new Promise((r) => setTimeout(r, 300));

  const modemRate = DEFAULT_CONFIG.sampleRate;
  const outputRate = player.getSampleRate();
  const testFreqs = [412.5, 612.5, 762.5, 912.5, 1112.5];
  const toneDuration = 0.15; // 150ms per tone
  const toneSamples = Math.floor(modemRate * toneDuration);
  const gapSamples = Math.floor(modemRate * 0.05); // 50ms gap

  console.warn(`[AUDIO-VAL] Modem rate: ${modemRate}Hz, Output rate: ${outputRate}Hz`);
  console.warn(`[AUDIO-VAL] Testing ${testFreqs.length} frequencies: ${testFreqs.join(', ')}Hz`);

  player.volume = getState().playbackVolume;

  const results: Array<{
      freq: number;
      txPeak: number;
      rxEnergy: number;
      rxPeak: number;
      rxSnr: number;
    }> = [];

  for (const freq of testFreqs) {
    // Generate tone at modem rate
    const tone = new Float32Array(toneSamples + gapSamples);
    for (let i = 0; i < toneSamples; i++) {
      tone[i] = Math.sin((2 * Math.PI * freq * i) / modemRate) * 0.5;
    }
    const txPeak = 0.5;

    // Upsample to output rate for clean playback
    const ratio = modemRate / outputRate; // 3200 / 48000 = 0.0667
    const outLen = Math.ceil(tone.length / ratio);
    const playBuf = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = tone[idx] ?? 0;
      const b = tone[Math.min(idx + 1, tone.length - 1)] ?? 0;
      playBuf[i] = a + (b - a) * frac;
    }

    // Snapshot received samples count
    const preCount = recvSamples.length;
    setState({ isPlaying: true });
    await player.play(playBuf, outputRate, getState().selectedOutputId || undefined);
    setState({ isPlaying: false });
    await new Promise((r) => setTimeout(r, 100));

    // Analyze received audio at this frequency
    const newSamples = recvSamples.slice(preCount);
    if (newSamples.length < 64) {
      results.push({ freq, txPeak, rxEnergy: 0, rxPeak: 0, rxSnr: -999 });
      console.warn(`[AUDIO-VAL] ${freq}Hz: no samples received`);
      continue;
    }

    const tail = newSamples.slice(-Math.min(512, newSamples.length));
    let rxPeak = 0;
    let sumSq = 0;
    for (const s of tail) {
      const abs = Math.abs(s);
      if (abs > rxPeak) rxPeak = abs;
      sumSq += s * s;
    }
    const rxRms = Math.sqrt(sumSq / tail.length);

    // Energy at the transmitted frequency (Goertzel)
    let sinCorr = 0,
      cosCorr = 0;
    for (let i = 0; i < tail.length; i++) {
      const phase = (2 * Math.PI * freq * i) / modemRate;
      sinCorr += tail[i] * Math.sin(phase);
      cosCorr += tail[i] * Math.cos(phase);
    }
    const rxEnergy = Math.hypot(sinCorr, cosCorr) / tail.length;

    // Background energy at nearby frequencies (for SNR)
    const offFreq = freq + 25;
    let offSin = 0,
      offCos = 0;
    for (let i = 0; i < tail.length; i++) {
      const phase = (2 * Math.PI * offFreq * i) / modemRate;
      offSin += tail[i] * Math.sin(phase);
      offCos += tail[i] * Math.cos(phase);
    }
    const noiseEnergy = Math.hypot(offSin, offCos) / tail.length;
    const snr = noiseEnergy > 1e-12 ? 20 * Math.log10(rxEnergy / noiseEnergy) : 999;

    results.push({ freq, txPeak, rxEnergy, rxPeak, rxSnr: snr });
    console.warn(
      `[AUDIO-VAL] ${freq}Hz: rxEnergy=${rxEnergy.toExponential(2)} rxPeak=${rxPeak.toFixed(3)} SNR=${snr.toFixed(1)}dB`,
    );
  }

  // Summary
  console.warn('━━━ [AUDIO-VAL] Results ━━━');
  console.table(
    results.map((r) => ({
      'Freq (Hz)': r.freq,
      'TX Peak': r.txPeak.toFixed(2),
      'RX Peak': r.rxPeak.toFixed(3),
      'RX Energy': r.rxEnergy.toExponential(2),
      'SNR (dB)': r.rxSnr.toFixed(1),
    })),
  );

  const avgSnr = results.reduce((a, r) => a + r.rxSnr, 0) / results.length;
  const allDetected = results.every((r) => r.rxEnergy > 1e-5);
  console.warn(
    `[AUDIO-VAL] Average SNR: ${avgSnr.toFixed(1)}dB | All detected: ${allDetected ? 'YES ✅' : 'NO ❌'}`,
  );

  setState({
    sendStatus: {
      type: allDetected ? 'success' : 'error',
      msg: allDetected
        ? `✅ Audio path OK (${avgSnr.toFixed(0)}dB SNR)`
        : '❌ Audio issues — check console',
    },
  });
}

// ─── Full Frequency Sweep ────────────────────────────

/** Sweep 100-1500Hz at 100Hz steps to find optimal tone placement. */
async function runFullSweep() {
  console.warn('━━━ [FULL-SWEEP] Full frequency response sweep 100-1500Hz ━━━');
  setState({ sendStatus: { type: 'info', msg: '🔊 Full sweep…' } });
  await refreshDeviceList();
  if (!isListening) await startListening();
  await new Promise((r) => setTimeout(r, 200));

  const modemRate = DEFAULT_CONFIG.sampleRate;
  const outputRate = player.getSampleRate();
  player.volume = getState().playbackVolume;

  const testFreqs: number[] = [];
  for (let f = 100; f <= 1500; f += 100) testFreqs.push(f);

  console.warn(
    `[FULL-SWEEP] ${testFreqs.length} frequencies: ${testFreqs[0]}-${testFreqs[testFreqs.length - 1]}Hz`,
  );

  const toneDuration = 0.15; // 150ms — long enough to survive RxEngine preamble
  const toneSamples = Math.floor(modemRate * toneDuration);
  const gapSamples = Math.floor(modemRate * 0.03);

  const results: Array<{ freq: number; energy: number; snr: number }> = [];

  for (const freq of testFreqs) {
    const tone = new Float32Array(toneSamples + gapSamples);
    for (let i = 0; i < toneSamples; i++) {
      tone[i] = Math.sin((2 * Math.PI * freq * i) / modemRate) * 0.5;
    }

    // Upsample to output rate
    const ratio = modemRate / outputRate;
    const outLen = Math.ceil(tone.length / ratio);
    const playBuf = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = tone[idx] ?? 0;
      const b = tone[Math.min(idx + 1, tone.length - 1)] ?? 0;
      playBuf[i] = a + (b - a) * frac;
    }

    const preCount = recvSamples.length;
    setState({ isPlaying: true });
    await player.play(playBuf, outputRate, getState().selectedOutputId || undefined);
    setState({ isPlaying: false });
    await new Promise((r) => setTimeout(r, 50));

    const newSamples = recvSamples.slice(preCount);
    if (newSamples.length < 32) {
      results.push({ freq, energy: 0, snr: -999 });
      continue;
    }

    const tail = newSamples.slice(-Math.min(256, newSamples.length));
    const tail32 = new Float32Array(tail);

    // Energy at freq
    let sSin = 0,
      sCos = 0;
    for (let i = 0; i < tail32.length; i++) {
      const ph = (2 * Math.PI * freq * i) / modemRate;
      sSin += tail32[i] * Math.sin(ph);
      sCos += tail32[i] * Math.cos(ph);
    }
    const energy = Math.hypot(sSin, sCos) / tail32.length;

    // Noise at freq+25Hz
    let nSin = 0,
      nCos = 0;
    for (let i = 0; i < tail32.length; i++) {
      const ph = (2 * Math.PI * (freq + 25) * i) / modemRate;
      nSin += tail32[i] * Math.sin(ph);
      nCos += tail32[i] * Math.cos(ph);
    }
    const noise = Math.hypot(nSin, nCos) / tail32.length;
    const snr = noise > 1e-12 ? 20 * Math.log10(energy / noise) : 999;

    results.push({ freq, energy, snr });

    if (results.length % 5 === 0) {
      setState({
        sendStatus: { type: 'info', msg: `🔊 Sweep: ${results.length}/${testFreqs.length}` },
      });
    }
  }

  // Find best frequencies — top 5 by SNR, at least 100Hz apart
  const sorted = [...results].sort((a, b) => b.snr - a.snr);
  const bestSpots: typeof results = [];
  for (const r of sorted) {
    if (bestSpots.length >= 5) break;
    if (bestSpots.every((s) => Math.abs(s.freq - r.freq) >= 100)) {
      bestSpots.push(r);
    }
  }
  bestSpots.sort((a, b) => a.freq - b.freq);

  // Find contiguous good bands (2+ consecutive frequencies with SNR > 15dB)
  const MIN_SNR = 15;
  const goodBands: Array<{ start: number; end: number; avgSnr: number; width: number }> = [];
  let bandStart = -1;
  for (let i = 0; i < results.length; i++) {
    if (results[i].snr >= MIN_SNR) {
      if (bandStart < 0) bandStart = i;
    } else {
      if (bandStart >= 0 && i - bandStart >= 2) {
        const band = results.slice(bandStart, i);
        goodBands.push({
          start: band[0].freq,
          end: band[band.length - 1].freq,
          avgSnr: band.reduce((a, r) => a + r.snr, 0) / band.length,
          width: band[band.length - 1].freq - band[0].freq,
        });
      }
      bandStart = -1;
    }
  }
  // Flush last band
  if (bandStart >= 0 && results.length - bandStart >= 2) {
    const band = results.slice(bandStart);
    goodBands.push({
      start: band[0].freq,
      end: band[band.length - 1].freq,
      avgSnr: band.reduce((a, r) => a + r.snr, 0) / band.length,
      width: band[band.length - 1].freq - band[0].freq,
    });
  }

  console.warn('━━━ [FULL-SWEEP] Results ━━━');
  console.table(
    results.map((r) => ({
      'Freq (Hz)': r.freq,
      Energy: r.energy.toExponential(2),
      'SNR (dB)': r.snr.toFixed(1),
    })),
  );

  if (goodBands.length > 0) {
    console.warn(`[FULL-SWEEP] Good bands (SNR > ${MIN_SNR}dB, ≥2 consecutive):`);
    console.table(
      goodBands.map((b) => ({
        Range: `${b.start}-${b.end}Hz`,
        Width: `${b.width}Hz`,
        'Avg SNR': `${b.avgSnr.toFixed(1)}dB`,
      })),
    );
    // Suggest best band for tones
    const best = goodBands.reduce((a, b) => (b.width > a.width ? b : a), goodBands[0]);
    console.warn(
      `[FULL-SWEEP] Widest good band: ${best.start}-${best.end}Hz (${best.width}Hz, ${best.avgSnr.toFixed(1)}dB SNR)`,
    );
  } else {
    console.warn('[FULL-SWEEP] No contiguous good bands found — SNR too low across range');
  }

  console.warn(
    `[FULL-SWEEP] Best 5 spaced spots: ${bestSpots.map((s) => `${s.freq}Hz (${s.snr.toFixed(1)}dB)`).join(', ')}`,
  );
  console.warn(
    `[FULL-SWEEP] Suggested pilot: ${bestSpots[0]?.freq ?? '?'}Hz, tones: ${bestSpots
      .slice(1)
      .map((s) => `${s.freq}Hz`)
      .join(', ')}`,
  );

  setState({
    sendStatus: {
      type: 'success',
      msg: `✅ Sweep done — ${results.length} freqs. Best: ${bestSpots.map((s) => s.freq).join(',')}Hz`,
    },
  });
}

// ─── Multi-Tone Overlap Sweep ────────────────────────

/** Play 5 simultaneous tones at 100Hz spacing, sweeping the base frequency
   *  from 100 to 1100Hz. Maps which channels survive cross-talk at every position. */
async function runMultiToneSweep() {
  console.warn('━━━ [MULTI-TONE] Full-range 5-tone overlap sweep ━━━');
  setState({ sendStatus: { type: 'info', msg: '🔊 Multi-tone sweep (slow)…' } });
  await refreshDeviceList();
  if (!isListening) await startListening();
  await new Promise((r) => setTimeout(r, 200));

  const modemRate = DEFAULT_CONFIG.sampleRate;
  const outputRate = player.getSampleRate();
  player.volume = getState().playbackVolume;

  // Sweep base from 100 to 1100Hz (last tone at base+400 fits within 1500Hz Nyquist)
  // At each position, play 5 tones: base, +100, +200, +300, +400
  const baseFreqs: number[] = [];
  for (let f = 100; f <= 1100; f += 100) baseFreqs.push(f);

  console.warn(
    `[MULTI-TONE] Testing ${baseFreqs.length} base positions (100-1100Hz), 5 tones each at 100Hz spacing`,
  );

  const allResults: Array<{ base: number; freqs: number[]; snrs: number[] }> = [];

  for (const base of baseFreqs) {
    const freqs = [base, base + 100, base + 200, base + 300, base + 400];
    const toneDuration = 0.15;
    const toneSamples = Math.floor(modemRate * toneDuration);
    const gapSamples = Math.floor(modemRate * 0.05);

    // Generate all 5 tones mixed together
    const tone = new Float32Array(toneSamples + gapSamples);
    for (let i = 0; i < toneSamples; i++) {
      let s = 0;
      for (const f of freqs) {
        s += Math.sin((2 * Math.PI * f * i) / modemRate) * 0.1;
      }
      tone[i] = s;
    }

    // Upsample to output rate
    const ratio = modemRate / outputRate;
    const outLen = Math.ceil(tone.length / ratio);
    const playBuf = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = tone[idx] ?? 0;
      const b = tone[Math.min(idx + 1, tone.length - 1)] ?? 0;
      playBuf[i] = a + (b - a) * frac;
    }

    const preCount = recvSamples.length;
    setState({ isPlaying: true });
    await player.play(playBuf, outputRate, getState().selectedOutputId || undefined);
    setState({ isPlaying: false });
    await new Promise((r) => setTimeout(r, 60));

    const newSamples = recvSamples.slice(preCount);
    if (newSamples.length < 64) {
      allResults.push({ base, freqs, snrs: [0, 0, 0, 0, 0] });
      continue;
    }

    const tail = new Float32Array(newSamples.slice(-Math.min(512, newSamples.length)));

    // Measure SNR of each tone
    const snrs: number[] = [];
    for (const freq of freqs) {
      let sSin = 0,
        sCos = 0;
      for (let i = 0; i < tail.length; i++) {
        const ph = (2 * Math.PI * freq * i) / modemRate;
        sSin += tail[i] * Math.sin(ph);
        sCos += tail[i] * Math.cos(ph);
      }
      const energy = Math.hypot(sSin, sCos) / tail.length;

      // Cross-talk energy at +50Hz offset
      let nSin = 0,
        nCos = 0;
      for (let i = 0; i < tail.length; i++) {
        const ph = (2 * Math.PI * (freq + 50) * i) / modemRate;
        nSin += tail[i] * Math.sin(ph);
        nCos += tail[i] * Math.cos(ph);
      }
      const noise = Math.hypot(nSin, nCos) / tail.length;
      snrs.push(noise > 1e-12 ? 20 * Math.log10(energy / noise) : 999);
    }

    allResults.push({ base, freqs, snrs });

    if (allResults.length % 5 === 0) {
      setState({
        sendStatus: {
          type: 'info',
          msg: `🔊 Multi-tone: ${allResults.length}/${baseFreqs.length}`,
        },
      });
    }
  }

  // Display as frequency-response table: each row = a tone slot, columns = base positions
  const toneLabels = ['T0', 'T1', 'T2', 'T3', 'T4'];
  console.warn(
    '━━━ [MULTI-TONE] Per-frequency SNR at each position (5 tones, 100Hz spacing) ━━━',
  );
  console.warn(
    'Format: each column is a base frequency. Each row is the Nth tone (base + N*100Hz).',
  );
  const rows: Record<string, string | number>[] = [];
  for (let t = 0; t < 5; t++) {
    const row: Record<string, string | number> = { Tone: toneLabels[t] };
    for (const r of allResults) {
      row[`${r.base}Hz`] = r.snrs[t].toFixed(1);
    }
    rows.push(row);
  }
  console.table(rows);

  // Summary: which positions have all 5 tones > 15dB?
  const goodPositions = allResults.filter((r) => r.snrs.every((s) => s > 15));
  console.warn(
    `[MULTI-TONE] Positions with ALL 5 tones >15dB: ${goodPositions.length}/${allResults.length}`,
  );
  if (goodPositions.length > 0) {
    const ranges: string[] = [];
    let rangeStart = goodPositions[0].base;
    let prev = rangeStart;
    for (let i = 1; i <= goodPositions.length; i++) {
      const cur = i < goodPositions.length ? goodPositions[i].base : -1;
      if (cur !== prev + 100) {
        const rangeEnd = prev + 400; // last tone = base + 400
        ranges.push(`${rangeStart}-${rangeEnd}Hz`);
        rangeStart = cur;
      }
      if (cur > 0) prev = cur;
    }
    console.warn(`[MULTI-TONE] Usable all-5-tone ranges: ${ranges.join(', ')}`);
  }

  setState({
    sendStatus: {
      type: 'success',
      msg: `✅ Multi-tone done. ${goodPositions.length}/${allResults.length} positions OK`,
    },
  });
}

// Wire
window.addEventListener('eardrop-multi-tone', (async () => {
  await runMultiToneSweep();
}) as EventListener);
(window as any).runMultiToneSweep = runMultiToneSweep;

// Wire
window.addEventListener('eardrop-full-sweep', (async () => {
  await runFullSweep();
}) as EventListener);
(window as any).runFullSweep = runFullSweep;

// Wire audio validation
window.addEventListener('eardrop-audio-validation', (async () => {
  await runAudioValidation();
}) as EventListener);
(window as any).runAudioValidation = runAudioValidation;

// Wire debug test events
window.addEventListener('eardrop-calibration-test', (async () => {
  await sendCalibrationOnly();
}) as EventListener);

window.addEventListener('eardrop-single-frame', (async () => {
  await sendSingleFrame();
}) as EventListener);

window.addEventListener('eardrop-sentinel-only', (async () => {
  await sendSentinelOnly();
}) as EventListener);

window.addEventListener('eardrop-speed-test', (async () => {
  await runSpeedTest();
}) as EventListener);

// Expose for console
(window as any).sendCalibrationOnly = sendCalibrationOnly;
(window as any).sendSingleFrame = sendSingleFrame;
(window as any).sendSentinelOnly = sendSentinelOnly;
(window as any).runSpeedTest = runSpeedTest;

// ─── Interference Matrix Sweep ────────────────────────

/** Test all tone pairs at variable offsets to map cross-channel interference.
   *  Builds a matrix: base × offset → min SNR. Shows what spacings work
   *  at each frequency range. Slow but comprehensive. */
async function runInterferenceSweep() {
  console.warn('━━━ [INTERFERENCE] Two-tone interference matrix sweep ━━━');
  setState({ sendStatus: { type: 'info', msg: '🔊 Interference sweep (slow)…' } });
  await refreshDeviceList();
  if (!isListening) await startListening();
  await new Promise((r) => setTimeout(r, 200));

  const modemRate = DEFAULT_CONFIG.sampleRate;
  const outputRate = player.getSampleRate();
  player.volume = getState().playbackVolume;

  // Base frequencies: every 50Hz from 100 to 1300
  const bases: number[] = [];
  for (let f = 100; f <= 1300; f += 50) bases.push(f);

  // Offsets: how far apart the two tones are
  const offsets = [50, 100, 150, 200, 250, 300, 400];

  console.warn(
    `[INTERFERENCE] ${bases.length} base × ${offsets.length} offsets = ${bases.length * offsets.length} tests`,
  );
  console.warn(
    `[INTERFERENCE] Estimated time: ~${(bases.length * offsets.length * 0.35).toFixed(0)}s`,
  );

  // Matrix: base → offset → [snr_tone1, snr_tone2]
  const matrix: Array<{
      base: number;
      offset: number;
      freq1: number;
      freq2: number;
      snr1: number;
      snr2: number;
      minSnr: number;
    }> = [];
  let testNum = 0;
  const total = bases.length * offsets.length;

  for (const base of bases) {
    for (const offset of offsets) {
      testNum++;
      const freq1 = base;
      const freq2 = base + offset;
      if (freq2 > 1500) continue; // skip beyond Nyquist

      const toneDuration = 0.12;
      const toneSamples = Math.floor(modemRate * toneDuration);
      const gapSamples = Math.floor(modemRate * 0.03);

      // Two tones mixed
      const tone = new Float32Array(toneSamples + gapSamples);
      for (let i = 0; i < toneSamples; i++) {
        tone[i] =
            Math.sin((2 * Math.PI * freq1 * i) / modemRate) * 0.25 +
            Math.sin((2 * Math.PI * freq2 * i) / modemRate) * 0.25;
      }

      // Upsample
      const ratio = modemRate / outputRate;
      const outLen = Math.ceil(tone.length / ratio);
      const playBuf = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = tone[idx] ?? 0;
        const b = tone[Math.min(idx + 1, tone.length - 1)] ?? 0;
        playBuf[i] = a + (b - a) * frac;
      }

      const preCount = recvSamples.length;
      setState({ isPlaying: true });
      await player.play(playBuf, outputRate, getState().selectedOutputId || undefined);
      setState({ isPlaying: false });
      await new Promise((r) => setTimeout(r, 50));

      const newSamples = recvSamples.slice(preCount);
      if (newSamples.length < 64) {
        matrix.push({ base, offset, freq1, freq2, snr1: -999, snr2: -999, minSnr: -999 });
        continue;
      }

      const tail = new Float32Array(newSamples.slice(-Math.min(384, newSamples.length)));

      // Measure SNR of each tone
      const measureSnr = (freq: number): number => {
        let sSin = 0,
          sCos = 0;
        for (let i = 0; i < tail.length; i++) {
          const ph = (2 * Math.PI * freq * i) / modemRate;
          sSin += tail[i] * Math.sin(ph);
          sCos += tail[i] * Math.cos(ph);
        }
        const energy = Math.hypot(sSin, sCos) / tail.length;
        // Noise at +/-25Hz (avoid the other tone)
        const noiseFreq = freq < freq2 ? freq - 25 : freq + 25;
        let nSin = 0,
          nCos = 0;
        for (let i = 0; i < tail.length; i++) {
          const ph = (2 * Math.PI * noiseFreq * i) / modemRate;
          nSin += tail[i] * Math.sin(ph);
          nCos += tail[i] * Math.cos(ph);
        }
        const noise = Math.hypot(nSin, nCos) / tail.length;
        return noise > 1e-12 ? 20 * Math.log10(energy / noise) : 999;
      };

      const snr1 = measureSnr(freq1);
      const snr2 = measureSnr(freq2);
      matrix.push({ base, offset, freq1, freq2, snr1, snr2, minSnr: Math.min(snr1, snr2) });

      if (testNum % 20 === 0) {
        setState({ sendStatus: { type: 'info', msg: `🔊 Interference: ${testNum}/${total}` } });
      }
    }
  }

  // Display as offset × base heatmap of min SNR
  console.warn('━━━ [INTERFERENCE] Two-tone interference matrix (min SNR of the pair) ━━━');
  const offsetRows: Record<string, string | number>[] = [];
  for (const offset of offsets) {
    const row: Record<string, string | number> = { Offset: `${offset}Hz` };
    for (const base of bases) {
      const entry = matrix.find((m) => m.base === base && m.offset === offset);
      if (entry) {
        const snr = entry.minSnr;
        row[`${base}`] =
            snr > 15 ? `✓${snr.toFixed(0)}` : snr > 5 ? `${snr.toFixed(0)}` : `✗${snr.toFixed(0)}`;
      } else {
        row[`${base}`] = '—';
      }
    }
    offsetRows.push(row);
  }
  console.table(offsetRows);

  // Summary: minimum safe offset at each base frequency
  console.warn('[INTERFERENCE] Minimum offset for both tones >15dB SNR:');
  for (const base of bases) {
    const safe = offsets.find((off) => {
      const e = matrix.find((m) => m.base === base && m.offset === off);
      return e && e.minSnr > 15;
    });
    if (safe) {
      console.warn(`  ${base}Hz: ≥${safe}Hz spacing needed`);
    }
  }

  setState({
    sendStatus: { type: 'success', msg: `✅ Interference done — ${matrix.length} pairs` },
  });
}

// Wire
window.addEventListener('eardrop-interference', (async () => {
  await runInterferenceSweep();
}) as EventListener);
(window as any).runInterferenceSweep = runInterferenceSweep;

// ─── Fine Verification Sweep ─────────────────────────

/** Tight sweep around candidate frequencies to verify spacing is robust,
   *  not just an artifact of the coarse sweep resolution. */
async function runFineSweep() {
  console.warn('━━━ [FINE-SWEEP] Fine verification at 10Hz resolution ━━━');
  setState({ sendStatus: { type: 'info', msg: '🔊 Fine sweep…' } });
  await refreshDeviceList();
  if (!isListening) await startListening();
  await new Promise((r) => setTimeout(r, 200));

  const modemRate = DEFAULT_CONFIG.sampleRate;
  const outputRate = player.getSampleRate();
  player.volume = getState().playbackVolume;

  // Test bases 550-650Hz with offsets 80-120Hz at 10Hz steps
  const bases: number[] = [];
  for (let f = 550; f <= 650; f += 10) bases.push(f);
  const offsets: number[] = [];
  for (let o = 80; o <= 120; o += 10) offsets.push(o);

  const total = bases.length * offsets.length;
  console.warn(
    `[FINE-SWEEP] ${bases.length} bases × ${offsets.length} offsets = ${total} tests at 10Hz resolution`,
  );

  const matrix: Array<{ base: number; offset: number; minSnr: number }> = [];

  for (const base of bases) {
    for (const offset of offsets) {
      const freq1 = base;
      const freq2 = base + offset;

      const toneDuration = 0.12;
      const toneSamples = Math.floor(modemRate * toneDuration);
      const gapSamples = Math.floor(modemRate * 0.03);

      const tone = new Float32Array(toneSamples + gapSamples);
      for (let i = 0; i < toneSamples; i++) {
        tone[i] =
            Math.sin((2 * Math.PI * freq1 * i) / modemRate) * 0.25 +
            Math.sin((2 * Math.PI * freq2 * i) / modemRate) * 0.25;
      }

      const ratio = modemRate / outputRate;
      const outLen = Math.ceil(tone.length / ratio);
      const playBuf = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = tone[idx] ?? 0;
        const b = tone[Math.min(idx + 1, tone.length - 1)] ?? 0;
        playBuf[i] = a + (b - a) * frac;
      }

      const preCount = recvSamples.length;
      setState({ isPlaying: true });
      await player.play(playBuf, outputRate, getState().selectedOutputId || undefined);
      setState({ isPlaying: false });
      await new Promise((r) => setTimeout(r, 50));

      const newSamples = recvSamples.slice(preCount);
      if (newSamples.length < 64) {
        matrix.push({ base, offset, minSnr: -999 });
        continue;
      }

      const tail = new Float32Array(newSamples.slice(-Math.min(384, newSamples.length)));

      const measureSnr = (freq: number): number => {
        let sSin = 0,
          sCos = 0;
        for (let i = 0; i < tail.length; i++) {
          const ph = (2 * Math.PI * freq * i) / modemRate;
          sSin += tail[i] * Math.sin(ph);
          sCos += tail[i] * Math.cos(ph);
        }
        const energy = Math.hypot(sSin, sCos) / tail.length;
        const nf = freq < freq2 ? freq - 25 : freq + 25;
        let nSin = 0,
          nCos = 0;
        for (let i = 0; i < tail.length; i++) {
          const ph = (2 * Math.PI * nf * i) / modemRate;
          nSin += tail[i] * Math.sin(ph);
          nCos += tail[i] * Math.cos(ph);
        }
        const noise = Math.hypot(nSin, nCos) / tail.length;
        return noise > 1e-12 ? 20 * Math.log10(energy / noise) : 999;
      };

      const snr1 = measureSnr(freq1);
      const snr2 = measureSnr(freq2);
      matrix.push({ base, offset, minSnr: Math.min(snr1, snr2) });
    }
  }

  console.warn('━━━ [FINE-SWEEP] Results (base × offset → min SNR) ━━━');
  const rows: Record<string, string | number>[] = [];
  for (const base of bases) {
    const row: Record<string, string | number> = { Base: `${base}Hz` };
    for (const offset of offsets) {
      const e = matrix.find((m) => m.base === base && m.offset === offset);
      if (e) {
        row[`+${offset}`] =
            e.minSnr > 15
              ? `✓${e.minSnr.toFixed(0)}`
              : e.minSnr > 5
                ? `${e.minSnr.toFixed(0)}`
                : `✗${e.minSnr.toFixed(0)}`;
      }
    }
    rows.push(row);
  }
  console.table(rows);

  const allGood = matrix.every((m) => m.minSnr > 15);
  const worst = matrix.reduce((a, b) => (b.minSnr < a.minSnr ? b : a), matrix[0]);
  console.warn(
    `[FINE-SWEEP] All pass (>15dB)? ${allGood ? '✅ YES — 100Hz spacing is robust' : '❌ NO — spacing needs adjustment'}`,
  );
  console.warn(
    `[FINE-SWEEP] Worst case: base=${worst.base}Hz +${worst.offset}Hz → ${worst.minSnr.toFixed(1)}dB`,
  );

  setState({
    sendStatus: {
      type: allGood ? 'success' : 'error',
      msg: allGood ? '✅ 100Hz verified robust' : '❌ Spacing fragile — check console',
    },
  });
}

window.addEventListener('eardrop-fine-sweep', (async () => {
  await runFineSweep();
}) as EventListener);
(window as any).runFineSweep = runFineSweep;

// ─── Combined Tone+Rate Sweep ─────────────────────────

/** Sweep tone counts × symbol rates in-memory to find optimal combo. */
async function runComboSweep() {
  console.warn('━━━ [COMBO] Tone count × symbol rate sweep ━━━');
  setState({ sendStatus: { type: 'info', msg: '⚡ Combo sweep…' } });

  const { Encoder } = await import('../modem/protocol/encoder');
  const { Decoder } = await import('../modem/protocol/decoder');
  const { encodeBlock, BLOCK_TYPE, getSentinel } = await import('../modem/protocol/framing');
  const { bch3116Encode } = await import('../modem/ecc/ecc');

  const payload = new TextEncoder().encode('Combo test payload!'); // 18 bytes
  const {sampleRate} = DEFAULT_CONFIG;

  // Tone counts to test
  const toneCounts = [2, 4, 8];
  // Valid rates (integer SPS only)
  const allRates = [10, 20, 25, 32, 40, 50, 64, 80, 100];
  const rates = allRates.filter((r) => sampleRate / r === Math.round(sampleRate / r));

  const total = toneCounts.length * rates.length;
  console.warn(
    `[COMBO] Testing ${toneCounts.length} tone counts × ${rates.length} rates = ${total} combos`,
  );

  const results: Array<{
      tones: number;
      rate: number;
      sps: number;
      durationMs: number;
      bitsPerSec: number;
      errors: number;
    }> = [];

  for (const tones of toneCounts) {
    for (const rate of rates) {
      const cfg = {
        ...DEFAULT_CONFIG,
        toneCount: tones,
        bitsPerFrame: tones * 2,
        symbolsPerSec: rate,
      };
      const SPS = Math.round(cfg.sampleRate / cfg.symbolsPerSec);

      const encoder = new Encoder(cfg);
      const decoder = new Decoder(cfg);
      decoder.fastSync = true;

      // Build CONFIG + PAYLOAD + EOF blocks
      const sentinel = getSentinel(tones);
      const configPayload = new TextEncoder().encode('combo.bin');
      const configData = new Uint8Array(2 + configPayload.length + 4 + 1);
      let o = 0;
      configData[o++] = configPayload.length & 0xff;
      configData[o++] = (configPayload.length >> 8) & 0xff;
      configData.set(configPayload, o);
      o += configPayload.length;
      configData[o++] = payload.length & 0xff;
      configData[o++] = (payload.length >> 8) & 0xff;
      configData[o++] = (payload.length >> 16) & 0xff;
      configData[o++] = (payload.length >> 24) & 0xff;
      configData[o++] = 0x00;
      const configForWire = bch3116Encode(configData);
      const payloadForWire = bch3116Encode(payload);
      const cb = encodeBlock(BLOCK_TYPE.CONFIG, configForWire, sentinel);
      const pb = encodeBlock(BLOCK_TYPE.PAYLOAD, payloadForWire, sentinel);
      const eb = encodeBlock(BLOCK_TYPE.EOF, new Uint8Array(0), sentinel);
      const allFramed = new Uint8Array(cb.bytes.length + pb.bytes.length + eb.bytes.length);
      allFramed.set(cb.bytes, 0);
      allFramed.set(pb.bytes, cb.bytes.length);
      allFramed.set(eb.bytes, cb.bytes.length + pb.bytes.length);

      const samples = encoder.encodeFramedBlocks(allFramed);

      const t0 = performance.now();
      let decoded: Uint8Array | null = null;
      decoder.onFrame = (data: Uint8Array) => {
        decoded = data;
      };
      for (const s of samples) decoder.feedSample(s);
      decoder.flush();
      const t1 = performance.now();

      const durationMs = t1 - t0;
      const bytesPerSec = (payload.length / durationMs) * 1000;
      const result = decoded as Uint8Array | null;
      let errors = payload.length;
      if (
        result &&
          result.length === payload.length &&
          payload.every((b, i) => result[i] === b)
      ) {
        errors = 0;
      }

      results.push({
        tones,
        rate,
        sps: SPS,
        durationMs: Math.round(durationMs),
        bitsPerSec: Math.round(bytesPerSec * 8),
        errors,
      });
    }
  }

  // Show as matrix: rows = tone counts, columns = rates
  console.warn('━━━ [COMBO] Results (tone count × symbol rate → bit/s, ✅=clean) ━━━');
  const matrix: Record<string, string | number>[] = [];
  for (const tones of toneCounts) {
    const row: Record<string, string | number> = { Tones: tones };
    for (const rate of rates) {
      const r = results.find((x) => x.tones === tones && x.rate === rate);
      if (r) {
        row[`${rate}s/s`] = r.errors === 0 ? `✅${r.bitsPerSec}` : '✗';
      }
    }
    matrix.push(row);
  }
  console.table(matrix);

  // Find best combo
  const passing = results.filter((r) => r.errors === 0);
  if (passing.length > 0) {
    const best = passing.reduce((a, b) => (b.bitsPerSec > a.bitsPerSec ? b : a));
    console.warn(
      `[COMBO] Best: ${best.tones} tones @ ${best.rate} sym/s → ${best.bitsPerSec} bit/s (${best.durationMs}ms, SPS=${best.sps})`,
    );
    setState({
      sendStatus: {
        type: 'success',
        msg: `⚡ Best: ${best.tones}t × ${best.rate}/s → ${best.bitsPerSec}bps`,
      },
    });
  } else {
    console.warn('[COMBO] No combo passed — all had errors');
    setState({ sendStatus: { type: 'error', msg: '❌ No combo passed' } });
  }
}

// ─── Acoustic Speed Sweep ────────────────────────────

/** Sweep symbol rates acoustically — sends a small file at each rate,
   *  measures transfer time and reports pass/fail. */
async function runAcousticSpeedSweep() {
  console.warn('━━━ [ACOUSTIC-SPEED] Acoustic transfer speed sweep ━━━');
  setState({ sendStatus: { type: 'info', msg: '🔊 Acoustic speed sweep…' } });
  await refreshDeviceList();
  if (!isListening) await startListening();
  await new Promise((r) => setTimeout(r, 300));

  const { TxEngine } = await import('../modem/protocol/txEngine');
  const outputRate = player.getSampleRate();
  player.volume = getState().playbackVolume;

  const payload = new TextEncoder().encode('speed test!'); // 11 bytes
  const {sampleRate} = DEFAULT_CONFIG;
  const allRates = [10, 20, 25, 32, 40, 50, 64];
  const rates = allRates.filter((r) => sampleRate / r === Math.round(sampleRate / r));

  const results: Array<{
      rate: number;
      sps: number;
      durationSec: number;
      framesFound: number;
      passed: boolean;
    }> = [];

  for (const rate of rates) {
    const cfg = { ...DEFAULT_CONFIG, symbolsPerSec: rate };
    const SPS = Math.round(sampleRate / rate);
    const tx = new TxEngine(cfg);
    const audio = tx.transmitFile('speed.bin', payload);

    // Count actual frame bytes transmitted
    const totalSamples = audio.length;
    const durationSec = totalSamples / sampleRate;

    // RxEngine is already running via modem worker — feed cycles naturally

    const preCount = recvSamples.length;
    setState({ isPlaying: true });
    await player.play(audio, sampleRate, getState().selectedOutputId || undefined);
    setState({ isPlaying: false });

    // Wait for receiver to process
    await new Promise((r) => setTimeout(r, Math.max(2000, durationSec * 1000 + 1500)));

    const newCount = recvSamples.length - preCount;
    console.warn(
      `[ACOUSTIC-SPEED] ${rate} sym/s (SPS=${SPS}): TX=${durationSec.toFixed(1)}s, RX samples=${newCount}`,
    );

    results.push({ rate, sps: SPS, durationSec, framesFound: 0, passed: false });

    // Brief gap between tests
    await new Promise((r) => setTimeout(r, 500));
  }

  console.warn('━━━ [ACOUSTIC-SPEED] Summary ━━━');
  console.table(
    results.map((r) => ({
      Rate: `${r.rate} sym/s`,
      SPS: r.sps,
      'TX time': `${r.durationSec.toFixed(1)}s`,
      'B/s': (payload.length / r.durationSec).toFixed(1),
    })),
  );

  setState({
    sendStatus: { type: 'success', msg: `✅ Sweep done — ${rates.length} rates tested` },
  });

  // Restart listening for normal use
  modem.stopListening();
  await new Promise((r) => setTimeout(r, 100));
  modem.configure(
    buildModemConfig({
      useOFDM: getState().useOFDM,
      pilotFreqHz: getState().pilotFreqHz,
      toneStartHz: getState().toneStartHz,
      toneCount: getState().toneCount,
      symbolsPerSec: getState().symbolsPerSec,
      musicalMode: getState().musicalMode,
      diversityMode: getState().diversityMode,
      hwSampleRate: audioCtx.sampleRate,
      bandHandshake: getState().bandHandshake,
        dataQamBits: getState().dataQamBits,
      qamScaleOverride: getState().qamScaleOverride,
      toneGains: currentToneGains(),
      trainingSettleSymbols: getState().trainingSettleSymbols,
    }),
  );
  const mic = await resolveMic();
  await modem.startListening(getState().micGain, mic.id, mic.label);
}

window.addEventListener('eardrop-acoustic-speed', (async () => {
  await runAcousticSpeedSweep();
}) as EventListener);

window.addEventListener('eardrop-combo-sweep', (async () => {
  await runComboSweep();
}) as EventListener);

// ─── Speed Benchmark Sweep ───────────────────────────

/** Sweep symbol rates in-memory, measure throughput and error rate. */
async function runSpeedSweep() {
  console.warn('━━━ [SPEED] In-memory speed benchmark ━━━');
  setState({ sendStatus: { type: 'info', msg: '⚡ Speed sweep…' } });

  const { Encoder } = await import('../modem/protocol/encoder');
  const { Decoder } = await import('../modem/protocol/decoder');
  const { encodeBlock, BLOCK_TYPE, getSentinel } = await import('../modem/protocol/framing');
  const { bch3116Encode } = await import('../modem/ecc/ecc');

  const payload = new TextEncoder().encode('Hello World! Bench'); // 17 bytes
  // Only test rates that produce integer SPS (sampleRate / rate must be integer)
  const {sampleRate} = DEFAULT_CONFIG;
  const allRates = [10, 20, 25, 32, 40, 50, 64, 80, 100, 128, 160, 200];
  const rates = allRates.filter((r) => sampleRate / r === Math.round(sampleRate / r));
  const results: Array<{
      rate: number;
      sps: number;
      durationMs: number;
      bytesPerSec: number;
      bitsPerSec: number;
      errors: number;
      passed: boolean;
    }> = [];

  for (const rate of rates) {
    const cfg = { ...DEFAULT_CONFIG, symbolsPerSec: rate };
    const SPS = Math.round(cfg.sampleRate / cfg.symbolsPerSec);

    const encoder = new Encoder(cfg);
    const decoder = new Decoder(cfg);
    decoder.fastSync = true;

    // Build framed blocks (CONFIG + PAYLOAD + EOF — matches runSelfTest pattern)
    const sentinel = getSentinel(cfg.toneCount);
    const configPayload = new TextEncoder().encode('speed-test.bin');
    const configData = new Uint8Array(2 + configPayload.length + 4 + 1);
    let o = 0;
    configData[o++] = configPayload.length & 0xff;
    configData[o++] = (configPayload.length >> 8) & 0xff;
    configData.set(configPayload, o);
    o += configPayload.length;
    configData[o++] = payload.length & 0xff;
    configData[o++] = (payload.length >> 8) & 0xff;
    configData[o++] = (payload.length >> 16) & 0xff;
    configData[o++] = (payload.length >> 24) & 0xff;
    configData[o++] = 0x00;
    const configForWire = bch3116Encode(configData);
    const payloadForWire = bch3116Encode(payload);
    const cb = encodeBlock(BLOCK_TYPE.CONFIG, configForWire, sentinel);
    const pb = encodeBlock(BLOCK_TYPE.PAYLOAD, payloadForWire, sentinel);
    const eb = encodeBlock(BLOCK_TYPE.EOF, new Uint8Array(0), sentinel);
    const allFramed = new Uint8Array(cb.bytes.length + pb.bytes.length + eb.bytes.length);
    allFramed.set(cb.bytes, 0);
    allFramed.set(pb.bytes, cb.bytes.length);
    allFramed.set(eb.bytes, cb.bytes.length + pb.bytes.length);

    const samples = encoder.encodeFramedBlocks(allFramed);

    const t0 = performance.now();
    let decoded: Uint8Array | null = null;
    decoder.onFrame = (data: Uint8Array) => {
      decoded = data;
    };
    for (const s of samples) decoder.feedSample(s);
    decoder.flush();
    const t1 = performance.now();

    const durationMs = t1 - t0;
    const bytesPerSec = (payload.length / durationMs) * 1000;
    const result = decoded as Uint8Array | null;
    let errors = payload.length;
    if (result && result.length === payload.length && payload.every((b, i) => result[i] === b)) {
      errors = 0;
    }
    const dataMatch = errors === 0;

    results.push({
      rate,
      sps: SPS,
      durationMs: Math.round(durationMs),
      bytesPerSec: Math.round(bytesPerSec * 10) / 10,
      bitsPerSec: Math.round(bytesPerSec * 8),
      errors,
      passed: !!dataMatch,
    });
  }

  console.warn('━━━ [SPEED] In-memory benchmark results ━━━');
  console.table(
    results.map((r) => ({
      'Sym/s': r.rate,
      SPS: r.sps,
      Time: `${r.durationMs}ms`,
      'B/s': r.bytesPerSec.toFixed(1),
      'bit/s': r.bitsPerSec,
      Errors: r.errors > 0 ? `❌${r.errors}` : '✅',
    })),
  );

  const best = results
    .filter((r) => r.passed)
    .reduce((a, b) => (b.bitsPerSec > a.bitsPerSec ? b : a), results[0]);
  console.warn(
    `[SPEED] Fastest clean: ${best.rate} sym/s → ${best.bitsPerSec} bit/s (${best.bytesPerSec.toFixed(1)} B/s)`,
  );

  setState({
    sendStatus: {
      type: 'success',
      msg: `⚡ Best: ${best.rate} sym/s → ${best.bitsPerSec} bit/s`,
    },
  });
}

window.addEventListener('eardrop-speed-sweep', (async () => {
  await runSpeedSweep();
}) as EventListener);

// Export selected file as WAV
window.addEventListener('eardrop-export-wav', (async () => {
  if (!selectedFile) {
    setState({ sendStatus: { type: 'error', msg: 'No file selected' } });
    return;
  }
  try {
    await refreshDeviceList();
    if (!isListening) await startListening();
    setState({ isSending: true, sendStatus: { type: 'info', msg: 'Encoding…' } });
    const raw = new Uint8Array(await selectedFile.arrayBuffer());
    const modemConfig = buildModemConfig({
      useOFDM: getState().useOFDM,
      pilotFreqHz: getState().pilotFreqHz,
      toneStartHz: getState().toneStartHz,
      toneCount: getState().toneCount,
      symbolsPerSec: getState().symbolsPerSec,
      musicalMode: getState().musicalMode,
      diversityMode: getState().diversityMode,
      hwSampleRate: audioCtx.sampleRate,
      bandHandshake: getState().bandHandshake,
        dataQamBits: getState().dataQamBits,
      qamScaleOverride: getState().qamScaleOverride,
      toneGains: currentToneGains(),
      trainingSettleSymbols: getState().trainingSettleSymbols,
    });
    modem.configure(modemConfig);
    const { samples: audioSamples, sampleRate: actualRate } = await modem.encodeFile(
      selectedFile.name,
      raw,
    );
    exportSamplesAsWav(
      audioSamples,
      actualRate,
      `${selectedFile.name.replace(/\.[^/.]+$/, '')  }.wav`,
    );
    setState({
      isSending: false,
      isPlaying: false,
      sendStatus: { type: 'success', msg: `Exported ${selectedFile.name} as WAV` },
    });
  } catch (err: any) {
    setState({ isSending: false, sendStatus: { type: 'error', msg: `❌ ${err.message}` } });
  }
}) as EventListener);

// Load WAV file and transmit its raw samples (bypass modulation)
window.addEventListener('eardrop-load-wav', (async () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.wav';
  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement | null)?.files?.[0];
    if (!file) return;
    try {
      setState({ sendStatus: { type: 'info', msg: 'Loading WAV…' } });
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      if (audioBuffer.numberOfChannels !== 1) {
        throw new Error('Only mono WAV files supported');
      }
      let samples: Float32Array = audioBuffer.getChannelData(0);
      // Resample WAV to the modem's expected sample rate so the decoder can process it.
      const wavRate = audioBuffer.sampleRate;
      const targetRate = getState().useOFDM ? audioCtx.sampleRate : DEFAULT_CONFIG.sampleRate;
      if (Math.abs(wavRate - targetRate) > 1) {
        samples = resample(samples, wavRate, targetRate);
      }
      // Feed the WAV samples through the receiver pipeline as if they came from the mic.
      // Configure the modem for receiving, start the Rx engine, then pump in the samples.
      setState({ recvStatus: { type: 'info', msg: 'Processing WAV through decoder…' } });
      modem.configure(buildModemConfig({
        useOFDM: getState().useOFDM,
        pilotFreqHz: getState().pilotFreqHz,
        toneStartHz: getState().toneStartHz,
        toneCount: getState().toneCount,
        symbolsPerSec: getState().symbolsPerSec,
        musicalMode: getState().musicalMode,
        diversityMode: getState().diversityMode,
        hwSampleRate: audioCtx.sampleRate,
        bandHandshake: getState().bandHandshake,
        dataQamBits: getState().dataQamBits,
      qamScaleOverride: getState().qamScaleOverride,
      toneGains: currentToneGains(),
      trainingSettleSymbols: getState().trainingSettleSymbols,
      }));
      // Poll for fileComplete
      const filePromise = new Promise<{ fileName: string; data: Uint8Array }>((resolve, reject) => {
        const unsub = modem.on('fileComplete', (ev) => {
          unsub();
          resolve({ fileName: ev.fileName, data: new Uint8Array(ev.data) });
        });
          // Timeout after 30 seconds
        setTimeout(() => { unsub(); reject(new Error('Timeout waiting for file decode')); }, 30000);
      });
        // Optionally play the audio out loud while decoding
      if (getState().playWavDuringDecode) {
        setState({ isPlaying: true });
        // Don't block on playback — let it run in parallel with decoding
        void player.play(samples, targetRate, getState().selectedOutputId || undefined, false);
      }
      // Start Rx engine and feed the audio
      modem.feedSamples(samples);
      const result = await filePromise;
      // Create a file download from the decoded data
      const blob = new Blob([result.data as BlobPart]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.fileName;
      a.click();
      URL.revokeObjectURL(url);
      // Stop playback if we started it for the WAV
      if (getState().playWavDuringDecode) {
        player.stopPlayback();
        setState({ isPlaying: false });
      }
      setState({ recvStatus: { type: 'success', msg: `Decoded: ${result.fileName}` } });
      // Stop the Rx engine to free resources
      modem.stopListening();
    } catch (err: any) {
      setState({ recvStatus: { type: 'error', msg: `❌ ${err.message}` } });
    }
  };
  input.click();
}) as EventListener);

// Expose self-test for event wiring
(window as any).runSelfTest = runSelfTest;

// ─── Init ─────────────────────────────────────────────

console.log('🦻 Eardrop controller ready');

// ─── Debug UI panel ───────────────────────────────────
(window as any).debugUI = async (anchor?: string) => {
  const { renderDebugPanel } = await import('../lib/debug');
  const el = anchor ? document.querySelector(anchor) : document.getElementById('debug-panel');
  if (el) {
    renderDebugPanel(el as HTMLElement);
  } else {
    // Create a floating panel
    const panel = document.createElement('div');
    panel.id = 'dbg-panel';
    panel.style.cssText = 'position:fixed;top:60px;right:12px;z-index:9999;';
    document.body.appendChild(panel);
    renderDebugPanel(panel);
  }
  console.log(
    '[DEBUG] Debug UI panel rendered. Use window.debug.status() to see current toggles.',
  );
};
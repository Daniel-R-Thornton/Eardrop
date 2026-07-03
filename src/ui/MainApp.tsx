/**
 * MainApp.tsx — Root React component for the Eardrop UI.
 * Lays out the main send/receive panel and debug dashboard.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore, getState, setState } from "./Store";
import { ToneMeter } from "./components/ToneMeter";
import { BlockLog } from "./components/BlockLog";

// ─── Tone Colors ──────────────────────────────────────

const TONE_COLORS = ["#4a9eff", "#ff6b4a", "#5eead4", "#f472b6"];
const TONE_FREQS = [500, 700, 900, 1100];

// ─── Helper Functions ─────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function hex(bytes: Uint8Array, max = 48): string {
  return Array.from(bytes.slice(0, max))
    .map(b => b.toString(16).padStart(2, "0"))
    .join(" ");
}

// ─── Sub-components ───────────────────────────────────

function StatusBadge({ type, msg }: { type: string; msg: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    info: { bg: "rgba(108,108,255,0.15)", color: "#6c6cff" },
    success: { bg: "rgba(68,204,136,0.15)", color: "#44cc88" },
    error: { bg: "rgba(255,68,102,0.15)", color: "#ff4466" },
  };
  const c = colors[type] || colors.info;
  return (
    <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6, fontSize: 13, background: c.bg, color: c.color }}>
      {msg}
    </div>
  );
}

function MiniMeter({ value, peak, color }: { value: number; peak: number; color: string }) {
  const pct = Math.min(100, (value / Math.max(peak, 1e-12)) * 100);
  return (
    <div style={{ flex: 1, height: 6, background: "#1a1a28", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 50ms linear" }} />
    </div>
  );
}

// ─── Decoder Dashboard ────────────────────────────────

function DecoderDashboard() {
  const debug = useStore(s => s.debug);
  const blockLog = useStore(s => s.blockLog);
  const toneEnergies = useStore(s => s.toneEnergies);

  if (!debug) {
    return (
      <div className="dashboard-panel">
        <div className="panel-title">📡 Decoder</div>
        <div style={{ padding: 16, color: "#666", fontSize: 13 }}>
          Listening for signal... (Ctrl+Shift+D to toggle debug view)
        </div>
      </div>
    );
  }

  const snrColor = debug.signalToNoise > 10 ? "#44cc88" : debug.signalToNoise > 3 ? "#eab308" : "#ef4444";
  const syncColor = debug.inFrame ? "#44cc88" : debug.consecutiveSync > 0 ? "#eab308" : "#666";

  return (
    <div className="dashboard-panel">
      <div className="panel-title">📡 Decoder</div>

      <div className="dashboard-grid">
        {/* Status row */}
        <div className="dash-stat">
          <span className="dash-label">Status</span>
          <span className="dash-value" style={{ color: syncColor }}>
            {debug.inFrame ? "DATA" : debug.noiseFrames < 25 ? "Noise Profiling" : "Listening"}
          </span>
        </div>
        <div className="dash-stat">
          <span className="dash-label">Pilot</span>
          <span className="dash-value">{debug.pilotFreq.toFixed(1)} Hz</span>
        </div>
        <div className="dash-stat">
          <span className="dash-label">SNR</span>
          <span className="dash-value" style={{ color: snrColor }}>{debug.signalToNoise.toFixed(1)} dB</span>
        </div>
        <div className="dash-stat">
          <span className="dash-label">Sync</span>
          <span className="dash-value">{debug.consecutiveSync}/{debug.noiseFrames}</span>
        </div>
        <div className="dash-stat">
          <span className="dash-label">Bits</span>
          <span className="dash-value">{debug.bitsCollected}</span>
        </div>
        <div className="dash-stat">
          <span className="dash-label">Blocks</span>
          <span className="dash-value">
            {debug.blocksDecoded} OK
            {debug.blocksCrcFailed > 0 && <span style={{ color: "#ef4444" }}> / {debug.blocksCrcFailed} FAIL</span>}
          </span>
        </div>
      </div>

      {/* Per-tone energy + phase */}
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>Tone Energies & Phase</div>
        {[0, 1, 2, 3].map(t => (
          <div key={t} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
            <span style={{ fontSize: 10, color: TONE_COLORS[t], minWidth: 55, textAlign: "right" }}>{TONE_FREQS[t]}Hz</span>
            <MiniMeter value={debug.energies[t]} peak={Math.max(...debug.energies, 0.1)} color={TONE_COLORS[t]} />
            <span style={{ fontSize: 9, color: "#888", minWidth: 80, fontFamily: "monospace" }}>
              I={debug.relI[t].toFixed(3)} Q={debug.relQ[t].toFixed(3)}
            </span>
            <span style={{ fontSize: 9, color: debug.relI[t] > 0 ? "#44cc88" : debug.relI[t] < 0 ? "#ff6b4a" : "#444" }}>
              {debug.relI[t] > 0 ? "▶" : debug.relI[t] < 0 ? "◀" : "○"} {debug.bitPattern?.toString(2).padStart(8, "0")?.charAt(7 - t * 2)} 
            </span>
          </div>
        ))}
      </div>

      {/* Noise floor */}
      <div style={{ marginTop: 8, fontSize: 10, color: "#555", fontFamily: "monospace" }}>
        Noise: {debug.noiseFloor.map(n => n.toExponential(1)).join(" | ")}
      </div>

      {/* Block log */}
      {blockLog.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>Recent Blocks</div>
          <BlockLog entries={blockLog} />
        </div>
      )}
    </div>
  );
}

// ─── Constellation Viewer ────────────────────────────

function ConstellationViewer() {
  const debug = useStore(s => s.debug);
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([null, null, null, null]);

  useEffect(() => {
    if (!debug) return;
    [0, 1, 2, 3].forEach(t => {
      const canvas = canvasRefs.current[t];
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;
      const maxDim = Math.min(w, h) / 2 - 15;

      ctx.fillStyle = "#070712";
      ctx.fillRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = "#1a1a2a";
      ctx.lineWidth = 0.5;
      for (let i = -2; i <= 2; i++) {
        const p = cx + i * maxDim / 3;
        ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(w, p); ctx.stroke();
      }

      // Crosshair
      ctx.strokeStyle = "#2a2a4a";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();

      // Label
      ctx.fillStyle = TONE_COLORS[t];
      ctx.font = "bold 11px monospace";
      ctx.fillText(`${TONE_FREQS[t]}Hz`, 4, 14);

      // Constellation point
      const iVal = debug.relI[t];
      const qVal = debug.relQ[t];
      const scale = maxDim / 0.15;

      const x = cx + iVal * scale;
      const y = cy - qVal * scale;

      if (x > 0 && x < w && y > 0 && y < h) {
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.fillStyle = TONE_COLORS[t];
        ctx.fill();
        ctx.strokeStyle = "#ffffff44";
        ctx.lineWidth = 0.5;
        ctx.stroke();

        // Trajectory line from center
        ctx.strokeStyle = TONE_COLORS[t] + "44";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }

      // Decision regions
      ctx.strokeStyle = "#ffffff08";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
      ctx.setLineDash([]);
    });
  }, [debug]);

  return (
    <div className="dashboard-panel">
      <div className="panel-title">🎯 Constellation</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, padding: 2 }}>
        {[0, 1, 2, 3].map(t => (
          <canvas
            key={t}
            ref={el => { canvasRefs.current[t] = el; }}
            width={160}
            height={120}
            style={{ width: "100%", aspectRatio: "4/3", borderRadius: 4, background: "#070712" }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Signal Viewer ────────────────────────────────────

function WaveformViewer() {
  const samples = useStore(s => s.debugSamples);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !samples) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = "#070712";
    ctx.fillRect(0, 0, w, h);

    const cy = h / 2;
    const len = Math.min(samples.length, 1024);
    const step = samples.length / len;

    ctx.strokeStyle = "#6c6cff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const x = (i / len) * w;
      const y = cy - samples[Math.floor(i * step)] * (h / 2 - 4);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = "#444";
    ctx.font = "9px monospace";
    ctx.fillText("Waveform", 4, 12);
  }, [samples]);

  return (
    <canvas
      ref={canvasRef}
      width={320}
      height={80}
      style={{ width: "100%", height: 80, borderRadius: 4, background: "#070712" }}
    />
  );
}

// ─── Tone Meter ───────────────────────────────────────

function LiveToneMeter() {
  const toneEnergies = useStore(s => s.toneEnergies);
  return <ToneMeter energies={toneEnergies} freqs={TONE_FREQS} colors={TONE_COLORS} />;
}

// ─── Main App ─────────────────────────────────────────

export function MainApp() {
  const sendStatus = useStore(s => s.sendStatus);
  const recvStatus = useStore(s => s.recvStatus);
  const selectedFile = useStore(s => s.selectedFile);
  const receivedFiles = useStore(s => s.receivedFiles);
  const isListening = useStore(s => s.isListening);
  const isSending = useStore(s => s.isSending);
  const progress = useStore(s => s.progress);
  const debugVisible = useStore(s => s.debugVisible);
  const debug = useStore(s => s.debug);
  const micLevel = useStore(s => s.micLevel);
  const txPayload = useStore(s => s.txPayload);
  const rxPayload = useStore(s => s.rxPayload);

  // Forward file selection to app.ts
  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setState({ selectedFile: { name: file.name, size: file.size } });
      // Dispatch custom event for app.ts to handle
      window.dispatchEvent(new CustomEvent("eardrop-file", { detail: { file } }));
    }
    e.target.value = "";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setState({ selectedFile: { name: file.name, size: file.size } });
      window.dispatchEvent(new CustomEvent("eardrop-file", { detail: { file } }));
    }
  }, []);

  const handleSend = useCallback(() => {
    window.dispatchEvent(new CustomEvent("eardrop-send"));
  }, []);

  const handleRecord = useCallback(() => {
    window.dispatchEvent(new CustomEvent("eardrop-record"));
  }, []);

  return (
    <div id="app-root">
      {/* Header */}
      <header className="app-header">
        <div className="header-content">
          <h1 className="app-title">Eardrop</h1>
          <p className="app-subtitle">File transfer over audio — no network needed</p>
        </div>
        <button
          className="debug-toggle-btn"
          onClick={() => {
            const v = !debugVisible;
            setState({ debugVisible: v });
            window.dispatchEvent(new CustomEvent("eardrop-toggle-debug", { detail: { visible: v } }));
          }}
          title="Toggle debug panel (Ctrl+Shift+D)"
        >
          {debugVisible ? "✕" : "🛠"}
        </button>
      </header>

      <div className="app-layout">
        {/* Left column: Send + Receive */}
        <div className="main-column">
          {/* Send */}
          <section className="card">
            <h2 className="card-title">📤 Send</h2>
            <div
              className="drop-zone"
              onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("drag-over"); }}
              onDragLeave={e => e.currentTarget.classList.remove("drag-over")}
              onDrop={handleDrop}
              onClick={() => document.getElementById("file-input")?.click()}
            >
              {selectedFile
                ? <span style={{ color: "#e0e0e8" }}>{selectedFile.name} ({formatSize(selectedFile.size)})</span>
                : <span style={{ color: "#888" }}>Drop a file or click to browse</span>
              }
              <input id="file-input" type="file" hidden onChange={handleFile} />
            </div>
            <button className="btn primary" disabled={!selectedFile || isSending} onClick={handleSend}>
              {isSending ? "⏳ Sending..." : "📡 Send as Audio"}
            </button>
            {sendStatus && <StatusBadge type={sendStatus.type} msg={sendStatus.msg} />}

            {/* TX Payload */}
            {txPayload && (
              <div className="payload-box">
                <div className="payload-label">📤 {txPayload.name}</div>
                <pre className="payload-pre">{txPayload.bytes}</pre>
              </div>
            )}
          </section>

          {/* Receive */}
          <section className="card">
            <h2 className="card-title">📥 Receive</h2>
            <p className="hint">Place speaker of sender near mic. Click record when transfer starts.</p>
            <button className={`btn ${isListening ? "danger" : "primary"}`} onClick={handleRecord}>
              {isListening ? "⏹ Stop" : "🎙 Start Listening"}
            </button>
            {recvStatus && <StatusBadge type={recvStatus.type} msg={recvStatus.msg} />}

            <div className="progress-section" style={{ display: progress > 0 ? "block" : "none" }}>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${Math.min(progress, 100)}%` }} />
              </div>
              <span className="progress-text">{progress}%</span>
            </div>

            {/* Downloads */}
            {receivedFiles.length > 0 && (
              <div className="downloads">
                <div className="downloads-header">📥 {receivedFiles.length} file(s) received</div>
                {receivedFiles.map((f, i) => (
                  <a key={i} href={f.url} download={f.name} className="download-link">
                    ⬇ {f.name} ({formatSize(f.size)})
                  </a>
                ))}
                <button className="btn-small" onClick={() => {
                  receivedFiles.forEach(f => URL.revokeObjectURL(f.url));
                  setState({ receivedFiles: [] });
                }}>🗑 Clear</button>
              </div>
            )}

            {/* RX Payload */}
            {rxPayload && (
              <div className="payload-box">
                <div className="payload-label">📥 {rxPayload.name}</div>
                <pre className="payload-pre">{rxPayload.bytes}</pre>
              </div>
            )}
          </section>
        </div>

        {/* Right column: Dashboard */}
        <div className="dashboard-column">
          {/* Mic Level */}
          <div className="dashboard-panel">
            <div className="panel-title">🎤 Mic Level</div>
            <div style={{ padding: "8px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <MiniMeter
                  value={Math.pow(10, micLevel / 20)}
                  peak={0.3}
                  color={micLevel > -30 ? "#44cc88" : micLevel > -50 ? "#eab308" : "#666"}
                />
                <span style={{ fontSize: 12, fontFamily: "monospace", color: micLevel > -30 ? "#44cc88" : "#888", minWidth: 50, textAlign: "right" }}>
                  {micLevel.toFixed(1)} dB
                </span>
              </div>
            </div>
            <LiveToneMeter />
          </div>

          {/* Waveform */}
          <WaveformViewer />

          {/* Constellation + Decoder in split */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <ConstellationViewer />
            <DecoderDashboard />
          </div>
        </div>
      </div>
    </div>
  );
}

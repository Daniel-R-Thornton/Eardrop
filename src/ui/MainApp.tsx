/**
 * MainApp.tsx — Full-featured Eardrop UI.
 * Includes send/receive, comprehensive debug dashboard, test buttons, device config.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore, setState } from "./Store";
import { ToneMeter } from "./components/ToneMeter";

const TONE_COLORS = ["#4a9eff", "#ff6b4a", "#5eead4", "#f472b6"];
const TONE_FREQS = [675, 875, 1075, 1275];

// ─── Helpers ──────────────────────────────────────────

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

function formatPayloadHex(bytes: Uint8Array, max = 96): string {
  const slice = bytes.slice(0, max);
  const lines: string[] = [];
  for (let i = 0; i < slice.length; i += 16) {
    const h = Array.from(slice.slice(i, i + 16)).map(b => b.toString(16).padStart(2, "0")).join(" ");
    const a = Array.from(slice.slice(i, i + 16)).map(b => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${h.padEnd(48)}  ${a}`);
  }
  if (bytes.length > max) lines.push(`… ${bytes.length - max} more bytes`);
  return lines.join("\n");
}

// ─── Status Badge ─────────────────────────────────────

function StatusBadge({ type, msg }: { type: string; msg: string }) {
  const c: Record<string, { bg: string; fg: string }> = {
    info: { bg: "rgba(108,108,255,0.15)", fg: "#6c6cff" },
    success: { bg: "rgba(68,204,136,0.15)", fg: "#44cc88" },
    error: { bg: "rgba(255,68,102,0.15)", fg: "#ff4466" },
  };
  const s = c[type] || c.info;
  return <div style={{ marginTop: 6, padding: "5px 10px", borderRadius: 6, fontSize: 12, background: s.bg, color: s.fg }}>{msg}</div>;
}

// ─── Meter Bar ────────────────────────────────────────

function MeterBar({ val, peak, color, label, decimals = 1 }: { val: number; peak: number; color: string; label: string; decimals?: number }) {
  const pct = Math.min(100, (val / Math.max(peak || 1e-12, 1e-12)) * 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
      <span style={{ fontSize: 10, color: "#888", minWidth: 70, textAlign: "right", flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 8, background: "#12121e", borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: "width 40ms linear" }} />
      </div>
      <span style={{ fontSize: 10, fontFamily: "monospace", color, minWidth: 55, textAlign: "right", flexShrink: 0 }}>{val.toFixed(decimals)}</span>
    </div>
  );
}

// ─── Section Wrapper ──────────────────────────────────

function Section({ title, children, color = "#6c6cff" }: { title: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ background: "#11111e", border: "1px solid #1e1e3a", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "6px 12px", background: "#16162a", borderBottom: "1px solid #1e1e3a", fontWeight: 600, fontSize: 13, color }}>{title}</div>
      <div style={{ padding: 10 }}>{children}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════

export function MainApp() {
  const s = useStore(x => x); // full state

  // Refresh device pickers after React mounts the DOM
  useEffect(() => {
    (window as any).eardropRefreshDevices?.();
  }, []);

  // ── Event dispatchers to app.ts ──

  const dispatch = (type: string, detail?: any) => window.dispatchEvent(new CustomEvent(type, { detail }));

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setState({ selectedFile: { name: f.name, size: f.size } }); dispatch("eardrop-file", { file: f }); }
    e.target.value = "";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) { setState({ selectedFile: { name: f.name, size: f.size } }); dispatch("eardrop-file", { file: f }); }
  }, []);

  // ── Debug ──

  const debug = s.debug;
  const snrColor = !debug ? "#666" : debug.signalToNoise > 10 ? "#44cc88" : debug.signalToNoise > 3 ? "#eab308" : "#ef4444";

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "16px 12px", fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif", color: "#e0e0ee", background: "#0a0a12", minHeight: "100vh" }}>

      {/* ═══ HEADER ═══ */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0, background: "linear-gradient(135deg,#6c6cff,#a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>Eardrop</h1>
          <p style={{ color: "#7878a0", fontSize: 13, marginTop: 2 }}>File transfer over audio — speaker to mic</p>
        </div>
        <button onClick={() => { const v = !s.debugVisible; setState({ debugVisible: v }); dispatch("eardrop-toggle-debug", { visible: v }); }}
          style={{ width: 36, height: 36, borderRadius: "50%", border: "1px solid #2a2a4e", background: "#11111e", color: "#7878a0", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          title="Toggle debug (Ctrl+Shift+D)">{s.debugVisible ? "✕" : "🛠"}</button>
      </div>

      {/* ═══ TWO-COLUMN LAYOUT ═══ */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 12, alignItems: "start" }}>

        {/* ═══ LEFT COLUMN ═══ */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* ── SEND ── */}
          <Section title="📤 Send">
            <div onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = "#6c6cff"; }}
              onDragLeave={e => e.currentTarget.style.borderColor = "#2a2a4e"}
              onDrop={handleDrop}
              onClick={() => document.getElementById("fi")?.click()}
              style={{ border: "2px dashed #2a2a4e", borderRadius: 6, padding: "14px 10px", textAlign: "center", cursor: "pointer", fontSize: 13, color: s.selectedFile ? "#e0e0ee" : "#7878a0", transition: "border-color .2s" }}>
              {s.selectedFile ? `${s.selectedFile.name} (${formatSize(s.selectedFile.size)})` : "Drop a file or click to browse"}
              <input id="fi" type="file" hidden onChange={handleFile} />
            </div>
            <button disabled={!s.selectedFile || s.isSending} onClick={() => dispatch("eardrop-send")}
              style={{ width: "100%", marginTop: 8, padding: "8px 16px", border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer", background: s.selectedFile ? "#6c6cff" : "#1e1e3a", color: s.selectedFile ? "#fff" : "#555" }}>
              {s.isSending ? "⏳ Sending…" : "📡 Send as Audio"}
            </button>
            {s.sendStatus && <StatusBadge {...s.sendStatus} />}
            {/* Self-test + Send Test buttons */}
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button onClick={() => dispatch("eardrop-self-test")} style={{ flex: 1, padding: "5px 8px", border: "1px solid #1e1e3a", borderRadius: 5, background: "#16162a", color: "#7878a0", cursor: "pointer", fontSize: 11 }}>🧪 Self-Test</button>
              <button onClick={() => dispatch("eardrop-send-test")} style={{ flex: 1, padding: "5px 8px", border: "1px solid #1e1e3a", borderRadius: 5, background: "#16162a", color: "#7878a0", cursor: "pointer", fontSize: 11 }}>📤 Send Test</button>
            </div>
            {/* TX Payload */}
            {s.txPayload && (
              <div style={{ marginTop: 8, background: "#07070e", borderRadius: 5, border: "1px solid #1e1e3a", overflow: "hidden" }}>
                <div style={{ fontSize: 10, color: "#5858a0", padding: "2px 6px", background: "#11111e", borderBottom: "1px solid #1e1e3a" }}>📤 TX: {s.txPayload.name}</div>
                <pre style={{ margin: 0, padding: "4px 6px", fontSize: 10, color: "#5858a0", whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "monospace", maxHeight: 60, overflow: "auto", lineHeight: 1.3 }}>{s.txPayload.bytes}</pre>
              </div>
            )}
          </Section>

          {/* ── RECEIVE ── */}
          <Section title="📥 Receive">
            <p style={{ color: "#7878a0", fontSize: 12, marginBottom: 8 }}>Place sender speaker near mic.</p>
            <button onClick={() => dispatch("eardrop-record")}
              style={{ width: "100%", padding: "8px 16px", border: "none", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: "pointer", background: s.isListening ? "#ff4466" : "#6c6cff", color: "#fff" }}>
              {s.isListening ? "⏹ Stop Listening" : "🎙 Start Listening"}
            </button>
            {s.recvStatus && <StatusBadge {...s.recvStatus} />}
            {s.progress > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ height: 4, background: "#1e1e3a", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(s.progress, 100)}%`, height: "100%", background: "#6c6cff", borderRadius: 2, transition: "width .3s" }} />
                </div>
                <span style={{ fontSize: 11, color: "#7878a0", marginTop: 2 }}>{s.progress}%</span>
              </div>
            )}
            {/* Downloads */}
            {s.receivedFiles.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ fontSize: 12, color: "#7878a0" }}>📥 {s.receivedFiles.length} file(s)</div>
                {s.receivedFiles.map((f, i) => (
                  <a key={i} href={f.url} download={f.name} style={{ padding: "4px 10px", background: "#44cc88", color: "#000", borderRadius: 5, textDecoration: "none", fontWeight: 600, fontSize: 12 }}>⬇ {f.name} ({formatSize(f.size)})</a>
                ))}
                <button onClick={() => { s.receivedFiles.forEach(f => URL.revokeObjectURL(f.url)); setState({ receivedFiles: [] }); }}
                  style={{ alignSelf: "flex-start", padding: "2px 8px", border: "1px solid #1e1e3a", borderRadius: 4, background: "#16162a", color: "#7878a0", cursor: "pointer", fontSize: 10 }}>🗑 Clear</button>
              </div>
            )}
            {/* RX Payload */}
            {s.rxPayload && (
              <div style={{ marginTop: 8, background: "#07070e", borderRadius: 5, border: "1px solid #1e1e3a", overflow: "hidden" }}>
                <div style={{ fontSize: 10, color: "#44cc88", padding: "2px 6px", background: "#11111e", borderBottom: "1px solid #1e1e3a" }}>📥 RX: {s.rxPayload.name}</div>
                <pre style={{ margin: 0, padding: "4px 6px", fontSize: 10, color: "#44cc88", whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "monospace", maxHeight: 60, overflow: "auto", lineHeight: 1.3 }}>{s.rxPayload.bytes}</pre>
              </div>
            )}
          </Section>

          {/* ── MODEM CONFIG ── */}
          <Section title="⚙️ Modem Config" color="#eab308">
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                <label style={{ fontSize: 10, color: "#5858a0" }}>Pilot Frequency</label>
                <span style={{ fontSize: 11, fontFamily: "monospace", color: "#eab308" }}>{s.pilotFreqHz.toFixed(1)} Hz</span>
              </div>
              <input type="range" min="25" max="400" step="12.5" value={s.pilotFreqHz}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  setState({ pilotFreqHz: v });
                  window.dispatchEvent(new CustomEvent("eardrop-pilot-freq", { detail: { freq: v } }));
                }}
                style={{ width: "100%", accentColor: "#eab308" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#484870" }}>
                <span>25 Hz</span>
                <span>200 Hz</span>
                <span>400 Hz</span>
              </div>
              <div style={{ marginTop: 4, fontSize: 9, color: "#5858a0" }}>
                Tones: {[437.5,637.5,837.5,1037.5].map(o => (s.pilotFreqHz + o).toFixed(0)).join(", ")} Hz
              </div>
            </div>
          </Section>

          {/* ── DEVICES ── */}
          <Section title="🎛 Audio Devices" color="#7878a0">
            <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                <label style={{ fontSize: 10, color: "#5858a0" }}>Input (mic)</label>
                <select id="inputSelect" style={{ background: "#0a0a12", color: "#e0e0ee", border: "1px solid #1e1e3a", borderRadius: 4, padding: "3px 4px", fontSize: 11 }}>
                  <option value="">Default</option>
                </select>
              </div>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                <label style={{ fontSize: 10, color: "#5858a0" }}>Output (speaker)</label>
                <select id="outputSelect" style={{ background: "#0a0a12", color: "#e0e0ee", border: "1px solid #1e1e3a", borderRadius: 4, padding: "3px 4px", fontSize: 11 }}>
                  <option value="">Default</option>
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button id="refreshDevices" style={{ padding: "3px 10px", border: "1px solid #1e1e3a", borderRadius: 4, background: "#16162a", color: "#7878a0", cursor: "pointer", fontSize: 10 }}>🔄 Refresh</button>
              <label style={{ fontSize: 10, color: "#5858a0", display: "flex", alignItems: "center", gap: 4 }}>
                <input type="checkbox" id="fastSyncCb" defaultChecked /> Fast Sync
              </label>
            </div>
          </Section>
        </div>

        {/* ═══ RIGHT COLUMN ═══ */}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* ── MIC LEVEL + TONE ENERGY ── */}
          <Section title="🎤 Mic & Tones">
            <MeterBar val={s.micLevel} peak={0} color={s.micLevel > -30 ? "#44cc88" : s.micLevel > -50 ? "#eab308" : "#666"} label="Level" decimals={1} />
            <div style={{ marginTop: 4 }}>
              <span style={{ fontSize: 10, color: "#5858a0" }}>Tone Energy</span>
              <ToneMeter energies={s.toneEnergies} freqs={TONE_FREQS} colors={TONE_COLORS} />
            </div>
          </Section>

          {/* ── DECODER STATE ── */}
          <Section title="📡 Decoder State">
            {!debug ? (
              <div style={{ padding: "8px 0", color: "#5858a0", fontSize: 12 }}>Listening for signal…</div>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1px", background: "#1e1e3a", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
                  {[
                    ["Status", debug.inFrame ? "DATA" : debug.noiseFrames < 25 ? "Profiling" : "Listening", debug.inFrame ? "#44cc88" : "#eab308"],
                    ["Sync", `${debug.consecutiveSync}`, "#6c6cff"],
                    ["SNR", `${debug.signalToNoise.toFixed(1)} dB`, snrColor],
                    ["Pilot", `${debug.pilotFreq.toFixed(1)} Hz`, "#6c6cff"],
                    ["Bits", `${debug.bitsCollected}`, "#e0e0ee"],
                    ["Blocks", `${debug.blocksDecoded} OK${debug.blocksCrcFailed > 0 ? ` / ${debug.blocksCrcFailed} FAIL` : ""}`, debug.blocksCrcFailed > 0 ? "#ef4444" : "#44cc88"],
                  ].map(([l, v, c], i) => (
                    <div key={i} style={{ background: "#11111e", padding: "5px 6px", display: "flex", flexDirection: "column", gap: 1 }}>
                      <span style={{ fontSize: 9, color: "#5858a0", textTransform: "uppercase", letterSpacing: "0.04em" }}>{l}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, fontFamily: "monospace", color: c }}>{v}</span>
                    </div>
                  ))}
                </div>

                {/* Per-tone */}
                <div style={{ fontSize: 10, color: "#5858a0", marginBottom: 4 }}>Tones</div>
                {[0, 1, 2, 3].map(t => (
                  <div key={t} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 1, fontSize: 10, fontFamily: "monospace" }}>
                    <span style={{ color: TONE_COLORS[t], minWidth: 50, textAlign: "right" }}>{TONE_FREQS[t]}Hz</span>
                    <div style={{ flex: 1, height: 5, background: "#12121e", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${Math.min(100, (debug.energies[t] / Math.max(...debug.energies, 0.1)) * 100)}%`, height: "100%", background: TONE_COLORS[t], borderRadius: 2, transition: "width 40ms linear" }} />
                    </div>
                    <span style={{ color: "#7878a0", minWidth: 70 }}>I={debug.relI[t].toFixed(2)}</span>
                    <span style={{ color: debug.relI[t] > 0 ? "#44cc88" : debug.relI[t] < 0 ? "#ff6b4a" : "#444" }}>
                      {debug.relI[t] > 0 ? "▶" : debug.relI[t] < 0 ? "◀" : "○"}
                    </span>
                  </div>
                ))}

                {/* Noise floor */}
                <div style={{ marginTop: 6, fontSize: 9, color: "#484870", fontFamily: "monospace" }}>
                  Noise: {debug.noiseFloor.map(n => n.toExponential(1)).join(" | ")}
                </div>
              </>
            )}
          </Section>

          {/* ── CONSTELLATION ── */}
          <Section title="🎯 Constellation (I/Q)" color="#a78bfa">
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
              {[0, 1, 2, 3].map(t => (
                <ConstellationCanvas key={t} tone={t} iVal={debug?.relI[t] ?? 0} qVal={debug?.relQ[t] ?? 0} color={TONE_COLORS[t]} label={`${TONE_FREQS[t]}Hz`} />
              ))}
            </div>
          </Section>

          {/* ── WAVEFORM ── */}
          <Section title="〰 Waveform" color="#6c6cff">
            <WaveformCanvas samples={s.debugSamples} />
          </Section>

          {/* ── BLOCK LOG + DECODER TEXT LOG ── */}
          <Section title="📋 Activity Log" color="#7878a0">
            <div style={{ maxHeight: 120, overflow: "auto", fontSize: 10, fontFamily: "monospace", lineHeight: 1.5 }}>
              {s.blockLog.length === 0 ? (
                <span style={{ color: "#484870" }}>No blocks decoded yet.</span>
              ) : (
                s.blockLog.slice(-12).map((e, i) => (
                  <div key={i} style={{ display: "flex", gap: 8 }}>
                    <span style={{ color: e.type === "SQUAWK" ? "#5eead4" : e.type === "CONFIG" ? "#4a9eff" : e.type === "PAYLOAD" ? "#eab308" : e.type === "EOF" ? "#44cc88" : "#888" }}>
                      {e.type.padEnd(10)}
                    </span>
                    <span style={{ color: "#7878a0" }}>{e.len}B</span>
                  </div>
                ))
              )}
            </div>
            {/* Raw decoder log */}
            {debug && (
              <div style={{ marginTop: 6, padding: "4px 6px", background: "#07070e", borderRadius: 4, border: "1px solid #1e1e3a", maxHeight: 50, overflow: "auto", fontSize: 9, color: "#484870", fontFamily: "monospace", lineHeight: 1.4, whiteSpace: "pre-wrap" }}>
                {`pilot=${debug.pilotFreq.toFixed(1)}Hz amp=${debug.pilotAmplitude.toExponential(2)} snr=${debug.signalToNoise.toFixed(1)}dB bits=${debug.bitsCollected}`}
                {debug.energies && `\neng=[${debug.energies.map((e: number) => e.toExponential(2)).join(",")}]`}
              </div>
            )}
          </Section>

          {/* ── SELF-TEST RESULT ── */}
          <Section title="🧪 Diagnostics" color="#eab308">
            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
              <button onClick={() => dispatch("eardrop-self-test")} style={{ flex: 1, padding: "6px 10px", border: "1px solid #2a2a4e", borderRadius: 5, background: "#16162a", color: "#e0e0ee", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>🧪 Loopback Self-Test</button>
              <button onClick={() => dispatch("eardrop-send-test")} style={{ flex: 1, padding: "6px 10px", border: "1px solid #2a2a4e", borderRadius: 5, background: "#16162a", color: "#e0e0ee", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>📤 Send Test (hello.txt)</button>
            </div>
            <div id="selfTestResult" style={{ fontSize: 10, color: "#7878a0", fontFamily: "monospace", minHeight: 14 }} />
          </Section>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// CANVAS COMPONENTS
// ═══════════════════════════════════════════════════════

function ConstellationCanvas({ tone, iVal, qVal, color, label }: { tone: number; iVal: number; qVal: number; color: string; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width, h = c.height, cx = w / 2, cy = h / 2, s = Math.min(w, h) / 2 - 16, scale = s / 0.15;
    ctx.fillStyle = "#07070e";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#16162a";
    ctx.lineWidth = 0.5;
    for (let i = -2; i <= 2; i++) { const p = cx + i * s / 3; ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(w, p); ctx.stroke(); }
    ctx.strokeStyle = "#2a2a4a";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = "bold 10px monospace";
    ctx.fillText(label, 4, 12);
    const x = cx + iVal * scale, y = cy - qVal * scale;
    if (x > 0 && x < w && y > 0 && y < h) {
      ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = "#ffffff33"; ctx.lineWidth = 0.5; ctx.stroke();
      ctx.strokeStyle = color + "33"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.strokeStyle = "#ffffff08"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke(); ctx.setLineDash([]);
  }, [iVal, qVal, color, label]);
  return <canvas ref={ref} width={150} height={110} style={{ width: "100%", aspectRatio: "150/110", borderRadius: 4, background: "#07070e" }} />;
}

function WaveformCanvas({ samples }: { samples: Float32Array | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !samples) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width, h = c.height, cy = h / 2, len = Math.min(samples.length, 1024), step = samples.length / len;
    ctx.fillStyle = "#07070e";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#6c6cff";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let i = 0; i < len; i++) { const x = (i / len) * w, y = cy - samples[Math.floor(i * step)] * (h / 2 - 4); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke();
    ctx.fillStyle = "#484870";
    ctx.font = "9px monospace";
    ctx.fillText("Waveform", 4, 11);
  }, [samples]);
  return <canvas ref={ref} width={400} height={70} style={{ width: "100%", height: 70, borderRadius: 4, background: "#07070e" }} />;
}

/**
 * MainApp.tsx — Eardrop UI with comprehensive debug dashboard.
 * Apple-inspired design: clean cards, tight typography, visible debug.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useStore, setState } from "./Store";
import { ToneMeter } from "./components/ToneMeter";
import { BitAnalyzer } from "./components/BitAnalyzer";
import { WaveformScope } from "./components/WaveformScope";
import { SpectrumAnalyzer } from "./components/SpectrumAnalyzer";
import { ModemScope } from "./components/ModemScope";
import { debugLogger, STAGE } from "../modem/debugger";

const TONE_COLORS = ["#4a9eff", "#ff6b4a", "#5eead4", "#f472b6"];
const TONE_FREQS = [850, 1050, 1250, 1450];
const GAP = 12;

// ─── Helpers ──────────────────────────────────────────

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

function StatusBadge({ type, msg }: { type: string; msg: string }) {
  const c: Record<string, { bg: string; fg: string }> = {
    info: { bg: "rgba(108,108,255,0.15)", fg: "#6c6cff" },
    success: { bg: "rgba(52,211,153,0.15)", fg: "#34d399" },
    error: { bg: "rgba(248,113,113,0.15)", fg: "#f87171" },
  };
  const s = c[type] || c.info;
  return (
    <div style={{ marginTop: 6, padding: "6px 12px", borderRadius: 8, fontSize: 13, background: s.bg, color: s.fg, fontWeight: 500 }}>
      {msg}
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────

function Card({ title, accent = "#6c6cff", children, style }: {
  title?: string; accent?: string; children: React.ReactNode; style?: React.CSSProperties
}) {
  return (
    <div style={{
      background: "#0d0d1a", borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.06)",
      overflow: "hidden",
      ...style,
    }}>
      {title && (
        <div style={{
          padding: "10px 16px", fontSize: 13, fontWeight: 600,
          color: accent, borderBottom: "1px solid rgba(255,255,255,0.05)",
          textTransform: "uppercase", letterSpacing: "0.05em",
        }}>{title}</div>
      )}
      <div style={{ padding: title ? "14px 16px" : "16px" }}>{children}</div>
    </div>
  );
}

// ─── Stat Grid Item ───────────────────────────────────

function Stat({ label, value, color = "#e0e0ee" }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 600, fontFamily: "SF Mono, ui-monospace, monospace", color }}>{value}</span>
    </div>
  );
}

// ─── Meter Bar ────────────────────────────────────────

function MeterBar({ val, peak, color, label }: { val: number; peak: number; color: string; label: string }) {
  const pct = Math.min(100, Math.max(0, (val / Math.max(peak || 1e-12, 1e-6)) * 100));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
      <span style={{ fontSize: 11, color: "#6b7280", minWidth: 55, textAlign: "right" }}>{label}</span>
      <div style={{ flex: 1, height: 6, background: "rgba(255,255,255,0.04)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, transition: "width 80ms linear" }} />
      </div>
      <span style={{ fontSize: 11, fontFamily: "SF Mono, ui-monospace, monospace", color, minWidth: 50, textAlign: "right" }}>{val.toFixed(1)}</span>
    </div>
  );
}

// ─── Constellation Dot ────────────────────────────────

function ConstellationCanvas({ tone, iVal, qVal, color, label }: {
  tone: number; iVal: number; qVal: number; color: string; label: string
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const history = useRef<Array<{x:number;y:number}>>([]);
  const size = 80;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const w = c.width, h = c.height;
    const cx = w / 2, cy = h / 2;
    // Scale to show range ±0.5 with some headroom
    const scale = (w / 2) / 0.6;

    // Don't clear entirely — leave a fading trail
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.fillRect(0, 0, w, h);

    // Axes
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    // Unit circle
    ctx.beginPath(); ctx.arc(cx, cy, 0.5 * scale, 0, Math.PI * 2); ctx.stroke();

    // Add to history
    const x = cx + iVal * scale;
    const y = cy - qVal * scale;
    history.current.push({ x, y });
    if (history.current.length > 60) history.current.shift();

    // Draw trail
    if (history.current.length > 1) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < history.current.length; i++) {
        const p = history.current[i];
        i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Current dot
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.stroke();
  }, [iVal, qVal, color]);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <canvas ref={ref} width={size} height={size} style={{ borderRadius: 6, background: "rgba(0,0,0,0.4)" }} />
      <span style={{ fontSize: 9, color, fontFamily: "SF Mono, ui-monospace, monospace" }}>
        {label} I={iVal.toFixed(3)} Q={qVal.toFixed(3)}
      </span>
    </div>
  );
}

// ─── Waveform — now handled by WaveformScope component ──

// ═══════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════

export function MainApp() {
  const s = useStore(x => x);
  const debug = s.debug;

  useEffect(() => {
    (window as any).eardropRefreshDevices?.();
  }, []);

  const dispatch = (type: string, detail?: any) =>
    window.dispatchEvent(new CustomEvent(type, { detail }));

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

  const snrColor = !debug ? "#6b7280" : debug.signalToNoise > 10 ? "#34d399" : debug.signalToNoise > 3 ? "#f59e0b" : "#f87171";

  return (
    <div style={{
      maxWidth: 1100, margin: "0 auto", padding: "20px 16px",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif",
      color: "#e5e7eb", background: "#05050f", minHeight: "100vh",
    }}>

      {/* ═══ HEADER ═══ */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <h1 style={{
            fontSize: 32, fontWeight: 700, margin: 0, letterSpacing: "-0.03em",
            background: "linear-gradient(135deg, #818cf8, #c084fc)", WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
          }}>Eardrop</h1>
          <p style={{ color: "#6b7280", fontSize: 14, marginTop: 2 }}>File transfer over audio · speaker → mic</p>
        </div>
      </div>

      {/* ═══ TWO-COLUMN LAYOUT ═══ */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: GAP, alignItems: "start" }}>

        {/* ── LEFT: Send, Receive, Config ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: GAP }}>

          {/* Send */}
          <Card title="Send" accent="#818cf8">
            <div
              onDragOver={e => { e.preventDefault(); e.currentTarget.style.borderColor = "#818cf8"; }}
              onDragLeave={e => e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"}
              onDrop={handleDrop}
              onClick={() => document.getElementById("fi")?.click()}
              style={{
                border: "2px dashed rgba(255,255,255,0.1)", borderRadius: 8,
                padding: "16px", textAlign: "center", cursor: "pointer",
                fontSize: 14, color: s.selectedFile ? "#e5e7eb" : "#6b7280",
                transition: "border-color .2s",
              }}>
              {s.selectedFile ? `${s.selectedFile.name} (${formatSize(s.selectedFile.size)})` : "Drop a file or click to browse"}
              <input id="fi" type="file" hidden onChange={handleFile} />
            </div>
            <button
              disabled={!s.selectedFile || s.isSending}
              onClick={() => dispatch("eardrop-send")}
              style={{
                width: "100%", marginTop: 10, padding: "10px 0", border: "none", borderRadius: 8,
                fontSize: 15, fontWeight: 600, cursor: "pointer",
                background: s.selectedFile ? "#818cf8" : "rgba(255,255,255,0.06)",
                color: s.selectedFile ? "#fff" : "#4b5563",
                transition: "all .15s",
              }}>
              {s.isSending ? "Sending…" : "Send as Audio"}
            </button>
            {s.isPlaying && (
              <button onClick={() => dispatch("eardrop-stop-playback")}
                style={{ width: "100%", marginTop: 6, padding: "8px 0", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "#f87171", color: "#fff" }}>
                Stop Playback
              </button>
            )}
            {s.sendStatus && <StatusBadge {...s.sendStatus} />}
          </Card>

          {/* Receive */}
          <Card title="Receive" accent="#34d399">
            <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 10 }}>Place sender speaker near mic.</p>
            <button onClick={() => dispatch("eardrop-record")}
              style={{
                width: "100%", padding: "10px 0", border: "none", borderRadius: 8,
                fontSize: 15, fontWeight: 600, cursor: "pointer",
                background: s.isListening ? "#f87171" : "#34d399",
                color: "#fff", transition: "all .15s",
              }}>
              {s.isListening ? "Stop Listening" : "Start Listening"}
            </button>
            {s.recvStatus && <StatusBadge {...s.recvStatus} />}
            {s.progress > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${Math.min(s.progress, 100)}%`, height: "100%", background: "#34d399", borderRadius: 2, transition: "width .3s" }} />
                </div>
                <span style={{ fontSize: 12, color: "#6b7280", marginTop: 3, display: "block" }}>{s.progress}%</span>
              </div>
            )}
            {s.receivedFiles.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                {s.receivedFiles.map((f, i) => (
                  <a key={i} href={f.url} download={f.name}
                    style={{ padding: "6px 12px", background: "#34d399", color: "#000", borderRadius: 6, textDecoration: "none", fontWeight: 600, fontSize: 13 }}>
                    {f.name} ({formatSize(f.size)})
                  </a>
                ))}
              </div>
            )}
          </Card>

          {/* Config */}
          <Card title="Config" accent="#f59e0b">
            {/* Tone Count */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: "#6b7280" }}>Active Tones</span>
              <select value={s.toneCount} onChange={e => setState({ toneCount: parseInt(e.target.value) })}
                style={{ background: "rgba(255,255,255,0.04)", color: "#e5e7eb", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, padding: "3px 8px", fontSize: 12 }}>
                <option value={2}>2 tones</option>
                <option value={4}>4 tones</option>
              </select>
            </div>

            {/* Symbol Rate */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: "#6b7280" }}>Symbol Rate</span>
              <select value={s.symbolsPerSec} onChange={e => setState({ symbolsPerSec: parseInt(e.target.value) })}
                style={{ background: "rgba(255,255,255,0.04)", color: "#e5e7eb", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, padding: "3px 8px", fontSize: 12 }}>
                <option value={10}>10 sym/s</option>
                <option value={25}>25 sym/s</option>
                <option value={50}>50 sym/s</option>
              </select>
            </div>
            <div style={{ fontSize: 10, color: "#4b5563", marginTop: -4, marginBottom: 8 }}>
              {s.symbolsPerSec * s.toneCount} bit/s
            </div>

            {/* Pilot Freq */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 12, color: "#6b7280" }}>Pilot Freq</span>
                <span style={{ fontSize: 12, fontFamily: "SF Mono, ui-monospace, monospace", color: "#f59e0b" }}>{s.pilotFreqHz.toFixed(1)} Hz</span>
              </div>
              <input type="range" min="37.5" max="537.5" step="25" value={s.pilotFreqHz}
                onChange={e => {
                  const raw = parseFloat(e.target.value);
                  const v = Math.round((raw - 12.5) / 25) * 25 + 12.5;
                  setState({ pilotFreqHz: v });
                  window.dispatchEvent(new CustomEvent("eardrop-pilot-freq", { detail: { freq: v } }));
                }}
                style={{ width: "100%", accentColor: "#f59e0b" }}
              />
            </div>

            {/* Amp Threshold */}
            <div style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 12, color: "#6b7280" }}>Amp Threshold</span>
                <span style={{ fontSize: 12, fontFamily: "SF Mono, ui-monospace, monospace", color: "#f59e0b" }}>{s.ampThresholdRatio.toFixed(2)}</span>
              </div>
              <input type="range" min="0.05" max="0.5" step="0.05" value={s.ampThresholdRatio}
                onChange={e => {
                  const v = parseFloat(e.target.value);
                  setState({ ampThresholdRatio: v });
                  window.dispatchEvent(new CustomEvent("eardrop-thresholds", { detail: { ampRatio: v, syncMul: s.syncStrongMultiplier } }));
                }}
                style={{ width: "100%", accentColor: "#f59e0b" }}
              />
            </div>

            {/* Audio Devices */}
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <select id="inputSelect" style={{ flex: 1, background: "rgba(255,255,255,0.04)", color: "#e5e7eb", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, padding: "4px 6px", fontSize: 11 }}>
                <option value="">Default Mic</option>
              </select>
              <select id="outputSelect" style={{ flex: 1, background: "rgba(255,255,255,0.04)", color: "#e5e7eb", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, padding: "4px 6px", fontSize: 11 }}>
                <option value="">Default Speaker</option>
              </select>
              <button id="refreshDevices" style={{ padding: "4px 8px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 5, background: "rgba(255,255,255,0.04)", color: "#6b7280", cursor: "pointer", fontSize: 11 }}>↻</button>
            </div>
          </Card>
        </div>

        {/* ── RIGHT: Debug Dashboard ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: GAP }}>

          {/* Decoder State */}
          <Card title="Decoder State" accent="#818cf8">
            {!debug ? (
              <div style={{ padding: "12px 0", color: "#6b7280", fontSize: 13, textAlign: "center" }}>
                Listening for signal…
              </div>
            ) : (
              <>
                {/* Stats grid */}
                <div style={{
                  display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1px",
                  background: "rgba(255,255,255,0.05)", borderRadius: 6, overflow: "hidden", marginBottom: 10,
                }}>
                  <div style={statBg}><Stat label="Status" value={debug.inFrame ? "DATA" : debug.noiseFrames < 25 ? "Profiling" : "Listening"} color={debug.inFrame ? "#34d399" : "#f59e0b"} /></div>
                  <div style={statBg}><Stat label="Sync" value={`${debug.consecutiveSync}`} color="#818cf8" /></div>
                  <div style={statBg}><Stat label="SNR" value={`${debug.signalToNoise.toFixed(1)} dB`} color={snrColor} /></div>
                  <div style={statBg}><Stat label="Pilot" value={`${debug.pilotFreq.toFixed(1)} Hz`} color="#818cf8" /></div>
                  <div style={statBg}><Stat label="Bits" value={`${debug.bitsCollected}`} color="#e5e7eb" /></div>
                  <div style={statBg}><Stat label="Blocks" value={`${debug.blocksDecoded}/${debug.blocksCrcFailed > 0 ? "⚠️" : "✓"}`} color={debug.blocksCrcFailed > 0 ? "#f87171" : "#34d399"} /></div>
                </div>

                {/* Per-tone energies */}
                <div style={{ marginBottom: 10 }}>
                  {[0, 1, 2, 3].map(t => (
                    <MeterBar key={t} val={debug.energies[t]} peak={Math.max(...debug.energies, 0.1)} color={TONE_COLORS[t]} label={`${TONE_FREQS[t]}Hz`} />
                  ))}
                </div>

                {/* Bit Analyzer */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Bit Analyzer</div>
                  <BitAnalyzer debug={debug} />
                </div>

                {/* Noise floor */}
                <div style={{ fontSize: 10, color: "#4b5563", fontFamily: "SF Mono, ui-monospace, monospace" }}>
                  Noise: {debug.noiseFloor.map(n => n.toExponential(1)).join(" | ")}
                </div>

                {/* Frame trace log */}
                {s.debugTrace && s.debugTrace.length > 0 && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      Frame Trace ({s.debugTrace.length})
                    </div>
                    <div style={{
                      maxHeight: 180, overflow: "auto",
                      background: "rgba(0,0,0,0.4)", borderRadius: 6,
                      border: "1px solid rgba(255,255,255,0.05)",
                      fontFamily: "SF Mono, ui-monospace, monospace", fontSize: 10,
                    }}>
                      {s.debugTrace.slice(-40).map((entry, i) => (
                        <div key={i} style={{
                          display: "flex", gap: 8, padding: "2px 8px",
                          borderBottom: "1px solid rgba(255,255,255,0.03)",
                          alignItems: "center",
                        }}>
                          <span style={{ color: "#4b5563", minWidth: 32 }}>#{entry.sym}</span>
                          <span style={{ color: "#e5e7eb", minWidth: 70 }}>
                            {entry.bits.map((b, ti) => (
                              <span key={ti} style={{ color: b ? "#f87171" : "#818cf8" }}>{b}</span>
                            ))}
                          </span>
                          <span style={{ color: "#6b7280", minWidth: 40 }}>0x{entry.frameHex}</span>
                          <span style={{
                            color: "#6b7280", flex: 1, textAlign: "right",
                            fontSize: 9,
                          }}>
                            I=[{entry.rawI.map(v => v.toFixed(3)).join(",")}]
                          </span>
                          {entry.blockEvent && (
                            <span style={{
                              color: "#34d399", fontSize: 9, fontWeight: 600,
                              background: "rgba(52,211,153,0.15)",
                              padding: "1px 6px", borderRadius: 3,
                            }}>{entry.blockEvent}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>

          {/* Constellation */}
          <Card title="Constellation" accent="#c084fc">
            <div style={{ display: "flex", justifyContent: "space-around" }}>
              {[0, 1, 2, 3].map(t => (
                <ConstellationCanvas key={t} tone={t} iVal={debug?.relI[t] ?? 0} qVal={debug?.relQ[t] ?? 0} color={TONE_COLORS[t]} label={`T${t}`} />
              ))}
            </div>
          </Card>

          {/* Modem Debug Scope */}
          <Card title="Modem Scope — Phase + Energy" accent="#f472b6">
            <ModemScope
              trace={s.debugTrace}
              energies={(s.debug?.energies || [0,0,0,0]) as [number,number,number,number]}
              relI={(s.debug?.relI || [0,0,0,0]) as [number,number,number,number]}
              relQ={(s.debug?.relQ || [0,0,0,0]) as [number,number,number,number]}
              inFrame={s.debug?.inFrame || false}
              pilotFreq={s.debug?.pilotFreq || 0}
              pilotAmp={s.debug?.pilotAmplitude || 0}
            />
          </Card>

          {/* Diagnostics */}
          {s.diagMessages.length > 0 && (
            <Card title="Diagnostics" accent="#f59e0b">
              <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                {s.diagMessages.map((m, i) => {
                  const isGood = m.startsWith("✓");
                  const isBad = m.startsWith("✗");
                  const isWarn = m.startsWith("⚠");
                  return (
                    <div key={i} style={{
                      color: isGood ? "#34d399" : isBad ? "#f87171" : isWarn ? "#f59e0b" : "#e5e7eb",
                      fontFamily: isGood || isBad ? "SF Mono, monospace" : undefined,
                    }}>{m}</div>
                  );
                })}
                <button onClick={() => setState({ diagMessages: [] })}
                  style={{ alignSelf: "flex-start", marginTop: 4, padding: "2px 8px", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, background: "rgba(255,255,255,0.04)", color: "#6b7280", cursor: "pointer", fontSize: 10 }}>
                  Clear
                </button>
              </div>
            </Card>
          )}

          {/* Actions */}
          <Card title="Actions" accent="#f59e0b">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button onClick={() => dispatch("eardrop-self-test")} style={btnSmall}>Self-Test</button>
              <button onClick={() => dispatch("eardrop-send-test")} style={btnSmall}>Send Test</button>
              <button onClick={() => dispatch("eardrop-download-wav")} style={btnSmall}>Download WAV</button>
            </div>
            <div id="selfTestResult" style={{ fontSize: 11, color: "#6b7280", fontFamily: "SF Mono, ui-monospace, monospace", marginTop: 6, minHeight: 16 }} />
          </Card>
        </div>
      </div>

      {/* ═══ FULL-WIDTH: Spectrum + Waveform ═══ */}
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: GAP }}>
        <Card title="Spectrum — FFT + Waterfall" accent="#818cf8">
          <SpectrumAnalyzer spectrum={s.fftSpectrum} rawPeak={s.rawPeak} noiseFloorDb={s.noiseFloorDb} sampleRate={3200} />
        </Card>
        <Card title="Waveform — RX (blue) / TX (orange)" accent="#6c6cff">
          <WaveformScope rxSamples={s.debugSamples} txSamples={s.txSamples} sampleRate={3200} />
        </Card>
      </div>
    </div>
  );
}

const statBg: React.CSSProperties = { background: "rgba(255,255,255,0.02)", padding: "10px 12px" };

const btnSmall: React.CSSProperties = {
  flex: "1 1 auto", minWidth: 90,
  padding: "8px 12px", border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6, background: "rgba(255,255,255,0.04)",
  color: "#e5e7eb", cursor: "pointer", fontSize: 12, fontWeight: 500,
};

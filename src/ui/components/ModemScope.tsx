/**
 * ModemScope.tsx — Comprehensive BPSK/OFDM visual debug panel.
 * Phase trajectory, energy strip chart, constellation with decision boundaries.
 */

import React, { useEffect, useRef } from "react";

const TONE_COLORS = ["#4a9eff", "#ff6b4a", "#5eead4", "#f472b6"];
const TONE_FREQS = [475, 525, 625, 775];

interface DebugEntry {
  sym: number;
  rawI: number[];
  bits: number[];
  frameHex: string;
  blockEvent?: string;
}

interface Props {
  trace: DebugEntry[];
  energies: [number, number, number, number];
  relI: [number, number, number, number];
  relQ: [number, number, number, number];
  inFrame: boolean;
  pilotFreq: number;
  pilotAmp: number;
}

export function ModemScope({ trace, energies, relI, relQ, inFrame, pilotFreq, pilotAmp }: Props) {
  const phaseRef = useRef<HTMLCanvasElement>(null);
  const energyRef = useRef<HTMLCanvasElement>(null);
  const energyHistory = useRef<Array<[number,number,number,number]>>([]);

  // Energy strip chart
  useEffect(() => {
    const ec = energyRef.current;
    if (!ec) return;
    const ctx = ec.getContext("2d");
    if (!ctx) return;
    const w = ec.width, h = ec.height;

    // Push new energy row
    const hist = energyHistory.current;
    hist.push([...energies]);
    if (hist.length > 120) hist.shift();

    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(0, 0, w, h);

    const maxE = Math.max(0.01, ...hist.flat());
    const rowW = w / Math.max(1, hist.length);

    for (let t = 0; t < 4; t++) {
      const y0 = (t / 4) * h;
      const y1 = ((t + 1) / 4) * h;
      const bandH = y1 - y0;

      ctx.strokeStyle = TONE_COLORS[t];
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < hist.length; i++) {
        const val = hist[i][t];
        const x = i * rowW + rowW / 2;
        const y = y1 - (val / maxE) * bandH;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Label
      ctx.fillStyle = TONE_COLORS[t];
      ctx.font = "8px monospace";
      ctx.fillText(`${TONE_FREQS[t]}`, 2, y0 + 10);
    }

    // Time axis
    ctx.fillStyle = "#4b5563";
    ctx.font = "8px monospace";
    ctx.textAlign = "right";
    if (hist.length > 0) {
      const lastSym = trace.length > 0 ? trace[trace.length - 1].sym : hist.length;
      ctx.fillText(`sym ${lastSym}`, w - 2, h - 4);
    }
  }, [energies, trace]);

  // Phase trajectory
  useEffect(() => {
    const pc = phaseRef.current;
    if (!pc) return;
    const ctx = pc.getContext("2d");
    if (!ctx) return;
    const w = pc.width, h = pc.height;

    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const scale = (w / 2) / 0.6;

    // Axes and decision boundary
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke(); // I=0 decision line
    ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();

    // Unit circle
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.beginPath(); ctx.arc(cx, cy, 0.4 * scale, 0, Math.PI * 2); ctx.stroke();

    // Draw trajectory connecting last N points per tone
    const N = Math.min(30, trace.length);
    const start = trace.length - N;

    for (let t = 0; t < 4; t++) {
      ctx.strokeStyle = TONE_COLORS[t];
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      for (let i = start; i < trace.length; i++) {
        const entry = trace[i];
        if (!entry || !entry.rawI || entry.rawI.length <= t) continue;
        const x = cx + (entry.rawI[t] || 0) * scale;
        const y = cy - 0 * scale; // Q not tracked in trace, just show I-jitter
        i === start ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Current dots
    for (let t = 0; t < 4; t++) {
      const x = cx + (relI[t] || 0) * scale;
      const y = cy - (relQ[t] || 0) * scale;
      ctx.fillStyle = TONE_COLORS[t];
      ctx.shadowColor = TONE_COLORS[t];
      ctx.shadowBlur = 4;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.stroke();
    }
  }, [trace, relI, relQ]);

  const phaseLabels = [
    { label: "0° (bit=0)", x: 70, y: 10, color: "#818cf8" },
    { label: "180° (bit=1)", x: 10, y: 10, color: "#f87171" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* PLL / Sync status bar */}
      <div style={{
        display: "flex", gap: 16, fontSize: 10,
        padding: "4px 8px", background: "rgba(0,0,0,0.3)", borderRadius: 4,
        fontFamily: "monospace", color: "#6b7280",
      }}>
        <span>PLL: <span style={{ color: pilotFreq > 0 ? "#34d399" : "#f87171" }}>
          {pilotFreq > 0 ? `${pilotFreq.toFixed(1)}Hz` : "unlocked"}
        </span></span>
        <span>Amp: <span style={{ color: "#e5e7eb" }}>{pilotAmp.toExponential(2)}</span></span>
        <span>Frame: <span style={{ color: inFrame ? "#34d399" : "#6b7280" }}>
          {inFrame ? "DATA" : "scanning"}
        </span></span>
        <span>Trace: <span style={{ color: "#e5e7eb" }}>{trace.length} frames</span></span>
      </div>

      {/* Phase trajectory (top) */}
      <div style={{ position: "relative" }}>
        <canvas ref={phaseRef} width={400} height={130} style={{
          width: "100%", height: 130, borderRadius: 4,
          background: "rgba(0,0,0,0.4)",
        }} />
        {phaseLabels.map((pl, i) => (
          <span key={i} style={{
            position: "absolute", top: pl.y, left: pl.x,
            fontSize: 8, color: pl.color, fontFamily: "monospace",
            pointerEvents: "none",
          }}>{pl.label}</span>
        ))}
      </div>

      {/* Energy strip chart (bottom) */}
      <canvas ref={energyRef} width={400} height={80} style={{
        width: "100%", height: 80, borderRadius: 4,
        background: "rgba(0,0,0,0.4)",
      }} />
    </div>
  );
}

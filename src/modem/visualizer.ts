/**
 * Debug visualizer for modem signals.
 * Ported from TapewormFS debug-suite Visualizer.ts
 *
 * 4 views: waveform, spectrogram, tone energy bars, split carrier envelopes
 */

import { DSP } from "./dsp";
import { TONES } from "./types";

const COLORS = ["#6c6cff", "#ff6b4a", "#5eead4", "#f472b6"];

interface CtxDim {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

export class Visualizer {
  private dsp = new DSP(3200);

  // ─── Waveform ──────────────────────────────────────────────

  drawWaveform(canvas: HTMLCanvasElement, samples: Float32Array) {
    const d = this.setupCanvas(canvas);
    if (!samples || samples.length < 2) { this.drawNoData(d); return; }

    const midY = d.h / 2;
    const amp = d.h / 2 - 8;
    const step = Math.max(1, Math.floor(samples.length / d.w));

    this.grid(d, midY);

    d.ctx.strokeStyle = "#6c6cff";
    d.ctx.lineWidth = 1.5;
    d.ctx.beginPath();
    for (let x = 0; x < d.w; x++) {
      const idx = Math.floor(x * step);
      if (idx >= samples.length) break;
      const y = midY + samples[idx] * amp;
      x === 0 ? d.ctx.moveTo(x, y) : d.ctx.lineTo(x, y);
    }
    d.ctx.stroke();

    this.timeLabels(d, samples.length / 3200);
  }

  // ─── Spectrogram ───────────────────────────────────────────

  drawSpectrogram(canvas: HTMLCanvasElement, samples: Float32Array) {
    const d = this.setupCanvas(canvas);
    if (!samples || samples.length < 256) { this.drawNoData(d); return; }

    const fftSize = 512;
    const hopSize = 128;
    const frames = this.dsp.spectrogram(samples, fftSize, hopSize);
    if (frames.length === 0) return;

    let maxMag = 0;
    for (const f of frames) for (const v of f) if (v > maxMag) maxMag = v;
    if (maxMag === 0) maxMag = 1;

    for (let x = 0; x < d.w && x < frames.length; x++) {
      const frame = frames[x];
      for (let y = 0; y < d.h; y++) {
        const bin = Math.floor((y / d.h) * frame.length);
        if (bin >= frame.length) continue;
        const db = 20 * Math.log10(frame[bin] / maxMag + 1e-10);
        const norm = Math.max(0, Math.min(1, (db + 60) / 50));
        d.ctx.fillStyle = this.hotColor(norm);
        d.ctx.fillRect(x, d.h - 1 - y, 1, 1);
      }
    }

    // Tone frequency lines
    for (const f of TONES) {
      const y = (f / 1600) * d.h;
      d.ctx.strokeStyle = "#6c6cff44";
      d.ctx.lineWidth = 0.5;
      d.ctx.setLineDash([3, 4]);
      d.ctx.beginPath(); d.ctx.moveTo(0, d.h - y); d.ctx.lineTo(d.w, d.h - y); d.ctx.stroke();
      d.ctx.setLineDash([]);
      d.ctx.fillStyle = "#6c6cff88";
      d.ctx.font = "8px monospace";
      d.ctx.fillText(`${f}Hz`, 2, d.h - y - 2);
    }

    this.timeLabels(d, samples.length / 3200);
  }

  // ─── Tone Energy Bars ──────────────────────────────────────

  drawToneEnergy(canvas: HTMLCanvasElement, samples: Float32Array) {
    const d = this.setupCanvas(canvas);
    const barW = (d.w - 80) / TONES.length;

    const energies: number[] = [];
    let maxE = 0;
    for (let t = 0; t < TONES.length; t++) {
      const e = this.dsp.goertzel(samples, TONES[t]);
      energies.push(e);
      if (e > maxE) maxE = e;
    }
    if (maxE === 0) maxE = 1;

    for (let i = 0; i < TONES.length; i++) {
      const x = 50 + i * barW;
      const barH = (energies[i] / maxE) * (d.h - 40);
      const color = COLORS[i % COLORS.length];

      d.ctx.fillStyle = color;
      d.ctx.fillRect(x + 2, d.h - 20 - barH, barW - 4, barH);

      d.ctx.fillStyle = "#aaa";
      d.ctx.font = "9px monospace";
      const db = 20 * Math.log10(energies[i] + 1e-10);
      d.ctx.fillText(`${db.toFixed(1)}dB`, x + 2, d.h - 24 - barH);

      d.ctx.fillStyle = color;
      d.ctx.font = "9px monospace";
      d.ctx.fillText(`${TONES[i]}Hz`, x + 2, d.h - 5);
    }

    d.ctx.fillStyle = "#555";
    d.ctx.font = "9px monospace";
    d.ctx.fillText("Tones →", 5, d.h - 5);
  }

  // ─── Split Carrier Envelopes (energy per tone over time) ──

  drawSplitCarriers(canvas: HTMLCanvasElement, samples: Float32Array) {
    const d = this.setupCanvas(canvas);
    if (!samples || samples.length < 128) { this.drawNoData(d); return; }

    const bandH = (d.h - 20) / TONES.length;
    const blockSize = 64;
    const numBlocks = Math.floor(samples.length / blockSize);

    for (let i = 0; i < TONES.length; i++) {
      const yOff = 10 + i * bandH;
      const midY = yOff + bandH / 2;
      const color = COLORS[i % COLORS.length];

      // Label
      d.ctx.fillStyle = color;
      d.ctx.font = "9px monospace";
      d.ctx.fillText(`${TONES[i]}Hz`, 4, yOff + 11);

      // Zero line
      d.ctx.strokeStyle = `${color}33`;
      d.ctx.lineWidth = 0.5;
      d.ctx.beginPath(); d.ctx.moveTo(42, midY); d.ctx.lineTo(d.w, midY); d.ctx.stroke();

      // Short-time Goertzel energy per block
      const energies: number[] = [];
      let maxE = 0;
      for (let b = 0; b < numBlocks; b++) {
        const block = samples.slice(b * blockSize, (b + 1) * blockSize);
        const e = this.dsp.goertzel(block, TONES[i]);
        energies.push(e);
        if (e > maxE) maxE = e;
      }
      if (maxE === 0) maxE = 1;

      // Envelope
      const amp = bandH / 2 - 4;
      d.ctx.strokeStyle = color;
      d.ctx.lineWidth = 1.2;
      d.ctx.beginPath();
      for (let x = 0; x < energies.length && x < d.w - 42; x++) {
        const px = 42 + (x / Math.max(energies.length - 1, 1)) * (d.w - 42);
        const py = midY - (energies[x] / maxE) * amp;
        x === 0 ? d.ctx.moveTo(px, py) : d.ctx.lineTo(px, py);
      }
      d.ctx.stroke();
    }
  }

  // ─── Internal ─────────────────────────────────────────────

  private setupCanvas(canvas: HTMLCanvasElement): CtxDim {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    canvas.width = w * dpr;
    canvas.height = h * dpr;

    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a0a12";
    ctx.fillRect(0, 0, w, h);
    return { ctx, w, h };
  }

  private drawNoData(d: CtxDim) {
    d.ctx.fillStyle = "#555";
    d.ctx.font = "12px monospace";
    d.ctx.fillText("No signal", 10, d.h / 2);
  }

  private grid(d: CtxDim, midY: number) {
    d.ctx.strokeStyle = "#1a1a28";
    d.ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = midY + (i - 2) * (d.h / 4);
      d.ctx.beginPath(); d.ctx.moveTo(0, y); d.ctx.lineTo(d.w, y); d.ctx.stroke();
    }
    d.ctx.strokeStyle = "#ff446644";
    d.ctx.lineWidth = 1;
    d.ctx.beginPath(); d.ctx.moveTo(0, midY); d.ctx.lineTo(d.w, midY); d.ctx.stroke();
  }

  private timeLabels(d: CtxDim, duration: number) {
    d.ctx.fillStyle = "#666";
    d.ctx.font = "8px monospace";
    for (let i = 0; i <= 3; i++) {
      const t = (i / 3) * duration;
      d.ctx.fillText(`${t.toFixed(1)}s`, (i / 3) * d.w + 3, d.h - 3);
    }
  }

  private hotColor(norm: number): string {
    norm = Math.max(0, Math.min(1, norm));
    const r = Math.min(255, Math.floor(255 * norm * 1.5));
    const g = Math.min(255, Math.floor(255 * norm * 0.7));
    const b = Math.min(255, Math.floor(255 * norm * 0.2));
    return `rgb(${r},${g},${b})`;
  }
}

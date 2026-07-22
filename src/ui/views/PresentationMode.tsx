/**
 * PresentationMode.tsx — interactive teaching sandbox that builds an OFDM symbol.
 * Toggle each subcarrier on, set its 2 bits (QPSK). The focus is a big STACK
 * plot: every tone's waveform on one plot, offset in Y, so you see each one
 * turn on. Below: the summed symbol. Then the I/Q and the decoder's FFT.
 * Pure in-UI math — no modem.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { Screen } from '../components/instrument/Screen';
import { T, TONE_TRACE } from '../theme/labaccent/tokens';

const SR = 16000;         // teaching sample rate
const N = 128;            // display window (~8 ms) — few cycles per tone, clean
const PILOT_HZ = 500;
const TONE_HZ = [1000, 1500, 2000, 2500];
const PLOT_W = 820;

interface ToneState { on: boolean; b0: number; b1: number; }

const qpsk = (b0: number, b1: number) => ({ i: b0 ? -1 : 1, q: b1 ? -1 : 1 });

function toneWave(freq: number, I: number, Q: number): Float32Array {
  const out = new Float32Array(N);
  const mag = Math.hypot(I, Q) || 1;
  for (let n = 0; n < N; n++) {
    const a = (2 * Math.PI * freq * n) / SR;
    out[n] = (I * Math.cos(a) - Q * Math.sin(a)) / mag;
  }
  return out;
}

function dftMag(x: Float32Array, bins: number, maxHz: number): Float32Array {
  const out = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const f = (b / bins) * maxHz;
    let re = 0; let im = 0;
    for (let n = 0; n < x.length; n++) {
      const a = (2 * Math.PI * f * n) / SR;
      re += x[n] * Math.cos(a);
      im -= x[n] * Math.sin(a);
    }
    out[b] = Math.hypot(re, im) / x.length;
  }
  return out;
}

const STEPS = [
  '1 · Pick bits per tone (QPSK: 2 bits → one I/Q point)',
  '2 · Each tone is a sine; its phase is set by its I/Q',
  '3 · Turn tones on — see them stack up',
  '4 · Sum the stack (+ pilot) → the OFDM symbol',
  '5 · The decoder takes an FFT → peaks reveal each tone',
];

export function PresentationMode({ onExit }: { onExit: () => void }) {
  const [tones, setTones] = useState<ToneState[]>([
    { on: true, b0: 0, b1: 0 },
    { on: true, b0: 0, b1: 1 },
    { on: false, b0: 1, b1: 0 },
    { on: false, b0: 1, b1: 1 },
  ]);
  const [pilotOn, setPilotOn] = useState(true);
  const [step, setStep] = useState(2);

  const set = (i: number, patch: Partial<ToneState>) =>
    setTones((ts) => ts.map((t, k) => (k === i ? { ...t, ...patch } : t)));

  // Play the currently-enabled tones (+ pilot) as real audio for ~1.2s.
  const listen = () => {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);
    const freqs: number[] = [];
    if (pilotOn) freqs.push(PILOT_HZ);
    tones.forEach((t, i) => { if (t.on) freqs.push(TONE_HZ[i]); });
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = f;
      osc.connect(master);
      osc.start();
      osc.stop(ctx.currentTime + 1.2);
    }
    setTimeout(() => ctx.close(), 1500);
  };

  const { layers, combined, fft, maxHz } = useMemo(() => {
    const ls: { wave: Float32Array; color: string; label: string; freq: number }[] = [];
    if (pilotOn) ls.push({ wave: toneWave(PILOT_HZ, 1, 0), color: '#ff5a3c', label: `PILOT ${PILOT_HZ}Hz`, freq: PILOT_HZ });
    tones.forEach((t, i) => {
      if (!t.on) return;
      const { i: I, q: Q } = qpsk(t.b0, t.b1);
      ls.push({ wave: toneWave(TONE_HZ[i], I, Q), color: TONE_TRACE[i], label: `${TONE_HZ[i]}Hz`, freq: TONE_HZ[i] });
    });
    const sum = new Float32Array(N);
    for (const l of ls) for (let n = 0; n < N; n++) sum[n] += l.wave[n];
    if (ls.length) for (let n = 0; n < N; n++) sum[n] /= ls.length;
    const mHz = SR / 2;
    return { layers: ls, combined: sum, fft: dftMag(sum, 200, mHz), maxHz: mHz };
  }, [tones, pilotOn]);

  // ─── the STACK: every layer on one plot, offset in Y ───
  const drawStack = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const n = Math.max(1, layers.length);
    const rowH = h / n;
    layers.forEach((l, k) => {
      const base = rowH * (k + 0.5);
      const amp = rowH * 0.4;
      // baseline
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, base); ctx.lineTo(w, base); ctx.stroke();
      // wave
      ctx.strokeStyle = l.color; ctx.lineWidth = 1.8; ctx.beginPath();
      for (let i = 0; i < l.wave.length; i++) {
        const x = (i / (l.wave.length - 1)) * w;
        const y = base - l.wave[i] * amp;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      // label
      ctx.fillStyle = l.color; ctx.font = `11px ${T.mono}`;
      ctx.fillText(l.label, 4, base - rowH * 0.32);
    });
  };

  // ─── combined symbol ───
  const drawCombined = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    let peak = 0; for (let i = 0; i < combined.length; i++) peak = Math.max(peak, Math.abs(combined[i]));
    const g = peak > 1e-4 ? 0.9 / peak : 1;
    ctx.strokeStyle = T.phosphor; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < combined.length; i++) {
      const x = (i / (combined.length - 1)) * w;
      const y = h / 2 - combined[i] * g * (h / 2 - 4);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  // ─── I/Q constellation, one dot per tone in its own colour ───
  const drawIQ = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const cx = w / 2; const cy = h / 2; const s = Math.min(w, h) * 0.34;
    // axes
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, 6); ctx.lineTo(cx, h - 6); ctx.moveTo(6, cy); ctx.lineTo(w - 6, cy); ctx.stroke();
    ctx.fillStyle = 'rgba(210,210,200,0.5)'; ctx.font = `9px ${T.mono}`;
    ctx.fillText('I', w - 12, cy - 4); ctx.fillText('Q', cx + 4, 12);
    const dot = (i: number, q: number, color: string, label: string) => {
      const x = cx + i * s; const y = cy - q * s;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
      ctx.font = `10px ${T.mono}`;
      ctx.fillText(label, x + 8, y + 3);
    };
    tones.forEach((t, i) => { if (t.on) { const p = qpsk(t.b0, t.b1); dot(p.i, p.q, TONE_TRACE[i], `${TONE_HZ[i]}`); } });
    if (pilotOn) dot(1, 0, '#ff5a3c', 'pilot');
  };

  // ─── FFT the decoder sees ───
  const drawFft = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    let peak = 0; for (let b = 0; b < fft.length; b++) peak = Math.max(peak, fft[b]);
    if (peak < 1e-6) peak = 1;
    const base = h - 16;
    // bars
    for (let b = 0; b < fft.length; b++) {
      const x = (b / fft.length) * w;
      const bh = (fft[b] / peak) * (base - 4);
      ctx.fillStyle = T.phosphor;
      ctx.fillRect(x, base - bh, Math.max(1, w / fft.length - 0.5), bh);
    }
    // tone + pilot markers
    ctx.font = `10px ${T.mono}`;
    for (const l of layers) {
      const x = (l.freq / maxHz) * w;
      ctx.strokeStyle = l.color; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
      ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, base); ctx.stroke(); ctx.setLineDash([]);
    }
    // freq axis
    ctx.fillStyle = 'rgba(210,210,200,0.6)';
    for (let khz = 1; khz * 1000 < maxHz; khz++) {
      const x = ((khz * 1000) / maxHz) * w;
      ctx.fillText(`${khz}k`, x - 6, h - 3);
    }
  };

  const btn = (active: boolean): CSSProperties => ({
    fontFamily: T.mono, fontSize: 11, padding: '3px 9px', borderRadius: 4, cursor: 'pointer',
    border: `1px solid ${active ? T.phosphor : T.panelEdge}`,
    background: active ? T.phosphorDim : 'transparent', color: active ? T.phosphor : T.panelInk,
  });
  const panel: CSSProperties = { background: T.panel, border: `1px solid ${T.panelEdge}`, borderRadius: T.radius, padding: 10, marginBottom: 12 };
  const title: CSSProperties = { fontFamily: T.mono, fontSize: 11, letterSpacing: 1, color: T.panelInk, opacity: 0.8, marginBottom: 6 };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontFamily: T.mono, fontSize: 15, letterSpacing: 1, color: T.panelInk }}>PRESENTATION — build an OFDM symbol</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={listen} style={btn(true)}>🔊 LISTEN</button>
          <button onClick={onExit} style={btn(false)}>← back to bench</button>
        </div>
      </div>

      {/* step narration */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
        {STEPS.map((sTxt, i) => (
          <button key={i} onClick={() => setStep(i)} style={btn(i === step)} title={sTxt}>{i + 1}</button>
        ))}
        <span style={{ fontFamily: T.mono, fontSize: 13, color: T.panelInk, marginLeft: 6 }}>{STEPS[step]}</span>
      </div>

      {/* compact controls */}
      <div style={panel}>
        <div style={title}>SUBCARRIERS — toggle on, click bits</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {tones.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={t.on} onChange={(e) => set(i, { on: e.target.checked })} className="lab-toggle" />
              <span style={{ fontFamily: T.mono, fontSize: 12, color: TONE_TRACE[i] }}>{TONE_HZ[i]}Hz</span>
              <button style={btn(!t.b0)} onClick={() => set(i, { b0: t.b0 ? 0 : 1 })}>b0={t.b0}</button>
              <button style={btn(!t.b1)} onClick={() => set(i, { b1: t.b1 ? 0 : 1 })}>b1={t.b1}</button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={pilotOn} onChange={(e) => setPilotOn(e.target.checked)} className="lab-toggle" />
            <span style={{ fontFamily: T.mono, fontSize: 12, color: '#ff5a3c' }}>PILOT {PILOT_HZ}Hz</span>
          </div>
        </div>
      </div>

      {/* THE STACK — the focus, big */}
      <div style={panel}>
        <div style={title}>THE STACK — each tone as its own wave (before combining)</div>
        <div style={{ overflowX: 'auto' }}>
          <Screen width={PLOT_W} height={300} draw={drawStack} grid={false} />
        </div>
      </div>

      {/* COMBINED — big */}
      <div style={panel}>
        <div style={title}>Σ COMBINED OFDM SYMBOL (sum of the stack)</div>
        <div style={{ overflowX: 'auto' }}>
          <Screen width={PLOT_W} height={180} draw={drawCombined} />
        </div>
      </div>

      {/* I/Q + FFT */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...panel, flex: '0 0 auto' }}>
          <div style={title}>I / Q (QPSK) — coloured per tone</div>
          <Screen width={240} height={240} draw={drawIQ} grid={false} />
        </div>
        <div style={{ ...panel, flex: '1 1 400px' }}>
          <div style={title}>FFT — what the decoder sees (peaks = tones)</div>
          <Screen width={520} height={240} draw={drawFft} grid={false} />
        </div>
      </div>
    </div>
  );
}

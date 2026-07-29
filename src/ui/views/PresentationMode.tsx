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

const PRESETS: { label: string; tones: ToneState[]; pilot: boolean }[] = [
  { label: 'Reset', tones: [
    { on: true, b0: 0, b1: 0 },
    { on: true, b0: 0, b1: 1 },
    { on: false, b0: 1, b1: 0 },
    { on: false, b0: 1, b1: 1 },
  ], pilot: true },
  { label: 'All tones', tones: [
    { on: true, b0: 0, b1: 0 },
    { on: true, b0: 0, b1: 1 },
    { on: true, b0: 1, b1: 0 },
    { on: true, b0: 1, b1: 1 },
  ], pilot: true },
  { label: 'One tone', tones: [
    { on: true, b0: 1, b1: 0 },
    { on: false, b0: 0, b1: 0 },
    { on: false, b0: 0, b1: 0 },
    { on: false, b0: 0, b1: 0 },
  ], pilot: true },
  { label: 'Alternating', tones: [
    { on: true, b0: 0, b1: 0 },
    { on: true, b0: 1, b1: 1 },
    { on: true, b0: 0, b1: 0 },
    { on: true, b0: 1, b1: 1 },
  ], pilot: true },
  { label: 'Random', tones: [
    { on: Math.random() > 0.5, b0: Math.random() > 0.5 ? 1 : 0, b1: Math.random() > 0.5 ? 1 : 0 },
    { on: Math.random() > 0.5, b0: Math.random() > 0.5 ? 1 : 0, b1: Math.random() > 0.5 ? 1 : 0 },
    { on: Math.random() > 0.5, b0: Math.random() > 0.5 ? 1 : 0, b1: Math.random() > 0.5 ? 1 : 0 },
    { on: Math.random() > 0.5, b0: Math.random() > 0.5 ? 1 : 0, b1: Math.random() > 0.5 ? 1 : 0 },
  ], pilot: true },
];

function addNoise(signal: Float32Array, amplitude: number): Float32Array {
  if (amplitude <= 0) return signal;
  const out = new Float32Array(signal.length);
  for (let n = 0; n < signal.length; n++) {
    // Box-Muller-ish quick normal approximation
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    out[n] = signal[n] + amplitude * z;
  }
  return out;
}

function signalPower(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i++) sum += signal[i] * signal[i];
  return sum / signal.length;
}

export function PresentationMode({ onExit }: { onExit: () => void }) {
  const [tones, setTones] = useState<ToneState[]>(PRESETS[0].tones);
  const [pilotOn, setPilotOn] = useState(true);
  const [step, setStep] = useState(2);
  const [decIdx, setDecIdx] = useState(0); // which tone to decode; -1 = pilot
  const [noise, setNoise] = useState(0);

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

  const { layers, noisyCombined, fft, snrDb, maxHz } = useMemo(() => {
    const ls: { wave: Float32Array; color: string; label: string; freq: number }[] = [];
    if (pilotOn) ls.push({ wave: toneWave(PILOT_HZ, 1, 0), color: '#ff5a3c', label: `PILOT ${PILOT_HZ}Hz`, freq: PILOT_HZ });
    tones.forEach((t, i) => {
      if (!t.on) return;
      const { i: I, q: Q } = qpsk(t.b0, t.b1);
      ls.push({ wave: toneWave(TONE_HZ[i], I, Q), color: TONE_TRACE[i], label: `${TONE_HZ[i]}Hz`, freq: TONE_HZ[i] });
    });
    const sum = new Float32Array(N);
    for (const layer of ls) for (let n = 0; n < N; n++) sum[n] += layer.wave[n];
    if (ls.length) for (let n = 0; n < N; n++) sum[n] /= ls.length;

    const noisy = addNoise(sum, noise);
    const sigPow = signalPower(sum);
    const noisePow = Math.max(1e-12, signalPower(noisy) - sigPow);
    const snr = sigPow / noisePow;
    const mHz = SR / 2;
    return {
      layers: ls,
      noisyCombined: noisy,
      fft: dftMag(noisy, 200, mHz),
      snrDb: 10 * Math.log10(snr),
      maxHz: mHz,
    };
  }, [tones, pilotOn, noise]);

  // ─── the STACK: every layer on one plot, offset in Y ───
  const drawStack = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const n = Math.max(1, layers.length);
    const rowH = h / n;
    layers.forEach((layer, k) => {
      const base = rowH * (k + 0.5);
      const amp = rowH * 0.4;
      // baseline
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, base); ctx.lineTo(w, base); ctx.stroke();
      // wave
      ctx.strokeStyle = layer.color; ctx.lineWidth = 1.8; ctx.beginPath();
      for (let i = 0; i < layer.wave.length; i++) {
        const x = (i / (layer.wave.length - 1)) * w;
        const y = base - layer.wave[i] * amp;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      // label
      ctx.fillStyle = layer.color; ctx.font = `11px ${T.mono}`;
      ctx.fillText(layer.label, 4, base - rowH * 0.32);
    });
  };

  // ─── combined symbol (with noise if enabled) ───
  const drawCombined = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const sig = noisyCombined;
    let peak = 0; for (let i = 0; i < sig.length; i++) peak = Math.max(peak, Math.abs(sig[i]));
    const g = peak > 1e-4 ? 0.9 / peak : 1;
    ctx.strokeStyle = T.phosphor; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < sig.length; i++) {
      const x = (i / (sig.length - 1)) * w;
      const y = h / 2 - sig[i] * g * (h / 2 - 4);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
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

  // ─── DECODE: correlate the noisy combined signal against reference cos/sin ───
  // I = 2/N Σ r·cos ,  Q = -2/N Σ r·sin  (scaled back up by the tone count that
  // was averaged into `combined`). Orthogonality means other tones cancel.
  const decFreq = decIdx < 0 ? PILOT_HZ : TONE_HZ[decIdx];
  const decColor = decIdx < 0 ? '#ff5a3c' : TONE_TRACE[decIdx];
  const dec = useMemo(() => {
    const cosRef = new Float32Array(N);
    const sinRef = new Float32Array(N);
    const prodI = new Float32Array(N);
    const prodQ = new Float32Array(N);
    let sI = 0; let sQ = 0;
    for (let n = 0; n < N; n++) {
      const a = (2 * Math.PI * decFreq * n) / SR;
      cosRef[n] = Math.cos(a);
      sinRef[n] = Math.sin(a);
      prodI[n] = noisyCombined[n] * cosRef[n];
      prodQ[n] = noisyCombined[n] * sinRef[n];
      sI += prodI[n];
      sQ += prodQ[n];
    }
    const scale = Math.max(1, layers.length);
    return { cosRef, sinRef, prodI, prodQ, I: (2 / N) * sI * scale, Q: -(2 / N) * sQ * scale };
  }, [noisyCombined, decFreq, layers.length]);

  // Decode every enabled tone so we can show a bits table.
  const decodedTones = useMemo(() => {
    const scale = Math.max(1, layers.length);
    return tones.map((t, i) => {
      if (!t.on) return null;
      const freq = TONE_HZ[i];
      let sI = 0; let sQ = 0;
      for (let n = 0; n < N; n++) {
        const a = (2 * Math.PI * freq * n) / SR;
        sI += noisyCombined[n] * Math.cos(a);
        sQ += noisyCombined[n] * Math.sin(a);
      }
      const I = (2 / N) * sI * scale;
      const Q = -(2 / N) * sQ * scale;
      const db0 = I < 0 ? 1 : 0;
      const db1 = Q < 0 ? 1 : 0;
      return {
        freq: TONE_HZ[i],
        color: TONE_TRACE[i],
        sent: { b0: t.b0, b1: t.b1 },
        recv: { I, Q },
        decoded: { b0: db0, b1: db1 },
        match: t.b0 === db0 && t.b1 === db1,
      };
    });
  }, [tones, noisyCombined, layers.length]);

  // draw a reference wave + the product (shaded), so the net area = I or Q
  const drawMix = (ref: Float32Array, prod: Float32Array, area: number) => (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const mid = h / 2;
    // reference (dim)
    ctx.strokeStyle = 'rgba(210,210,200,0.35)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = 0; i < ref.length; i++) {
      const x = (i / (ref.length - 1)) * w;
      const y = mid - ref[i] * (mid - 4);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    // product, shaded to baseline (its net area is the correlation)
    let peak = 0; for (let i = 0; i < prod.length; i++) peak = Math.max(peak, Math.abs(prod[i]));
    const g = peak > 1e-4 ? (mid - 4) / peak : 1;
    ctx.beginPath(); ctx.moveTo(0, mid);
    for (let i = 0; i < prod.length; i++) { const x = (i / (prod.length - 1)) * w; ctx.lineTo(x, mid - prod[i] * g); }
    ctx.lineTo(w, mid); ctx.closePath();
    ctx.fillStyle = area >= 0 ? 'rgba(60,255,122,0.35)' : 'rgba(255,90,60,0.35)';
    ctx.fill();
    ctx.strokeStyle = decColor; ctx.lineWidth = 1.5; ctx.beginPath();
    for (let i = 0; i < prod.length; i++) {
      const x = (i / (prod.length - 1)) * w;
      const y = mid - prod[i] * g;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  };

  const drawRecovered = (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const cx = w / 2; const cy = h / 2; const s = Math.min(w, h) * 0.34;
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, 6); ctx.lineTo(cx, h - 6); ctx.moveTo(6, cy); ctx.lineTo(w - 6, cy); ctx.stroke();
    // original point (hollow) vs recovered (filled)
    const orig = decIdx < 0 ? { i: 1, q: 0 } : qpsk(tones[decIdx].b0, tones[decIdx].b1);
    ctx.strokeStyle = 'rgba(210,210,200,0.6)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx + orig.i * s, cy - orig.q * s, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = decColor;
    ctx.beginPath(); ctx.arc(cx + dec.I * s, cy - dec.Q * s, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(210,210,200,0.6)'; ctx.font = `9px ${T.mono}`;
    ctx.fillText('○ sent  ● recovered', 6, h - 4);
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
    for (const layer of layers) {
      const x = (layer.freq / maxHz) * w;
      ctx.strokeStyle = layer.color; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
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
  const panel = (highlight = false): CSSProperties => ({
    background: T.panel,
    border: `1px solid ${highlight ? T.phosphor : T.panelEdge}`,
    borderRadius: T.radius,
    padding: 10,
    marginBottom: 12,
    boxShadow: highlight ? `0 0 0 1px ${T.phosphorDim}` : undefined,
  });
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

      {/* examples + controls */}
      <div style={panel(false)}>
        <div style={title}>EXAMPLES</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              style={btn(false)}
              onClick={() => { setTones(p.tones.map((t) => ({ ...t }))); setPilotOn(p.pilot); }}
            >
              {p.label}
            </button>
          ))}
        </div>
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

      {/* noise + channel simulation */}
      <div style={panel(false)}>
        <div style={title}>CHANNEL NOISE (AWGN)</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="range"
            min={0}
            max={0.5}
            step={0.01}
            value={noise}
            onChange={(e) => setNoise(parseFloat(e.target.value))}
            style={{ width: 240 }}
          />
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.panelInk }}>noise={noise.toFixed(2)}</span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: noise > 0 ? T.phosphor : T.panelInk }}>
            SNR ≈ {Number.isFinite(snrDb) ? snrDb.toFixed(1) : '∞'} dB
          </span>
        </div>
      </div>

      {/* THE STACK — the focus, big */}
      <div style={panel(step === 1 || step === 2)}>
        <div style={title}>THE STACK — each tone as its own wave (before combining)</div>
        <div style={{ overflowX: 'auto' }}>
          <Screen width={PLOT_W} height={300} draw={drawStack} grid={false} />
        </div>
      </div>

      {/* COMBINED — big */}
      <div style={panel(step === 3)}>
        <div style={title}>Σ COMBINED OFDM SYMBOL (sum of the stack)</div>
        <div style={{ overflowX: 'auto' }}>
          <Screen width={PLOT_W} height={180} draw={drawCombined} />
        </div>
      </div>

      {/* I/Q + FFT */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...panel(step === 0), flex: '0 0 auto' }}>
          <div style={title}>I / Q (QPSK) — coloured per tone</div>
          <Screen width={240} height={240} draw={drawIQ} grid={false} />
        </div>
        <div style={{ ...panel(step === 4), flex: '1 1 400px' }}>
          <div style={title}>FFT — what the decoder sees (peaks = tones)</div>
          <Screen width={520} height={240} draw={drawFft} grid={false} />
        </div>
      </div>

      {/* DECODE — recover I/Q by correlating against reference cos/sin */}
      <div style={panel(false)}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={title as CSSProperties}>DECODE — multiply by reference sine &amp; its 90° offset, then sum</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.7 }}>decode tone:</span>
            {tones.map((t, i) => t.on && (
              <button key={i} style={btn(decIdx === i)} onClick={() => setDecIdx(i)}>{TONE_HZ[i]}</button>
            ))}
            {pilotOn && <button style={btn(decIdx === -1)} onClick={() => setDecIdx(-1)}>pilot</button>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk }}>× cos (in-phase) → I = {dec.I.toFixed(2)}</div>
            <Screen width={360} height={110} draw={drawMix(dec.cosRef, dec.prodI, dec.I)} grid={false} />
          </div>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk }}>× sin (90° offset) → Q = {dec.Q.toFixed(2)}</div>
            <Screen width={360} height={110} draw={drawMix(dec.sinRef, dec.prodQ, -dec.Q)} grid={false} />
          </div>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk }}>recovered I/Q</div>
            <Screen width={150} height={110} draw={drawRecovered} grid={false} />
          </div>
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 10, color: T.panelInk, opacity: 0.7, marginTop: 4 }}>
          net shaded area = the sum. Other tones average to ~0 here (orthogonality) — only this tone survives.
        </div>
      </div>

      {/* DECODED BITS TABLE */}
      <div style={panel(false)}>
        <div style={title}>DECODED BITS — sent vs received (with noise)</div>
        <table style={{ width: '100%', fontFamily: T.mono, fontSize: 12, borderCollapse: 'collapse', color: T.panelInk }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.panelEdge}` }}>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Tone</th>
              <th style={{ textAlign: 'center', padding: '4px 8px' }}>Sent bits</th>
              <th style={{ textAlign: 'center', padding: '4px 8px' }}>Recovered I/Q</th>
              <th style={{ textAlign: 'center', padding: '4px 8px' }}>Decoded bits</th>
              <th style={{ textAlign: 'center', padding: '4px 8px' }}>Match</th>
            </tr>
          </thead>
          <tbody>
            {decodedTones.map((row, i) => row && (
              <tr key={i} style={{ borderBottom: `1px solid ${T.panelEdge}` }}>
                <td style={{ padding: '4px 8px', color: row.color }}>{row.freq}Hz</td>
                <td style={{ textAlign: 'center', padding: '4px 8px' }}>{row.sent.b0}{row.sent.b1}</td>
                <td style={{ textAlign: 'center', padding: '4px 8px' }}>{row.recv.I.toFixed(2)}, {row.recv.Q.toFixed(2)}</td>
                <td style={{ textAlign: 'center', padding: '4px 8px' }}>{row.decoded.b0}{row.decoded.b1}</td>
                <td style={{ textAlign: 'center', padding: '4px 8px', color: row.match ? '#3dff88' : '#ff5c5c' }}>{row.match ? '✓' : '✗'}</td>
              </tr>
            ))}
            {decodedTones.every((r) => r === null) && (
              <tr><td colSpan={5} style={{ padding: '8px', opacity: 0.7 }}>No tones enabled — turn on a subcarrier to decode.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

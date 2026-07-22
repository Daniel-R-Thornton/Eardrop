/**
 * PresentationMode.tsx — an interactive teaching sandbox that builds an OFDM
 * symbol from scratch on a tiny fake example. Toggle each subcarrier on, set
 * its 2 bits (QPSK), and watch: the i/q point, the per-tone waveform, the
 * summed waveform, the pilot, and the FFT the decoder would see. Pure in-UI
 * math — no modem involved.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { T, TONE_TRACE } from '../theme/labaccent/tokens';
import { Panel } from '../components/instrument/Panel';
import { Trace } from '../components/scopes/Trace';
import { Constellation } from '../components/scopes/Constellation';
import { Spectrum } from '../components/scopes/Spectrum';

const SR = 8000;         // teaching sample rate
const N = 400;           // samples in the display window
const PILOT_HZ = 1000;
const TONE_HZ = [1500, 2000, 2500, 3000];

interface ToneState { on: boolean; b0: number; b1: number; }

function qpsk(b0: number, b1: number) {
  // Gray-ish QPSK: bit 0 -> +1, bit 1 -> -1 on each axis.
  return { i: b0 ? -1 : 1, q: b1 ? -1 : 1 };
}

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
  '2 · Each tone is a sine, phase set by its I/Q',
  '3 · Turn tones on and sum them → the OFDM symbol',
  '4 · Add the pilot (reference tone)',
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
  const [step, setStep] = useState(0);

  const set = (i: number, patch: Partial<ToneState>) =>
    setTones((ts) => ts.map((t, k) => (k === i ? { ...t, ...patch } : t)));

  const { toneWaves, combined, fft } = useMemo(() => {
    const waves = tones.map((t, i) => {
      const { i: I, q: Q } = qpsk(t.b0, t.b1);
      return toneWave(TONE_HZ[i], I, Q);
    });
    const pilot = toneWave(PILOT_HZ, 1, 0);
    const active = tones.map((t, i) => (t.on ? waves[i] : null));
    const sum = new Float32Array(N);
    let count = 0;
    for (const w of active) if (w) { for (let n = 0; n < N; n++) sum[n] += w[n]; count++; }
    if (pilotOn) { for (let n = 0; n < N; n++) sum[n] += pilot[n]; count++; }
    if (count) for (let n = 0; n < N; n++) sum[n] /= count;
    return { toneWaves: waves, combined: sum, fft: dftMag(sum, 140, SR / 2) };
  }, [tones, pilotOn]);

  const btn = (active: boolean): CSSProperties => ({
    fontFamily: T.mono, fontSize: 11, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
    border: `1px solid ${active ? T.phosphor : T.panelEdge}`,
    background: active ? T.phosphorDim : 'transparent', color: active ? T.phosphor : T.panelInk,
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontFamily: T.mono, fontSize: 14, letterSpacing: 1, color: T.panelInk }}>PRESENTATION — build an OFDM symbol</span>
        <button onClick={onExit} style={btn(false)}>← back to bench</button>
      </div>

      {/* step narration */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {STEPS.map((sTxt, i) => (
          <button key={i} onClick={() => setStep(i)} style={btn(i === step)} title={sTxt}>{i + 1}</button>
        ))}
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.panelInk, marginLeft: 6 }}>{STEPS[step]}</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
        {/* tone controls */}
        <Panel title="SUBCARRIERS">
          {tones.map((t, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${T.panelEdge}` }}>
              <input type="checkbox" checked={t.on} onChange={(e) => set(i, { on: e.target.checked })} className="lab-toggle" />
              <span style={{ fontFamily: T.mono, fontSize: 12, color: TONE_TRACE[i], width: 74 }}>{TONE_HZ[i]}Hz</span>
              <button style={btn(!t.b0 ? true : false)} onClick={() => set(i, { b0: t.b0 ? 0 : 1 })}>b0={t.b0}</button>
              <button style={btn(!t.b1 ? true : false)} onClick={() => set(i, { b1: t.b1 ? 0 : 1 })}>b1={t.b1}</button>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.7 }}>
                I/Q {qpsk(t.b0, t.b1).i > 0 ? '+' : '−'}{qpsk(t.b0, t.b1).q > 0 ? '+' : '−'}
              </span>
              <div style={{ marginLeft: 'auto', opacity: t.on ? 1 : 0.3 }}>
                <Trace data={toneWaves[i]} color={TONE_TRACE[i]} width={140} height={40} />
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8 }}>
            <input type="checkbox" checked={pilotOn} onChange={(e) => setPilotOn(e.target.checked)} className="lab-toggle" />
            <span style={{ fontFamily: T.mono, fontSize: 12, color: '#ff5a3c', width: 74 }}>PILOT {PILOT_HZ}Hz</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.7 }}>reference tone</span>
            <div style={{ marginLeft: 'auto', opacity: pilotOn ? 1 : 0.3 }}>
              <Trace data={toneWave(PILOT_HZ, 1, 0)} color="#ff5a3c" width={140} height={40} />
            </div>
          </div>
        </Panel>

        {/* i/q constellation of enabled tones */}
        <Panel title="I / Q (QPSK)">
          <Constellation points={tones.filter((t) => t.on).map((t) => qpsk(t.b0, t.b1))} width={300} height={220} />
        </Panel>

        {/* combined symbol */}
        <Panel title="COMBINED OFDM SYMBOL (Σ tones + pilot)">
          <Trace data={combined} color={T.phosphor} width={300} height={160} />
        </Panel>

        {/* fft decode */}
        <Panel title="FFT — what the decoder sees">
          <Spectrum bins={fft} maxHz={SR / 2} width={300} height={160} />
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.panelInk, opacity: 0.7, marginTop: 4 }}>
            peaks at each enabled tone{pilotOn ? ` + pilot ${PILOT_HZ}Hz` : ''}
          </div>
        </Panel>
      </div>
    </div>
  );
}

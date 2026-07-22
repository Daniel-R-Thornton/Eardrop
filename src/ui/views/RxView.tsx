/**
 * RxView.tsx — the receive side: live mic scopes + decoded output.
 */
import { useStore } from '../Store';
import { useTelemetry } from '../telemetryStore';
import { T } from '../theme/labaccent/tokens';
import { Panel } from '../components/instrument/Panel';
import { Button } from '../components/instrument/Button';
import { LED } from '../components/instrument/LED';
import { Trace } from '../components/scopes/Trace';
import { Spectrum } from '../components/scopes/Spectrum';
import { Waterfall } from '../components/scopes/Waterfall';
import { ToneBars } from '../components/scopes/ToneBars';

const EMPTY = new Float32Array(0);
const W = 300;
const H = 100;

export function RxView() {
  const s = useStore((x) => x);
  // Worker telemetry ticks during ANY RX (live mic AND the DEMO software
  // loopback), so drive the spectrum/tone scopes from it; fall back to the
  // mic-loop Store fields when telemetry is absent.
  const tel = useTelemetry((t) => t);
  const spectrum = tel?.spectrum ?? s.fftSpectrum ?? EMPTY;
  const maxHz = tel?.spectrumMaxHz ?? 4000;
  const toneEnergies = tel?.toneEnergies ?? s.toneEnergies;
  const micDb = tel?.rmsDb ?? s.micLevel;
  const mic = s.debugSamples ?? EMPTY;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
      <Panel title="MIC IN">
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk }}>{micDb.toFixed(0)} dB</span>
          <LED on={s.isListening} label={s.isListening ? 'LIVE' : 'IDLE'} />
        </div>
        <Trace data={mic} color={T.cyan} width={W} height={H} />
        <Button onClick={() => window.dispatchEvent(new CustomEvent('eardrop-record'))}>
          {s.isListening ? '■ STOP' : '● LISTEN'}
        </Button>
      </Panel>

      <Panel title="SPECTRUM">
        <Spectrum bins={spectrum} maxHz={maxHz} width={W} height={H} />
        <div style={{ marginTop: 6 }}>
          <Waterfall bins={spectrum} width={W} height={70} />
        </div>
      </Panel>

      <Panel title="TONE ENERGY">
        <ToneBars energies={toneEnergies} width={W} height={H} />
      </Panel>

      <Panel title="DECODED FILES">
        {s.receivedFiles.length === 0 ? (
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.panelInk, opacity: 0.6 }}>
            (nothing received yet)
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontFamily: T.mono, fontSize: 11 }}>
            {s.receivedFiles.map((f, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <a href={f.url} download={f.name} style={{ color: T.phosphor }}>
                  {f.name}
                </a>{' '}
                <span style={{ color: T.panelInk, opacity: 0.6 }}>({f.size} B)</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

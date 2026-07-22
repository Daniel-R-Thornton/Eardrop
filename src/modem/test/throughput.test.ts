/**
 * OFDM end-to-end throughput benchmark.
 *
 * Full pipeline: TxEngine.transmitFile → RxEngine.feedSample, byte-exact
 * verification, payload-rate computed from generated audio duration.
 * Run after every throughput change; the [BENCH] log lines are the record.
 */
import { expect, test } from 'vitest';
import { TxEngine } from '../protocol/txEngine';
import { RxEngine, type ReceivedFile } from '../protocol/rxEngine';
import { ofdmSamples } from '../types';

const SAMPLE_RATE = 48000;
const PILOT_FREQ = 1900;

function makePayload(n: number): Uint8Array {
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) data[i] = (i * 131 + 7) & 0xff;
  return data;
}

function runTransfer(toneCount: number, payloadBytes: number): {
  received: ReceivedFile | null;
  audioSec: number;
} {
  const data = makePayload(payloadBytes);
  const tx = new TxEngine({
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount,
    useOFDM: true,
  } as ConstructorParameters<typeof TxEngine>[0]);
  const audio = tx.transmitFile('bench.bin', data);

  const rx = new RxEngine({
    sampleRate: SAMPLE_RATE,
    pilotFreqHz: PILOT_FREQ,
    toneCount,
    useOFDM: true,
  } as ConstructorParameters<typeof RxEngine>[0]);

  for (const s of audio) rx.feedSample(s);
  const { symSamples } = ofdmSamples(SAMPLE_RATE);
  for (let i = 0; i < symSamples * 8; i++) rx.feedSample(0);

  const received = rx.getFile();
  return { received, audioSec: audio.length / SAMPLE_RATE };
}

for (const toneCount of [16, 32]) {
  test(`OFDM throughput benchmark — ${toneCount} tones, 2000-byte file`, () => {
    const payloadBytes = 2000;
    const { received, audioSec } = runTransfer(toneCount, payloadBytes);

    expect(received, 'file should complete').not.toBeNull();
    expect(received!.data.length).toBe(payloadBytes);
    expect(Array.from(received!.data)).toEqual(Array.from(makePayload(payloadBytes)));

    const rate = payloadBytes / audioSec;
     
    console.log(
      `[BENCH] tones=${toneCount} payloadBytes=${payloadBytes} audioSec=${audioSec.toFixed(2)} rate=${rate.toFixed(1)} B/s`,
    );
    // Floor guards against silent regression; raise it as levers land.
    expect(rate).toBeGreaterThan(toneCount === 32 ? 150 : 75);
  });
}

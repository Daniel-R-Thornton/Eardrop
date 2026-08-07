import { describe, test, expect } from 'vitest';
import { RxEngine } from '../protocol/rxEngine';

/**
 * Regression: the chatter listener going deaf for 5 s right after the device's
 * own transmission, which is exactly the window a TEXT's ACK arrives in
 * (ROOM_TIMING.ackWindowMs ≈ 5.3 s). Hardware symptom: the phone sent one
 * broadcast TEXT, the PC decoded it and acked, and the phone decoded no ACK all
 * session — logs showed OFDM-TRAIN with pilotAmp=1.6e-4 (silence) immediately
 * after the phone's own [PLAY], then watchdogReset windows=201.
 *
 * Chirp sync is two-stage: `chirpDetected` latches when the correlator fires,
 * and a later CP-boundary probe completes the handoff and clears the latch.
 * `rearmForNextControlMessage` — called on unmute, whose whole job is to return
 * the engine to a clean WAITING state — cleared the buffers and the settle and
 * training counters but left the chirp latch set. Coming back from mute the
 * engine therefore still believed a chirp had just landed, and ran the boundary
 * probe against post-unmute room ring-out.
 */
describe('rearmForNextControlMessage clears the chirp latch', () => {
  /** A chatter-shaped listener: OFDM, fixed handshake band, chirp-only sync. */
  const makeListener = () => new RxEngine({
    useOFDM: true, bandHandshake: true, chirpOnlySync: true, role: 'chatter',
  } as ConstructorParameters<typeof RxEngine>[0]);

  /**
   * Put the engine in the exact state the mute interrupts: chirp correlator has
   * fired and latched, boundary probe has not yet run.
   *
   * Set directly rather than driven through the correlator on purpose — what is
   * under test is which fields `rearmForNextControlMessage` clears, not the
   * detector's sensitivity, and reproducing a detection over the air would make
   * this a test of the correlator instead.
   */
  const latchChirp = (rx: RxEngine): void => {
    const st = rx as unknown as Record<string, unknown>;
    st.chirpDetected = true;
    st.chirpEndSample = st.samplesSeen as number;
    st.chirpProbeTick = 0;
  };

  test('a latched chirp does not survive the re-arm', () => {
    const rx = makeListener();
    const st = rx as unknown as Record<string, unknown>;

    latchChirp(rx);
    expect(st.chirpDetected, 'test setup').toBe(true);

    rx.rearmForNextControlMessage();

    // The whole point of the re-arm is that chirp detection can run again, and
    // detection is gated off while the latch is set.
    expect(st.chirpDetected, 'chirp latch must not survive re-arm').toBe(false);
  });

  test('the stale chirp end-sample is cleared with it', () => {
    const rx = makeListener();
    const st = rx as unknown as Record<string, unknown>;
    latchChirp(rx);
    expect(st.chirpEndSample as number).toBeGreaterThanOrEqual(0);

    rx.rearmForNextControlMessage();

    // Left set, this is an ABSOLUTE sample index from before the mute, so
    // `samplesSeen - chirpEndSample >= sps*2` is true immediately and the
    // boundary probe fires on the first post-unmute buffer fill.
    expect(st.chirpEndSample, 'stale chirp anchor must not survive re-arm').toBe(-1);
  });

  test('re-arm on silence does not enter settle/training', () => {
    const rx = makeListener();
    const st = rx as unknown as Record<string, unknown>;
    latchChirp(rx);

    rx.rearmForNextControlMessage();

    // Post-unmute the room is ringing, not carrying a message. Feed silence and
    // confirm the engine stays in WAITING instead of training a channel
    // estimate on it (the pilotAmp=1.6e-4 lock seen on hardware).
    for (let i = 0; i < 48000; i++) rx.feedSample(0);

    expect(st.ofdmSettleSymbols, 'must not consume settle symbols on silence').toBe(0);
    expect(st.ofdmTrainingSymbols, 'must not train on silence').toBe(0);
  });
});

/**
 * A SECOND, independent defect in the same area, and one the chirp-latch fix
 * above does not touch.
 *
 * The sync-loss watchdog resets eight pieces of state — RxState, sync frames,
 * the noise EMA, settle and training counters, MER, the link profile and both
 * buffers — but not `ofdmWindowsSinceDetect`, the counter that *fired* it.
 * Coming out of the reset the counter is still one past the limit, so the very
 * next window increments it to limit+2 and trips the watchdog again. It is a
 * ratchet, not a one-off: once over the line the engine emits a reset on every
 * single window until something unrelated clears the counter.
 *
 * Hardware shows it directly. In `logs/2026-08-07/dev-o8m2a7-d5dc7l.log` the
 * handshake listener burns ten consecutive windows — `windows=601` through
 * `windows=610` with no other line between them — and the chatter listener
 * ratchets 201..205 in the same session; the PC end of that session
 * (`dev-ih9jof-vqu8b4.log`) shows chatter 201..211 interleaved with hsListener
 * 601..604. Each of those lines is a full re-entry into WAITING, and the noise
 * EMA is re-seeded every time, so the engine cannot settle a detection
 * threshold while the ratchet runs.
 *
 * The reset IS the "give up and start looking again" event, so it is precisely
 * the point at which the windows-since-detect count should return to zero.
 */
describe('the sync-loss watchdog does not ratchet', () => {
  /** A file-shaped engine: no onControlMessage, so the 15 s watchdog limit. */
  const makeEngine = () => new RxEngine({
    useOFDM: true, bandHandshake: true, chirpOnlySync: true, role: 'fileTarget',
  } as ConstructorParameters<typeof RxEngine>[0]);

  /**
   * Park the engine one window short of tripping, in the decode state the
   * watchdog guards. Set directly for the same reason as `latchChirp` above:
   * the subject is which fields the reset clears, and driving 200 windows of
   * real audio through the correlator would test the detector instead.
   */
  const armWatchdog = (rx: RxEngine): number => {
    const st = rx as unknown as Record<string, unknown>;
    const limit = st.OFDM_WATCHDOG_WINDOWS as number;
    st.state = 2; // RxState.FRAMES — the state the watchdog fires out of
    st.ofdmWatchdogGraceWindows = 0;
    st.ofdmWindowsSinceDetect = limit;
    return limit;
  };

  test('the reset clears the counter that fired it', () => {
    const rx = makeEngine();
    const st = rx as unknown as Record<string, unknown>;
    const limit = armWatchdog(rx);
    expect(st.ofdmWindowsSinceDetect, 'test setup').toBe(limit);

    // One window of audio is all it takes: the counter is already AT the limit,
    // so the next increment is over it. Silence is enough — reaching the
    // watchdog needs a processed window, not a decodable one.
    for (let i = 0; i < 48000; i++) rx.feedSample(0);

    // The watchdog really did fire, rather than the window path never being
    // reached (which would make the assertion below vacuously pass).
    expect(st.state, 'watchdog should have dropped the engine to WAITING').toBe(0);
    expect(
      st.ofdmWindowsSinceDetect as number,
      'windows-since-detect must not survive the reset it triggered',
    ).toBe(0);
  });
});

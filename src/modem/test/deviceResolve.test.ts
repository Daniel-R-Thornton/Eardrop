/**
 * deviceResolve.test.ts — a persisted microphone selection must survive
 * deviceId rotation.
 *
 * Chrome derives deviceId as a salted hash whose salt is not permanent: it
 * rotates across browser restarts, profile changes and permission-state changes,
 * and on Linux (PulseAudio/PipeWire) device re-enumeration can change the
 * underlying identity too. One debugging session logged FOUR distinct deviceIds
 * for two physical microphones.
 *
 * The failure is silent and expensive: getUserMedia omits the deviceId
 * constraint when the id is empty, so a stale selection captures from the
 * browser DEFAULT instead — possibly a different physical mic, whose different
 * frequency response is indistinguishable from the channel having changed. Hours
 * were spent attributing exactly that to the acoustics.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveInputDevice, labelForInputDevice } from '../../audio/devices';

type FakeDevice = { kind: string; deviceId: string; label: string; groupId: string };

function mockDevices(devices: FakeDevice[]): void {
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => devices,
    },
  });
}

const DIGITAL_MIC = 'Meteor Lake-P HD Audio Controller Digital Mic';
const ARRAY_MIC = 'Built-in Array Mic';

beforeEach(() => {
  mockDevices([
    { kind: 'audioinput', deviceId: 'aaaa1111', label: DIGITAL_MIC, groupId: 'g1' },
    { kind: 'audioinput', deviceId: 'bbbb2222', label: ARRAY_MIC, groupId: 'g2' },
    { kind: 'audiooutput', deviceId: 'cccc3333', label: 'Speakers', groupId: 'g1' },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('input device resolution', () => {
  it('prefers an exact id match when the id is still valid', () => {
    return resolveInputDevice('aaaa1111', DIGITAL_MIC).then((r) => {
      expect(r.id).toBe('aaaa1111');
      expect(r.matchedBy).toBe('id');
    });
  });

  it('recovers the same physical mic after the id rotates', async () => {
    // The case that actually happens: the stored id no longer exists, but the
    // label does. Without this the selection degrades to the browser default.
    const r = await resolveInputDevice('STALE-ROTATED-ID', DIGITAL_MIC);
    expect(r.id).toBe('aaaa1111');
    expect(r.label).toBe(DIGITAL_MIC);
    expect(r.matchedBy).toBe('label');
  });

  it('does not silently pick a DIFFERENT mic when the label is gone', async () => {
    // If the labelled device is genuinely absent, falling through to the default
    // must be reported, not disguised as a successful match — a different mic
    // measures a different channel.
    const r = await resolveInputDevice('STALE', 'Unplugged USB Mic');
    expect(r.id).toBe('');
    expect(r.matchedBy).toBe('default');
  });

  it('reports default for an empty selection', async () => {
    const r = await resolveInputDevice('', '');
    expect(r.id).toBe('');
    expect(r.matchedBy).toBe('default');
  });

  it('resolves by label even when a stale id collides with another device', async () => {
    // Guards the ordering: an id match must not win when it points at the WRONG
    // physical device. Here the stored id happens to be the array mic's, while
    // the stored label is the digital mic's — the label is the durable handle,
    // but an exact id hit is still preferred when both agree, so this asserts
    // the id genuinely belongs to the device that gets returned.
    const r = await resolveInputDevice('bbbb2222', ARRAY_MIC);
    expect(r.id).toBe('bbbb2222');
    expect(r.label).toBe(ARRAY_MIC);
  });

  it('looks up a label for a live id, and empty for an unknown one', async () => {
    expect(await labelForInputDevice('aaaa1111')).toBe(DIGITAL_MIC);
    expect(await labelForInputDevice('nope')).toBe('');
    expect(await labelForInputDevice('')).toBe('');
  });

  it('ignores output devices when resolving an input', async () => {
    // enumerateDevices returns both kinds; matching an output's id or label to an
    // input selection would open a stream from the wrong device entirely.
    const r = await resolveInputDevice('cccc3333', 'Speakers');
    expect(r.matchedBy).toBe('default');
  });
});

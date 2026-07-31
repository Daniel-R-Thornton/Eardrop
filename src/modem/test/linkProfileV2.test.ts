/**
 * linkProfileV2.test.ts — profile payload v2: carries the TARGET BAND
 * (pilotFreqHz, toneStartHz) and a band-hop flag, so a receiver listening on
 * the fixed handshake band can learn everything it needs from the air.
 *
 * v1 payloads (no band fields) must still parse — band fields read as 0 and
 * the hop flag absent.
 */
import { describe, expect, it } from 'vitest';
import { crc32 } from '../../crc32';
import {
  packLinkProfile,
  parseLinkProfile,
  DEFAULT_LINK_PROFILE,
  LINK_PROFILE_FLAG_BAND_HOP,
  QamOrder,
} from '../protocol/linkProfile';
import { PAYLOAD_DATA_SIZE } from '../protocol/atomicFrame';

describe('link profile v2', () => {
  it('round-trips band fields and the hop flag', () => {
    const p = {
      ...DEFAULT_LINK_PROFILE(32),
      flags: LINK_PROFILE_FLAG_BAND_HOP,
      pilotFreqHz: 6300,
      toneStartHz: 600,
      qamMap: new Array(32).fill(QamOrder.QAM16),
    };
    const parsed = parseLinkProfile(packLinkProfile(p));
    expect(parsed).not.toBeNull();
    expect(parsed!.pilotFreqHz).toBe(6300);
    expect(parsed!.toneStartHz).toBe(600);
    expect(parsed!.flags & LINK_PROFILE_FLAG_BAND_HOP).toBeTruthy();
    expect(parsed!.toneCount).toBe(32);
    expect(parsed!.qamMap).toEqual(new Array(32).fill(QamOrder.QAM16));
  });

  it('still parses a v1 payload (no band fields)', () => {
    // Hand-build the v1 layout: [ver=1][flags][eccT][cpId][toneCount][qamMap][crc32]
    const toneCount = 8;
    const mapLen = Math.ceil((toneCount * 2) / 8);
    const buf = new Uint8Array(PAYLOAD_DATA_SIZE);
    buf[0] = 1;
    buf[1] = 0;
    buf[2] = 6;
    buf[3] = 0;
    buf[4] = toneCount;
    // qamMap all-QPSK = zero bytes; crc over header+map
    const preCrcLen = 5 + mapLen;
    const c = crc32(buf.slice(0, preCrcLen));
    buf[preCrcLen] = c & 0xff;
    buf[preCrcLen + 1] = (c >> 8) & 0xff;
    buf[preCrcLen + 2] = (c >> 16) & 0xff;
    buf[preCrcLen + 3] = (c >> 24) & 0xff;

    const parsed = parseLinkProfile(buf);
    expect(parsed).not.toBeNull();
    expect(parsed!.ver).toBe(1);
    expect(parsed!.toneCount).toBe(toneCount);
    expect(parsed!.pilotFreqHz).toBe(0);
    expect(parsed!.toneStartHz).toBe(0);
    expect(parsed!.flags & LINK_PROFILE_FLAG_BAND_HOP).toBe(0);
  });

  it('rejects a corrupted v2 payload', () => {
    const packed = packLinkProfile({
      ...DEFAULT_LINK_PROFILE(16),
      pilotFreqHz: 1850,
      toneStartHz: 5050,
    });
    packed[6] ^= 0xff;
    expect(parseLinkProfile(packed)).toBeNull();
  });
});

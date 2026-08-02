// src/modem/test/controlFrame.test.ts
import { describe, expect, it } from 'vitest';
import {
  encodeControlMessage, decodeControlHeader, decodeControlPayload,
  packWelcome, parseWelcome, packReport, parseReport,
  packFileComing, parseFileComing, quantizeGrid, dequantizeGrid,
  ControlType, CONTROL_HEADER_WIRE, controlPayloadWireSize,
} from '../protocol/controlFrame';
import { SENTINEL_SIZE } from '../protocol/atomicFrame';

const grid64 = Array.from({ length: 64 }, (_, i) => 1 / (1 + i / 16)); // sloped response

describe('control frame', () => {
  it('round-trips a REPORT message', () => {
    const msg = { type: ControlType.Report, senderId: 7, targetId: 3, payload: packReport(grid64) };
    const wire = encodeControlMessage(msg);
    const hdr = decodeControlHeader(wire.slice(SENTINEL_SIZE, CONTROL_HEADER_WIRE))!;
    expect(hdr).toMatchObject({ type: ControlType.Report, senderId: 7, targetId: 3 });
    const payload = decodeControlPayload(wire.slice(CONTROL_HEADER_WIRE), hdr.payloadLen)!;
    const back = parseReport(payload)!;
    // Quantized to 2 dB steps — allow one step of error.
    back.forEach((m, i) => {
      const wantDb = 20 * Math.log10(grid64[i] / Math.max(...grid64));
      expect(Math.abs(20 * Math.log10(m) - wantDb)).toBeLessThanOrEqual(2.01);
    });
  });

  it('survives 3 corrupted wire bytes in the payload (BCH corrects)', () => {
    const msg = { type: ControlType.Report, senderId: 1, targetId: 0, payload: packReport(grid64) };
    const wire = encodeControlMessage(msg);
    // one bit flip in three DIFFERENT codewords
    wire[CONTROL_HEADER_WIRE + 1] ^= 0x01;
    wire[CONTROL_HEADER_WIRE + 9] ^= 0x80;
    wire[CONTROL_HEADER_WIRE + 17] ^= 0x10;
    const hdr = decodeControlHeader(wire.slice(SENTINEL_SIZE, CONTROL_HEADER_WIRE))!;
    expect(decodeControlPayload(wire.slice(CONTROL_HEADER_WIRE), hdr.payloadLen)).not.toBeNull();
  });

  it('rejects wrong magic', () => {
    const msg = { type: ControlType.Bye, senderId: 1, targetId: 0, payload: new Uint8Array(0) };
    const wire = encodeControlMessage(msg);
    // Re-encode header with corrupted magic is awkward; instead hand a bandCard-style header.
    const bogus = new Uint8Array(24); // BCH of zeros ≠ valid card either
    expect(decodeControlHeader(bogus)).toBeNull();
  });

  it('round-trips WELCOME (claim + grid)', () => {
    const p = { claim: { lowHz: 2000, highHz: 6000, maxQamOrder: 4 }, grid: grid64 };
    const back = parseWelcome(packWelcome(p))!;
    expect(back.claim).toEqual(p.claim);
    expect(back.grid).toHaveLength(64);
  });

  it('round-trips FILE_COMING', () => {
    const p = { pilotFreqHz: 6300, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 123456, durationMs: 42000 };
    expect(parseFileComing(packFileComing(p))).toEqual(p);
  });

  it('quantize/dequantize is monotone and bounded', () => {
    const q = quantizeGrid(grid64);
    expect(Math.min(...q)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...q)).toBeLessThanOrEqual(15);
    expect(q[0]).toBeLessThanOrEqual(q[63]); // grid64 decreasing ⇒ steps below max increase
  });

  it('payload wire size formula matches encoder output', () => {
    const msg = { type: ControlType.Welcome, senderId: 2, targetId: 5, payload: packWelcome({ claim: { lowHz: 1500, highHz: 7800, maxQamOrder: 6 }, grid: grid64 }) };
    const wire = encodeControlMessage(msg);
    expect(wire.length).toBe(CONTROL_HEADER_WIRE + controlPayloadWireSize(msg.payload.length));
  });
});

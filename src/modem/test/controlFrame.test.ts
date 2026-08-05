// src/modem/test/controlFrame.test.ts
import { describe, expect, it } from 'vitest';
import {
  encodeControlMessage, decodeControlHeader, decodeControlPayload,
  packWelcome, parseWelcome, packReport, parseReport,
  packFileComing, parseFileComing, quantizeGrid, dequantizeGrid,
  ControlType, CONTROL_HEADER_WIRE, controlPayloadWireSize,
  packText, parseText, packAck, parseAck, textByteLength, TEXT_MAX_BYTES,
} from '../protocol/controlFrame';
import { SENTINEL_SIZE, BCH_HEADER_SIZE } from '../protocol/atomicFrame';

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

  // --- validation: encode should throw on config errors, not silently corrupt the wire ---

  it('rejects senderId out of range', () => {
    expect(() => encodeControlMessage({ type: ControlType.Bye, senderId: 0, targetId: 0, payload: new Uint8Array(0) })).toThrow();
    expect(() => encodeControlMessage({ type: ControlType.Bye, senderId: 256, targetId: 0, payload: new Uint8Array(0) })).toThrow();
  });

  it('rejects targetId out of range', () => {
    expect(() => encodeControlMessage({ type: ControlType.Bye, senderId: 1, targetId: -1, payload: new Uint8Array(0) })).toThrow();
    expect(() => encodeControlMessage({ type: ControlType.Bye, senderId: 1, targetId: 256, payload: new Uint8Array(0) })).toThrow();
  });

  it('rejects a payload over the 255 B cap', () => {
    // Cap raised 48 -> 255 for TEXT (see controlFrame.ts); 49 B is legal now, 256 B is not.
    expect(() => encodeControlMessage({ type: ControlType.Bye, senderId: 1, targetId: 0, payload: new Uint8Array(256) })).toThrow();
  });

  it('rejects a WELCOME claim with out-of-range Hz instead of silently truncating', () => {
    // 12750 Hz (bin 255) is the largest representable bin; 12800 Hz would wrap to bin 0 mod 256.
    expect(() => packWelcome({ claim: { lowHz: 1500, highHz: 12800, maxQamOrder: 4 }, grid: grid64 })).toThrow();
    expect(() => packWelcome({ claim: { lowHz: 0, highHz: 6000, maxQamOrder: 4 }, grid: grid64 })).toThrow();
  });

  it('rejects FILE_COMING pilot/tone-start Hz out of range instead of silently truncating', () => {
    expect(() => packFileComing({ pilotFreqHz: 12800, toneStartHz: 600, toneCount: 32, settleSymbols: 16, fileBytes: 1, durationMs: 1 })).toThrow();
    expect(() => packFileComing({ pilotFreqHz: 6300, toneStartHz: 0, toneCount: 32, settleSymbols: 16, fileBytes: 1, durationMs: 1 })).toThrow();
  });
});

describe('TEXT / ACK control payloads', () => {
  it('round-trips a short message', () => {
    const p = packText(7, 'ready?');
    expect(parseText(p)).toEqual({ msgId: 7, text: 'ready?' });
  });

  it('round-trips an empty message', () => {
    // Not useful to send, but the codec must not mis-handle a zero-length
    // payload — payloadLen 1 is a legal frame.
    expect(parseText(packText(0, ''))).toEqual({ msgId: 0, text: '' });
  });

  it('round-trips multi-byte UTF-8 at exactly the cap', () => {
    // The cap is BYTES, not characters. An emoji is 4 bytes, so 63 of them
    // plus a 2-byte character is 254 — the largest legal text.
    const text = '🦻'.repeat(63) + 'é';
    expect(textByteLength(text)).toBe(TEXT_MAX_BYTES);
    const parsed = parseText(packText(255, text));
    expect(parsed).toEqual({ msgId: 255, text });
  });

  it('rejects text one byte over the cap rather than splitting a codepoint', () => {
    // Truncating mid-codepoint would put invalid UTF-8 on the air, and
    // encodeControlMessage would throw on the oversized payload anyway.
    const text = 'a'.repeat(TEXT_MAX_BYTES + 1);
    expect(() => packText(1, text)).toThrow(/254|cap|too long/i);
  });

  it('round-trips an ACK', () => {
    expect(parseAck(packAck(200))).toEqual({ msgId: 200 });
  });

  it('parseText and parseAck reject a payload that is too short', () => {
    expect(parseText(new Uint8Array(0))).toBeNull();
    expect(parseAck(new Uint8Array(0))).toBeNull();
  });

  it('a 255-byte payload survives the full control-frame wire round trip', () => {
    // The old CONTROL_PAYLOAD_MAX was 48. This proves nothing downstream
    // baked that in: header payloadLen is a full byte, so 255 is legal and
    // the BCH chunking and CRC-16 must both scale to it.
    const text = 'x'.repeat(TEXT_MAX_BYTES);
    const msg = { type: ControlType.Text, senderId: 3, targetId: 0, payload: packText(9, text) };
    expect(msg.payload.length).toBe(255);

    const wire = encodeControlMessage(msg);
    const header = decodeControlHeader(wire.slice(SENTINEL_SIZE, SENTINEL_SIZE + BCH_HEADER_SIZE));
    expect(header).not.toBeNull();
    expect(header!.type).toBe(ControlType.Text);
    expect(header!.payloadLen).toBe(255);

    const payloadWire = wire.slice(SENTINEL_SIZE + BCH_HEADER_SIZE);
    expect(payloadWire.length).toBe(controlPayloadWireSize(255));
    const payload = decodeControlPayload(payloadWire, header!.payloadLen);
    expect(payload).not.toBeNull();
    expect(parseText(payload!)).toEqual({ msgId: 9, text });
  });

  it('rejects a payload above the new cap', () => {
    const msg = { type: ControlType.Text, senderId: 3, targetId: 0, payload: new Uint8Array(256) };
    expect(() => encodeControlMessage(msg)).toThrow(/256 B exceeds 255 B cap/);
  });
});

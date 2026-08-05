/**
 * How long a text message takes to transmit, in seconds.
 *
 * Shown per message because the wait is the feature's defining property, not
 * an implementation detail: a group message with read receipts is roughly
 * 8-14 s of airtime in a three-device room and the room is blocked
 * throughout. A bare spinner over that reads as a freeze.
 *
 * DERIVED, not copied. Every term comes from the constant the transmitter
 * itself uses, so a change to the frame layout or the handshake band shows up
 * here automatically rather than silently making this display wrong.
 */
import {
  CONTROL_HEADER_WIRE, controlPayloadWireSize, textByteLength,
} from '../../modem/protocol/controlFrame';
import { OFDM_HANDSHAKE, OFDM_SYMBOL_MS, OFDM_CP_MS } from '../../modem/types';

/** Bytes per OFDM symbol on the handshake band: QPSK puts 2 bits on each
 *  tone, so 4 tones carry a byte. Same expression the band-card sizing uses. */
const BYTES_PER_SYMBOL = Math.max(1, Math.floor(OFDM_HANDSHAKE.toneCount / 4));

/** One symbol is its FFT window plus the cyclic prefix. */
const SYMBOL_MS = OFDM_SYMBOL_MS + OFDM_CP_MS;

/**
 * Chirp + settle + training ahead of the payload. A wire constant of the
 * handshake segment, and the reason a two-character message costs ~2 s rather
 * than ~0.5 s.
 */
const PREAMBLE_MS = 1500;

/** The 1-byte msgId a TEXT payload carries ahead of the text itself. */
const MSG_ID_BYTES = 1;

export function textAirSeconds(text: string): number {
  const payloadLen = MSG_ID_BYTES + textByteLength(text);
  const wireBytes = CONTROL_HEADER_WIRE + controlPayloadWireSize(payloadLen);
  const symbols = Math.ceil(wireBytes / BYTES_PER_SYMBOL);
  return (symbols * SYMBOL_MS + PREAMBLE_MS) / 1000;
}

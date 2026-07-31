/**
 * whiten.ts — reversible payload whitening (data scrambler).
 *
 * XORs frame bytes with a position-indexed pseudo-random keystream. Adds no
 * bits, loses no information, costs no SNR: the receiver regenerates the same
 * keystream from the same seed and XORs again to recover the original bytes
 * exactly. It changes the STATISTICS of what goes on the wire, nothing else.
 *
 * WHY this modem needs it. Three separate problems all trace back to payload
 * bytes not being uniformly distributed, and a short payload zero-filling the
 * rest of the frame is the worst case:
 *
 *  1. Coherent padding. Identical payload bytes map every tone to the SAME
 *     constellation point, so the carriers leave the modulator phase-aligned
 *     and the symbol reaches the full coherent peak — measured 1.19 at the
 *     player's clip guard on a 12-byte payload at 32 tones. That single case
 *     forces the transmit scale back to the worst-case bound and costs ~7 dB of
 *     level at 32 tones (see OFDMQPSKModulator's scale derivation).
 *
 *  2. Blind gain estimation. Constellations are normalized so
 *     E[|point|^2] == 1, which lets the receiver derive its amplitude reference
 *     from the data itself instead of from the pilot — necessary because
 *     laptop mic arrays gate a sustained pilot tone into the noise floor. That
 *     identity holds only for uniformly distributed symbols: on a noiseless
 *     loopback with a real payload the measured mean power was 1.7, not 1.0.
 *
 *  3. Stationarity. Long runs of identical symbols look like stationary noise
 *     to adaptive microphone DSP, which then suppresses them.
 *
 * Position-indexed rather than streaming, so each byte's keystream depends only
 * on its offset in the frame. A frame decoded standalone (which is how every
 * frame arrives — they are independently detected by sentinel search) can
 * therefore always be de-whitened, with no dependence on preceding frames.
 */

/**
 * Keystream seed. Any non-zero value works; this one is arbitrary.
 *
 * Changing it is a WIRE-FORMAT BREAK — both ends must use the same value.
 */
const WHITEN_SEED = 0x5a5a;

/**
 * Keystream byte for a given frame offset.
 *
 * A 16-bit Galois LFSR (x^16 + x^14 + x^13 + x^11 + 1, the CCITT polynomial)
 * advanced eight times per byte and re-seeded per offset. Re-seeding rather than
 * streaming keeps each byte independent of its neighbours, which is what makes
 * the function usable on an arbitrary sub-range.
 *
 * The offset is mixed into the initial state so the sequence differs per
 * position; without that, every byte would get the same keystream value and
 * uniform payload would stay uniform.
 */
function keystreamByte(offset: number): number {
  let state = (WHITEN_SEED ^ ((offset * 0x9e37) & 0xffff)) & 0xffff;
  if (state === 0) state = WHITEN_SEED; // an all-zero LFSR state is a fixed point
  let out = 0;
  for (let bit = 0; bit < 8; bit++) {
    const lsb = state & 1;
    state >>>= 1;
    if (lsb) state ^= 0xb400; // taps for the CCITT polynomial, Galois form
    out = (out << 1) | lsb;
  }
  return out & 0xff;
}

/** Precomputed keystream, long enough for any frame this protocol produces. */
const KEYSTREAM_LENGTH = 512;
const KEYSTREAM: Uint8Array = (() => {
  const ks = new Uint8Array(KEYSTREAM_LENGTH);
  for (let i = 0; i < KEYSTREAM_LENGTH; i++) ks[i] = keystreamByte(i);
  return ks;
})();

/**
 * XOR `bytes` in place with the keystream, starting at keystream index
 * `offset`. Self-inverse: applying it twice restores the input.
 *
 * `offset` is the byte's position within the FRAME, not within `bytes`, so a
 * caller whitening only part of a frame passes where that part starts. Getting
 * this wrong de-whitens with a shifted keystream and produces garbage that
 * still passes the sentinel check, so callers should use whitenFrameBody().
 */
export function whitenInPlace(bytes: Uint8Array, offset = 0): void {
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] ^= KEYSTREAM[(offset + i) % KEYSTREAM_LENGTH];
  }
}

/**
 * Keystream byte at `offset` — the filler for tone slots PAST the end of a
 * frame, in place of the zero bytes/bits both modulation paths used to emit.
 *
 * Zero fill is the one coherent case whitening did not cover, because those
 * slots are not frame bytes: every padded tone landed on constellation index 0,
 * i.e. the same point, so they summed phase-aligned. Measured on identical
 * frames differing only in whether the last symbol was full — last-symbol peak
 * 0.52-0.68 exact-fit against 1.06-2.31 padded, worst at 48 tones/64-QAM. That
 * single symbol is what forces the TX scale down for the whole transmission.
 *
 * Same keystream as the body so the filler is statistically the same as data
 * (and so there is one generator, not two). The receiver discards these slots —
 * frame length is known — but they still pass through the sentinel search, so
 * whiten.test.ts asserts no sentinel occurs WITHIN the filler at any offset. A
 * sentinel straddling the boundary (one or two real frame bytes plus filler) is
 * not excludable and is left alone deliberately: it needs specific whitened
 * frame bytes, so it is a ~2^-16 event, the same as the scanner already sees in
 * inter-frame noise, and it costs one decode attempt that fails BCH/RS.
 */
export function fillerByte(offset: number): number {
  return KEYSTREAM[offset % KEYSTREAM_LENGTH];
}

/**
 * Whiten (or de-whiten — it is the same operation) a frame's body in place,
 * leaving the leading sentinel untouched.
 *
 * The sentinel MUST stay in the clear: the receiver locates frames by searching
 * the raw byte stream for it, before it knows anything about frame boundaries,
 * so there is no way to de-whiten it first.
 */
export function whitenFrameBody(frame: Uint8Array, sentinelSize: number): void {
  if (frame.length <= sentinelSize) return;
  whitenInPlace(frame.subarray(sentinelSize), sentinelSize);
}

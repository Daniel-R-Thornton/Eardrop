/**
 * The dlog tag allow-list applied while the room is on screen (see
 * `dlogSetFocus`). Extracted from app.ts so the invariant below can be tested:
 * app.ts is the entry module and importing it runs the whole app.
 *
 * Tags worth seeing while the room is on screen: what the room decided, what
 * control traffic was demodulated, the audio devices behind both, and — for a
 * file transfer — whether the payload actually landed.
 *
 * WHY THE OUTCOME TAGS ARE NOT OPTIONAL
 *
 * This list is an allow-list, and `dlog` drops a non-matching tag BEFORE the
 * ring buffer the log reporter reads (dlog.ts, the `focusTags` early return
 * sits above `recordPush`). So a tag missing from here is not merely quiet in
 * the console — it cannot appear in a hardware log at all, ever.
 *
 * That cost three debugging sessions. `RX-FILE` (the "the file arrived" line)
 * was added specifically so a successful receive would stop looking identical
 * to a dead one, and it was invisible the whole time because it was not listed
 * here. Every room-mode log therefore ended a transfer the same way — band
 * card, band hop, silence — whether the transfer worked or died, and a
 * band-selection theory got built on top of that silence.
 *
 * The rule: if a line is how you tell a completed transfer from a failed one,
 * it belongs in ROOM_LOG_TAGS. Per-symbol firehose tags (OFDM-MISS, WARBLE,
 * PREAMBLE, GUARD, CAL) stay out — they bury everything else and the ring
 * holds only DLOG_RING_MAX lines between pushes.
 */
export const ROOM_LOG_TAGS: readonly string[] = [
  'ROOM', 'CHATTER-RX', 'REC', 'REC-CAP', 'REC-ERR', 'PLAY', 'APP', 'UI',
  // The decode ladder for a control message, needed to tell "heard nothing"
  // from "heard it and could not read it": OFDM-SYNC = the chirp was found,
  // RX-OFDM cardInvalid = a sentinel arrived but its header would not decode.
  // These are noisy during a file transfer but near-silent while a room idles,
  // which is exactly when we need them.
  'OFDM-SYNC', 'RX-OFDM',
  // The file-transfer outcome ladder. After the band hop these are the only
  // things that distinguish the failure modes from each other:
  //   OFDM-TRAIN  — settle/training symbols consumed on the target band
  //   OFDM-DEMOD  — enteringDataPhase: training finished, payload started
  //   RX-FRAME    — a frame was scanned/assembled (per frame, not per symbol)
  //   RX-FAIL     — a frame arrived and failed CRC ("corrupt" vs "absent")
  //   OFDM-STMER  — per-frame MER, the signal-quality number a band theory needs
  //   RX-PROFILE  — link profile / bit-loading actually applied
  //   RX-COMP     — payload decompressed
  //   RX-FILE     — the file arrived. The success signal.
  'OFDM-TRAIN', 'OFDM-DEMOD', 'RX-FRAME', 'RX-FAIL', 'OFDM-STMER',
  'RX-PROFILE', 'RX-COMP', 'RX-FILE',
];

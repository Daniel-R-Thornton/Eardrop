import { describe, test, expect } from 'vitest';
import { ROOM_LOG_TAGS } from './roomLogTags';

/**
 * These tests exist because dlog's focus list is an ALLOW-list that drops
 * non-matching tags before the reporter's ring buffer. A tag missing here is
 * unloggable on hardware, which is indistinguishable from the event never
 * happening — and that ambiguity is what sent a previous investigation after
 * band selection on the strength of a silence it had caused itself.
 */
describe('ROOM_LOG_TAGS', () => {
  test('carries the room control-plane story', () => {
    for (const tag of ['ROOM', 'CHATTER-RX', 'REC', 'PLAY', 'APP', 'UI']) {
      expect(ROOM_LOG_TAGS, `${tag} explains what the room did`).toContain(tag);
    }
  });

  test('can distinguish a completed file transfer from a failed one', () => {
    // RX-FILE is the only positive "the payload landed" line. Without it a
    // successful receive and a dead one both end as: band card, hop, silence.
    expect(
      ROOM_LOG_TAGS,
      'RX-FILE is the success signal — without it success looks like failure',
    ).toContain('RX-FILE');
  });

  test('covers the post-band-hop decode ladder', () => {
    // Each of these isolates a different failure mode between "hopped to the
    // negotiated band" and "file assembled". Missing any one of them collapses
    // several distinct outcomes into the same empty log.
    for (const tag of ['OFDM-TRAIN', 'OFDM-DEMOD', 'RX-FRAME', 'RX-FAIL']) {
      expect(ROOM_LOG_TAGS, `${tag} isolates a post-hop failure mode`).toContain(tag);
    }
  });

  test('excludes the per-symbol firehose tags', () => {
    // The ring holds a bounded number of lines between pushes; a per-symbol tag
    // evicts the very lines above. OFDM-MISS fires on every missed sync window.
    for (const tag of ['OFDM-MISS', 'WARBLE', 'PREAMBLE', 'GUARD', 'CAL']) {
      expect(ROOM_LOG_TAGS, `${tag} is per-symbol and would evict the rest`).not.toContain(tag);
    }
  });

  test('has no duplicate entries', () => {
    expect([...new Set(ROOM_LOG_TAGS)]).toHaveLength(ROOM_LOG_TAGS.length);
  });
});

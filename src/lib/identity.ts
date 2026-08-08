// src/lib/identity.ts
/**
 * Who this device is: a human-readable nickname and a stable wire id.
 *
 * Both are persisted in localStorage, because both previously changed on every
 * reload and that made a room unreadable across a debugging session. The room
 * graph labelled nodes with the bare hex of an 8-bit id that was re-rolled at
 * every join, so the same phone leaving and rejoining looked like a different
 * peer, and nothing anywhere said which physical device a node was.
 *
 * Storage is always wrapped: localStorage throws on access in a partitioned or
 * storage-blocked context. Losing persistence must degrade to
 * per-session-random — the old behaviour — never take the app down.
 */

const NICKNAME_KEY = 'eardrop.nickname';
const DEVICE_ID_KEY = 'eardrop.deviceId';

/**
 * UTF-8 byte cap on a nickname.
 *
 * This is an airtime budget, not a UI preference. The nickname rides in the
 * WELCOME payload, and control messages are BCH-coded in 3-byte chunks where a
 * single uncorrectable chunk loses the WHOLE message
 * (`bchDecodeChunks` returns null). A bare 35-byte WELCOME is 13 chunks; 12
 * more bytes takes it to 17, so a long name buys a prettier label at the cost
 * of making the message that carries it likelier to be lost outright on a
 * marginal acoustic link. 12 bytes holds any reasonable device name
 * ("desk-pc", "pixel-8") and keeps that growth bounded.
 *
 * Counted in BYTES, not characters — an emoji is 4.
 */
export const NICKNAME_MAX_BYTES = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Read a key, treating a throwing or absent store as "nothing stored". */
function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write a key; a store that refuses the write is not an error worth raising. */
function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* storage blocked — identity degrades to per-session, app carries on */
  }
}

/**
 * A coarse, human-readable name for this browser/OS, e.g. `chrome-android`.
 *
 * Deliberately coarse: it is a fallback label and a log filename token, whose
 * job is to let someone tell the phone's log from the PC's at a glance. Version
 * numbers would make it longer without making it more useful.
 *
 * Order matters. Edge, Opera and most Android browsers all put "Chrome" in
 * their UA, so specific names must be tested first, and Safari last because
 * every WebKit-shell UA contains "Safari".
 */
export function uaLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const os = /Android/i.test(ua) ? 'android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'ios'
      : /Windows/i.test(ua) ? 'windows'
        : /Mac OS X/i.test(ua) ? 'macos'
          : /Linux/i.test(ua) ? 'linux'
            : 'os';
  const browser = /Edg\//.test(ua) ? 'edge'
    : /OPR\//.test(ua) ? 'opera'
      : /SamsungBrowser/i.test(ua) ? 'samsung'
        : /Firefox\//.test(ua) ? 'firefox'
          : /Chrome\//.test(ua) ? 'chrome'
            : /Safari\//.test(ua) ? 'safari'
              : 'browser';
  return `${browser}-${os}`;
}

/**
 * Normalize a user-supplied nickname to something safe to put on the wire, in
 * a filename, and in a log line.
 *
 * Restricted to `[A-Za-z0-9_-]` and lowercased for the same reason the log
 * endpoint sanitizes its path components: these strings end up concatenated
 * into filenames and log output, and a nickname is the one field here a user
 * types freely. Whitespace becomes `-` rather than vanishing, so "desk pc"
 * reads as "desk-pc" instead of "deskpc".
 *
 * Returns '' for input that survives none of this, which callers treat as
 * "no nickname set" rather than storing an empty name.
 */
export function sanitizeNickname(raw: string): string {
  const cleaned = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return truncateToBytes(cleaned, NICKNAME_MAX_BYTES);
}

/**
 * Cut a string to at most `max` UTF-8 bytes without splitting a character.
 *
 * Slicing by `.length` would be wrong (a 4-byte emoji is 2 UTF-16 units) and
 * slicing the encoded bytes would be worse: a cut through a multi-byte
 * sequence decodes to U+FFFD, so a truncated name would arrive corrupted
 * rather than merely short.
 */
export function truncateToBytes(s: string, max: number): string {
  if (enc.encode(s).length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  return out;
}

/** The nickname to show and broadcast, or '' when the user has not set one. */
export function getNickname(): string {
  return sanitizeNickname(read(NICKNAME_KEY) ?? '');
}

/**
 * Persist a nickname. Storing '' clears it, which is meaningfully different
 * from storing a default: an unset nickname keeps the WELCOME payload
 * byte-identical to the pre-nickname wire format (see packWelcome).
 */
export function setNickname(raw: string): string {
  const name = sanitizeNickname(raw);
  write(NICKNAME_KEY, name);
  return name;
}

/** What to call a device with no nickname of its own: its UA label. */
export function defaultNickname(): string {
  return sanitizeNickname(uaLabel());
}

/**
 * How to label a peer in the UI: its nickname when it sent one, else the hex
 * id that has always been shown. One place, so the graph, the roster and the
 * transcript cannot drift apart on what a node is called.
 */
export function labelFor(deviceId: number, nickname?: string): string {
  const nick = nickname ? sanitizeNickname(nickname) : '';
  const hex = deviceId.toString(16).padStart(2, '0');
  return nick || hex;
}

const ID_MIN = 1;
const ID_MAX = 255;

/** A random valid wire id. */
function randomDeviceId(rng: () => number): number {
  return ID_MIN + Math.floor(rng() * ID_MAX);
}

/**
 * This device's wire id, stable across reloads and rejoins.
 *
 * Was re-rolled on every join, so a device that dropped and came back was
 * indistinguishable from a new peer — the roster grew a stranger and the old
 * entry sat there until it aged out. Persisting it means "the same phone" reads
 * as the same node.
 *
 * The id is only 8 bits because it is a wire field, so it is NOT collision-free
 * and persistence cannot make it so; see `rerollDeviceId` for what happens when
 * two devices land on the same value.
 */
export function getDeviceId(rng: () => number = Math.random): number {
  const saved = Number(read(DEVICE_ID_KEY));
  if (Number.isInteger(saved) && saved >= ID_MIN && saved <= ID_MAX) return saved;
  const made = randomDeviceId(rng);
  write(DEVICE_ID_KEY, String(made));
  return made;
}

/**
 * Pick and persist a new id that is not in `taken`, for when a peer turns out
 * to be using ours.
 *
 * Necessary because persistence makes collisions permanent rather than
 * self-correcting: the old re-roll-every-join scheme collided just as often but
 * threw the dice again next time, whereas two devices that persist the same id
 * would collide for good — and a collision misroutes targeted messages, since
 * the id is the only thing addressing them.
 *
 * Falls back to a random id when every value is taken. That needs 255 peers in
 * one acoustic room, at which point a duplicate id is not the problem.
 */
export function rerollDeviceId(taken: Iterable<number>, rng: () => number = Math.random): number {
  const used = new Set(taken);
  const free: number[] = [];
  for (let id = ID_MIN; id <= ID_MAX; id++) if (!used.has(id)) free.push(id);
  const next = free.length > 0
    ? free[Math.floor(rng() * free.length)]
    : randomDeviceId(rng);
  write(DEVICE_ID_KEY, String(next));
  return next;
}

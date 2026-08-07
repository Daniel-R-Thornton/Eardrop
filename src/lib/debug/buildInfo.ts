// src/lib/debug/buildInfo.ts
/**
 * Who built this bundle, and when.
 *
 * The values are frozen in at build time by the `define` in vite.config.ts —
 * NOT read per request. A per-request timestamp would report when the log line
 * was written, which the log already says; the point is to report when the CODE
 * was built, so a phone serving a stale cached bundle over the LAN identifies
 * itself as stale.
 *
 * See the comment on `buildInfo` in vite.config.ts for why `dirty` is carried
 * alongside the SHA.
 */

export interface BuildInfo {
  sha: string;
  /** true/false when git answered; '?' when there was no git to ask. */
  dirty: boolean | '?';
  /** ISO 8601, stamped when the bundle was built. */
  time: string;
  /** The Vite `base` this bundle was built for ('/' locally, '/Eardrop/' on Pages). */
  base: string;
}

declare const __BUILD_INFO__: BuildInfo | undefined;

/**
 * Falls back rather than throwing: this module is imported by app code that
 * also runs under vitest and under plain `tsc`, where the define is absent. A
 * missing stamp must degrade to an honest "unknown", never take the app down —
 * a diagnostic that can break the thing it diagnoses is worse than none.
 */
export const BUILD_INFO: BuildInfo = (() => {
  try {
    if (typeof __BUILD_INFO__ !== 'undefined' && __BUILD_INFO__) return __BUILD_INFO__;
  } catch {
    /* not defined at all in this context */
  }
  return { sha: 'unknown', dirty: '?', time: 'unknown', base: 'unknown' };
})();

/** The `build=` fields for the startup [APP] line, in one place so the log
 *  format and any test of it cannot drift apart. */
export function buildStampFields(): Record<string, unknown> {
  return {
    build: BUILD_INFO.sha,
    dirty: BUILD_INFO.dirty,
    built: BUILD_INFO.time,
    base: BUILD_INFO.base,
  };
}

# lib

Collection of small, well-tested utilities shared across the project.

Common reusable modules
- `lib/debug/dlog.ts` — minimal LLM-friendly logging and ring buffer (use in both UI and worker contexts).
- `lib/crc`, `lib/ecc` — checksum and error-correction helpers.

Guidelines
- Keep `lib/` modules dependency-free and small so they can be imported by both workers and UI code without bundler issues.

# audio

Audio helpers and the live capture/playback pipeline for the app.

## Main modules

- `recorder.ts` — microphone capture via AudioWorklet, including the Hann-sinc downsampler path used by the BPSK stack.
- `player.ts` — playback and resampling helpers for sending generated audio to the speaker.
- `devices.ts` — device enumeration and selection helpers.
- `browser/` — browser-specific entrypoints and glue.

## Notes

The recorder path is production-sensitive. Changes here should be verified with loopback or acoustic transfer tests before and after editing.

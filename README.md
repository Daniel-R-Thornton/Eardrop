# 🦻 Eardrop

**File transfer over audio** — speaker to mic, no network needed.

Built on the multi-tone OFDM modem from [TapewormFS](https://github.com/daniel/tapewormfs).

## How it works

1. Pick a file → press **Send** → it plays audio tones through speakers
2. On the receiving device → press **Listen** → mic captures tones → file is decoded

The modem uses 4 simultaneous frequencies (500/700/900/1100 Hz) to encode 4 bits per symbol at 25 symbols/second = **~12.5 bytes/sec**.

At this rate, a 1 KB file takes ~80 seconds. It's slow — designed for small payloads, demos, and air-gapped transfers.

## Usage

```bash
npm install
npm run dev      # → http://localhost:5173
npm run build    # → dist/
```

Open in two browser tabs (or two devices). Send from one, receive on the other.

## Architecture

```
src/
├── modem/
│   ├── encoder.ts    # Multi-tone encoder (4 tones, 4-bit symbols)
│   ├── decoder.ts    # Energy-detection decoder with adaptive noise floor
│   └── types.ts      # Shared config + tone constants
├── audio/
│   ├── player.ts     # Web Audio playback
│   ├── recorder.ts   # Mic capture via MediaStream
│   └── resampler.ts  # 48kHz → 3200 Hz downsampling
├── ui/
│   └── app.ts        # Main application logic
├── style.css
└── index.html
```

## Modem Specs

| Parameter | Value |
|-----------|-------|
| Sample rate | 3200 Hz |
| Symbol rate | 25 symbols/sec |
| Bits/symbol | 4 (multi-tone) |
| Tones | 500, 700, 900, 1100 Hz |
| Pilot tone | 62.5 Hz (below audible) |
| Net bitrate | ~100 bit/s |
| Net byte rate | ~12.5 byte/s |
| Leader | 0.5s pilot only |
| Sync | 2 symbols × all 4 tones ON |

## License

MIT

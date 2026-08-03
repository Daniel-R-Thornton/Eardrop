# LLM dump format (`v2`)

Emitted by the **COPY FOR LLM** button. Machine-oriented, not human-readable —
the human-readable log is the console output and the plain **COPY LOG** button.

**Values are POSITIONAL — there are no field names.** Each row is a code followed
by its values in the order given in the table below. `-` means the field was
absent. Field names cost more characters than the values they label, and the only
consumer of this format is reading the table anyway.

One row per event, in chronological order.

- `row xN` — that exact row repeated N consecutive times.
- `row ~N` — N consecutive rows of a series code (`QD` `SCAN` `TM` `SM` `GN` `KC`)
  whose values were all within 10%, collapsed to the **last** of them. Counters
  (a `QD` symbol index, a `SCAN` bit total) are excluded from that comparison, so
  the surviving counter tells you where the run ended. Event rows — frames,
  failures, sync decisions — never fold.

The header carries `rows=N`. Two trailing lines account for everything not
rendered, so nothing vanishes silently:

- `SUPPRESSED tag=count` — events dropped on purpose (noise).
- `UNMAPPED tag=count` — events no rule matched. A large or surprising count here
  means the digest is under-reporting and the format needs a rule, not that the
  session was quiet.

Per-tone arrays are **reduced to statistics** rather than listed. A 40-tone
constellation dump is ~300 characters of coordinates from which only gain,
dispersion and magnitude spread are ever read; the raw coordinates remain in the
console log if a specific symbol needs inspecting.

## Rows

| code | values, in order | meaning |
|---|---|---|
| `HW` | rate | audio hardware sample rate |
| `C` | `t` `p` `lo` `hi` | config: tone count, pilot Hz, lowest/highest tone Hz |
| `SC` | `req` `use` | TX scale requested vs used after clamping |
| `Y` | range `amp` `sPk` `sCoh` | chirp band, chirp peak, sync-symbol peak, sync COHERENT peak (what the scale is budgeted against) |
| `Y2` | `tr` `st` `pre` | training symbols, settle symbols, preamble ms |
| `HP` | ms | TX handshake-band preamble emitted (band handshake) |
| `HC` | `p` `st` `t` `stl` | TX band card: announced pilot, tone start, tone count, settle symbols |
| `HL` | `p` | RX listening on the fixed handshake band |
| `HR` | `p` `st` `t` `stl` | RX decoded a band card (fields as `HC`) |
| `HH` | `p` `t` `disc` | RX hopped: fresh engine for the announced band; `disc` = samples discarded so the new engine starts in the TX's post-segment silence gap (0 with no chirp anchor — suspect if the hop then fails) |
| `!HC` | — | sentinel hit in card mode but the bytes were not a valid card |
| `TF` | `t` `s` | frame transmitted: type, seq (compare with `F`/`X` on the RX side) |
| `RC` | `p` `sps` `t` | RX config: pilot Hz, SAMPLES per OFDM symbol, tone count |
| `PP` | Hz | RX PLL pilot frequency — must equal `C p` |
| `!TCC` | from`->`to | RX tone count changed mid-session |
| `!TCB` | count `using` | announced tone count rejected; fell back |
| `TCA` | count | tone count adopted from a link profile |
| `RS` | `ctx` `st` `gain` | capture context rate, state, mic gain. `ctx` ≠ `HW` means resampling |
| `CM` | `sch` `raw` `wire` | TX payload compression: scheme, raw bytes, wire bytes |
| `RJ` | `sc` `sh` | sync candidate rejected: CP-correlation score, sharpness |
| `SY` | `norm` `pk` `idx` | chirp detected: normalized correlation, raw peak, index |
| `!WD` | `windows` | **sync-loss watchdog fired** — RX was stuck in FRAMES and deaf; only a CRC-valid frame resets it (~15 s) |
| `!CPT` | — | chirp probe window expired without a decision |
| `!ES` | — | **synced on the ENERGY fallback, not the chirp** — the boundary is unanchored |
| `EB` | `bnd` | energy-sync boundary offset |
| `HO` | `bnd` `sc` `tr` | chirp→CP handoff: boundary offset in samples, score, training samples available |
| `ST` | count | settle symbols discarded before training |
| `TR` | `pA` `hMin` `hMax` `hSpr` `phSlope` `phResid` | training result. `hSpr` = per-tone magnitude spread in dB. `phSlope` = degrees per tone of the fitted phase ramp; `phResid` = RMS deviation from that ramp, in degrees — **small resid = clean delay, large = broken estimate** |
| `DP` | `buf` `seen` | entered the data phase: buffered samples, samples seen. `buf=0` with no `QD`/`SH` after it means no data arrived |
| `FS` | `t` `distinct` `pA` | first data symbol: tones read, DISTINCT constellation decisions among them. `distinct=1` or 2 on many tones = still training, or read at the wrong boundary |
| `DA` | `pA` | pilot amplitude at the first data symbol (compare with `TR pA`) |
| `SH` | `len` | sentinel hit — a frame was found in the byte stream |
| `SCAN` | `bits` | bits scanned with NO sentinel found (heartbeat; collapses with `xN`) |
| `DR` | value | pilot phase drift, microradians per Hz |
| `KC` | `min` `mean` `max` | ref-symbol calibration ratios ×100. 100 = training estimate was right |
| `KL` | `n` | how many tones the calibration clamped |
| `PR` | `t` `ord` | announced profile: tone count, distinct constellation orders |
| `QD` | `n` `g` `sd` `mMean` `mSpr` | QAM symbol: index, gain correction, across-tone I/Q dispersion (centi-units), mean point magnitude, magnitude spread dB |
| `GN` | value | gain correction (periodic) |
| `ME` | `db` `evm` `v` | committed MER, EVM %, bit-loading verdict |
| `TM` | `min` `mean` `max` | per-tone MER dB (committed — only ever appears after a frame decodes) |
| `SM` | `min` `mean` `max` `spr` | per-tone MER dB of a FAILED frame. **`spr` decides the next fix**: flat = level or common phase error, spread = channel (what pre-emphasis addresses) |
| `F` | `ok` `t` `s` `mer` `lvl` | frame: decoded 1/0, type, seq, committed MER, input level (leaky mean \|sample\| from the PLL — **wideband, not a pilot amplitude**) |
| `FT` | `as` `sz` | tail frame: bytes assembled, expected size |
| `RM` | `sch` `wire` `out` | RX decompression: scheme, wire bytes, decompressed bytes |
| `!DEC` | message | decompression failed; wire bytes passed through |
| `CFG` | `restart` | OFDM settings changed, RX restarted |
| `SNAP` | note from`->`to | pilot or tone start snapped to the FFT bin grid |
| `X` | `r` `t` `bch` `rs` `smer` | frame failure: reason, type, per-block BCH/RS error counts, staged MER |
| `PL` | `pk` `vol` | playback peak and volume mode |
| `!PLNORM` | factor `pk` | **playback rescaled a chunk** — defeats the fixed TX scale |
| `!PLCLIP` | `n` | playback clipped n samples |
| `!SINK` | message | output device selection failed |
| `!CLIP` | `n` `pk` | **streamed chunk clipped** — n samples clamped, peak seen |
| `MIC` | label | resolved microphone name |
| `RG` | `gain` `out` `ratio` | mic gain in force, worklet output rate, resample ratio |
| `!MIC-DEFAULT` | — | no device selected; browser default in use |
| `!MIC-UNRESOLVED` | — | stored device absent; fell back to default (re-pick the mic) |
| `CALSTART` | `t` `key` | calibration started: tone count, storage key |
| `CAL` | `before` `after` `key` | pre-emphasis calibration: spread dB before/after, storage key |
| `CG` | `min` `max` | calibration gains in dB — the boost range being asked of the TX |
| `!CALFAIL` | stage | a calibration round failed to measure |
| `!CALERR` | message | calibration aborted |
| `CR` | stage/round`=`spread | calibration progress per round |
| `LIN` | `dev` note | linearity across drive levels; `NONLINEAR` above 3 dB |
| `IMD` | `off` `noise` note | intermodulation in unused slots vs noise floor |

Rows prefixed `!` are problems worth reading first.

## Reading notes

- `TR pA` vs `DA pA` — the amplitude reference over time, both measured on the
  pilot tone. Divergence means the chain's gain moved between training and data,
  which breaks any amplitude-based constellation. `F lvl` is **not** comparable
  with either: it is the PLL's mean |sample| over the whole band, so it rises
  once payload symbols (all tones loaded) replace header symbols even when
  nothing is wrong.
- `TR phResid` is the fastest check on whether a channel estimate is usable at
  all. A few degrees is a clean delay; tens of degrees is noise.
- `QD sd` distinguishes real data from padding: healthy data is 85-170, a
  uniform symbol reads near 0. Low `sd` alone is **not** a fault.
- `KC mean` far from 100 means training measured the channel at a different gain
  than the data arrives at.
- `SUPPRESSED chirpMiss=N` is normal — the correlation ramps up before it fires.
- A missing `SY` row does NOT mean the chirp was too quiet. The detection score is
  normalized by input RMS, so a common-mode level drop cancels out. Check for `!WD`
  (receiver was deaf), `!CPT`, `!ES` (synced without the chirp) and the
  `SUPPRESSED chirpMiss=N` count before blaming level.
- `!ES` invalidates everything downstream of it. The energy fallback needs more
  OFDM symbols than the TX preamble contains, so it runs past the preamble and
  trains on DATA symbols. That averages incoherently over 12 windows (~10.8 dB of
  attenuation) and shows up as a collapsed `TR hMax` with a `TR pA` that barely
  moves — which reads exactly like an acoustic level drop but is not one.
- No `SH` rows after a `DP` row means the receiver never found a frame in the
  demodulated bits at all. That is a different failure from `X` (found, decoded,
  rejected) and points at the symbol stream, not the FEC.

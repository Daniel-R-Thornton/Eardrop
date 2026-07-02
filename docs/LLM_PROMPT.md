# LLM Analysis Guide — Compressed Debug Output

## Format

The `compressForLLM()` function produces structured one-liners per pipeline stage. Each line has a `[STAGE_TAG]` followed by key=value pairs.

## Stage Tags

| Tag | From | Content |
|-----|------|---------|
| `[PILOT]` | PilotScanner | `freq` (Hz), `amp` (amplitude), `conf` (0-1), `N` (samples) |
| `[PLL]` | PilotPLL | `phase_std` (rad), `amp_std`, `lock_quality` (0-1) |
| `[SYNC]` | Decoder sync | `frames` (consecutive/total), `strong` (t/f), `peak_ratio` (per tone), `burst_thr` |
| `[FRAME]` | Per-symbol bits | `pat` (8-bit binary), `eng` (per-tone energy), `relI` (per-tone I') |
| `[BLK]` | FramedBlockDecoder | `OK` (blocks decoded), `crc_fail`, `type_dist` (type→count map) |
| `[BER]` | diag.ts | `raw` (before ECC), `corr` (after ECC), `total_bits`, `err_raw`, `err_corr` |
| `[ECC]` | ecc.ts | `codewords`, `syndrome_fix` (corrected count/rate), `double_err` (uncorrectable count/rate) |
| `[SQWK]` | SquawkProcessor | `n` (count), `avg_drift` (degrees), `max_drift`, `amp_recovery` (gain ratio) |
| `[END]` | End detection | `snr`, `fss` (frames since strong), `bits` (total bits) |

## Example Prompt

```
I have a debug dump from an Eardrop acoustic file transfer.
Analyze the transmission quality:

[PILOT] freq=62.5Hz amp=0.121 conf=0.92 N=1024
[SYNC] frames=8/10 strong=t peak_ratio=0.31/0.08/0.16/0.21 burst_thr=2.1e-11
[BLK] 3/12 OK crc_fail=0 type_dist={01:2,02:1,04:9,FF:1}
[BER] raw=0.023 corr=0.004 total_bits=4096 err_raw=94 err_corr=16
[ECC] codewords=512 syndrome_fix=78/512 (15.2%) double_err=2/512 (0.4%)
[SQWK] n=4 avg_drift=0.8deg max_drift=2.1deg amp_recovery=0.97x
[PLL] phase_std=0.032 amp_std=0.004 lock_quality=0.97

Questions:
1. What's the link quality? Is the SNR adequate?
2. The ECC correction rate is 15.2% — is that within BCH(31,16) limits?
3. The double_err rate is 0.4% — what does that mean for the file?
4. Squawk drift is under 1° average — is the channel stable?
5. Any recommendations to improve the link?
```

## Example: Comparing Two Runs

```
Run A:
[BER] raw=0.023 corr=0.004 total_bits=4096 err_raw=94 err_corr=16
[ECC] codewords=512 syndrome_fix=78/512 (15.2%) double_err=2/512 (0.4%)

Run B:
[BER] raw=0.089 corr=0.031 total_bits=4096 err_raw=365 err_corr=127
[ECC] codewords=512 syndrome_fix=311/512 (60.7%) double_err=28/512 (5.5%)

Analysis:
- Run A: BER 2.3% → 0.4% after ECC. Clean. 15% of codewords needed correction.
- Run B: BER 8.9% → 3.1% after ECC. BCH(31,16) can correct up to 3 of 31 bits (~9.7%).
  But 3.1% residual means ~1/3 of files will have uncorrectable errors.
  5.5% double_err means 1 in 18 codewords has more than 3 errors → file corruption.
  Recommendation: increase squawk rate (tighter PLL lock) or reduce symbol rate.
```

## Field Reference

### BER
- `raw`: Bit Error Rate before ECC correction. If >0.097 (9.7%), BCH(31,16) can't correct all errors.
- `corr`: Bit Error Rate after ECC correction. Should be 0 for a successful transfer.
- `total_bits`: Total number of demodulated data bits.
- `err_raw`: Number of bit errors before ECC.
- `err_corr`: Number of corrected errors (ECC catches these).

### ECC
- `codewords`: Total BCH(31,16) codewords processed.
- `syndrome_fix`: Codewords that had 1-3 errors corrected. Rate >50% means the link is marginal.
- `double_err`: Codewords with >3 errors that could NOT be corrected. Any non-zero value means data corruption.

### Squawk
- `avg_drift`: Average phase drift between squawks (degrees). <5° is good. >20° means the PLL is struggling.
- `amp_recovery`: AGC gain ratio. ~1.0 means stable. <0.5 or >2.0 means large volume changes.

### PLL
- `phase_std`: Standard deviation of phase error. <0.1 rad is good.
- `lock_quality`: 0-1. >0.9 is locked. <0.5 means PLL is losing lock.

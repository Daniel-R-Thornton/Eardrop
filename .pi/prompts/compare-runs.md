---
description: Compare two Eardrop debug dumps (BER/ECC deltas, what changed, verdict)
model: nvidia/nvidia/nemotron-3-ultra-550b-a55b
thinking: high
---
Compare these two Eardrop transfer runs. Format: `[STAGE_TAG] key=value` lines per run; field reference in docs/LLM_PROMPT.md — read it first.

$@

Report:
1. Per-stage deltas that matter (BER raw/corrected, syndrome_fix rate, double_err, PLL lock, squawk drift)
2. Which run is healthier and why, in one sentence
3. Whether the worse run is within ECC correction limits or produces corrupt files
4. Most likely physical/config cause of the difference (gain, pilot freq, distance, symbol rate)

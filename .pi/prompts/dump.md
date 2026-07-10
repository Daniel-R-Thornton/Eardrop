---
description: Analyze a pasted Eardrop debug dump (link quality, ECC margins, recommendations)
model: nvidia/nvidia/nemotron-3-ultra-550b-a55b
thinking: high
---
I have a debug dump from an Eardrop acoustic file transfer. The format is one line per pipeline stage: `[STAGE_TAG] key=value ...`. Field reference is in docs/LLM_PROMPT.md — read it first.

Analyze the transmission quality:

$@

Answer:
1. What's the link quality? Is the SNR adequate?
2. Is the ECC correction rate within BCH limits (raw BER > 9.7% means BCH(31,16) cannot correct)?
3. Any uncorrectable errors (double_err > 0 = data corruption) — what does that mean for the file?
4. Is the channel stable (squawk drift, PLL lock_quality, amp_recovery)?
5. Concrete recommendations to improve the link, ranked by expected impact.

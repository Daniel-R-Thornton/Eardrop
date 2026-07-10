---
description: Guide a real acoustic transfer test and interpret the results
---
We are running a real acoustic file-transfer test (not in-memory). Current change under test: $@

Walk me through it and interpret results:

1. Confirm what build/branch is running (`git log --oneline -1`) and remind me which parameters matter for this change (pilot freq, tone count, sym/s, mic gain).
2. Test procedure: receiver tab → Start Listening; sender tab → drag file → Send as Audio. I'll paste the LLM-compressed debug dump (Ctrl+Shift+D → copy) after the run.
3. When I paste the dump: assess pass/fail against docs/LLM_PROMPT.md field limits, compare with expectations for the change under test, and state clearly whether the change helped, hurt, or made no difference.
4. If it failed: propose the single most informative next experiment — not a code change — before any fix.

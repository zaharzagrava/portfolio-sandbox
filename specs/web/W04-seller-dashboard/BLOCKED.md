# W04 is blocked

- when: 2026-10-17T23:05:30Z
- why: W04 gate failed
- repair agent time used in this run: 11 of 60 minutes

## What to do
Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this
capability. Until then the loop skips it and everything that depends on it.

## End of the last log (.repair-5.log)
```
I changed no product code or test for this gate failure, because I couldn't reproduce it. The failing test is `cart-checkout.spec.ts` JC-2 (the order should reach "Order confirmed"), which failed on both projects with no "Order confirmed" within 45 s.

- **Environment:** `stack-fix.sh smoke` reports the API ready, search answering 200 and Chromium installed.
- **Re-runs:** JC-2 on its own passes on desktop in 20 s. The whole file passes 10 of 10 on both projects (48 s).
- **Probable cause:** I believe the failure came from an API restart during the gate run. The API log shows a graceful shutdown at 21:17:32, with `payments.charge-worker` stopping. That is most likely the restart after the OTEL change from the last commit, and it would have dropped the session and the pending charge. I found no payment or charge error in the log. Earlier gate-repair notes in `gaps.md` record the same signature on repeated runs, so this is a pattern, not a one-off.

I added a "ninth run" entry under `## Gate repairs` in `specs/web/W04-seller-dashboard/gaps.md`. The gate should be re-run with no API restart in progress. I did not run the full 25-minute gate myself.
```

# Leaks between files in one process (notes)

Reported failing: payment-breaker, payment-status-service, load-shedding, failure-counting, usage-read.

What I found
- All five pass when run alone and when run together on shard 9 (61 of 61), and also after the 8 files that ran just before load-shedding in slice 3 (118 of 118).
  So I could not reproduce the failure with a short run; a full 90-file slice does not fit in the 3 minute limit.
- The payment "resetBreakers is not a function" symptom means the scripted payment provider was chosen. The only source is PROVIDER_DOUBLES=enabled from backend/.env, which the dotenv/config alias already blocks. The run logs (12:11) probably predate that fix.
- Other leak path that stays open: a spec that sets an environment variable in a test and forgets to undo it (for example NODE_ENV in dev-mailbox, problem-details).

Fix (general, at the source of the sharing)
- test/e2e-env.setup.ts: after each file's imports, remember the environment; when the file ends, put exactly that back (remove added variables, restore changed ones). No check is weakened.

Result: the five files plus dev-mailbox and problem-details together: 84 of 84 pass.
Not proven: that this removes the failures in a full slice. Rerun a full slice to confirm.

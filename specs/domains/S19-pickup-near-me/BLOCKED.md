# S19 is blocked

- when: 2026-10-13T15:56:45Z
- why: needs a human: DOCTOR: needs human: stop the `payment_system_*` dev stack so `scripts/qa/fresh-run.sh` can run on an empty stack and close T072.
- repair agent time used in this run: 0 of 60 minutes

## What to do
Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this
capability. Until then the loop skips it and everything that depends on it.

## End of the last log (.doctor-1.log)
```
I didn't change anything. The only open task, T072, needs a human decision.

T072 is the empty-stack run of the real applications through `scripts/qa/fresh-run.sh`. The script exits 2 while any `payment_system_*` container is up, and those containers (db, redis, elasticsearch, elasticmq, minio and others) are running now. Stopping them would shut down the user's own dev environment, and an unattended repair agent shouldn't do that.

All 77 other tasks are marked done, and the blocker is already recorded in the T072 note in `tasks.md`. It is an environment conflict. The spec, plan, tasks and code don't contradict each other. Skipping the task isn't an option, because L-012 requires a run on a fresh stack. I also didn't tick T072 on the strength of the substitute wiring tests, since none of them is an empty-stack run.

Retrying the step will stall the same way until someone stops the dev stack. After that, run `scripts/qa/fresh-run.sh`, check the items listed in T072, and tick it.

DOCTOR: needs human: stop the `payment_system_*` dev stack so `scripts/qa/fresh-run.sh` can run on an empty stack and close T072.
```

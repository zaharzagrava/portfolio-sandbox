# S36 is blocked

- when: 2026-10-13T22:46:55Z
- why: needs a human: DOCTOR: needs human: the sandbox denies starting the real apps/projector, apps/core and apps/worker, so T060 needs a human or an approved run to boot them and check the registration log lines.
- repair agent time used in this run: 1 of 60 minutes

## What to do
Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this
capability. Until then the loop skips it and everything that depends on it.

## End of the last log (.doctor-2.log)
```
59 of 60 S36 tasks are done, but T060 (start the real apps) is still open. I couldn't close it because the sandbox refuses to run the apps.

- **What I did:** `nest build projector` compiles. The earlier projector boot failure (`NotificationsCoreModule` lacking `TenancyModule`) already has its fix in the working tree, so the DI error should be gone.
- **What I couldn't do:** Running `node dist/apps/projector/main.js` needs approval and was refused. Core and worker would be refused the same way. I didn't bypass the sandbox. Route, aggregator, `ads.bill-hour`/`ads.reconcile-day` and projector-consumer registration are therefore still unconfirmed.
- **Notes:** I added what I found to the "Blocker: T060" section of `questions.md`. The earlier `fresh-run.sh` ok came from the already-running stack, not an empty one.
- **What a human needs to do:** Start `apps/projector` (port 8002), `apps/core` (port 8000, which was already in use last time, so free it first) and `apps/worker` (port 8003). Then check the logs for those registrations and tick T060.

DOCTOR: needs human: the sandbox denies starting the real apps/projector, apps/core and apps/worker, so T060 needs a human or an approved run to boot them and check the registration log lines.
```

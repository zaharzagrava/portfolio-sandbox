# S36 is blocked

- when: 2026-10-14T07:54:19Z
- why: needs a human: DOCTOR: needs human: T061 needs the three real apps started (`scripts/infra/boot-app.sh projector|worker|core`), and the sandbox refuses to run them without approval.
- repair agent time used in this run: 3 of 60 minutes

## What to do
Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this
capability. Until then the loop skips it and everything that depends on it.

## End of the last log (.doctor-2.log)
```
The loop can't retry yet: the only open task, T061, needs the real `apps/core`, `apps/worker` and `apps/projector` started, and I couldn't start them.

- **Not a spec problem:** 60 of 61 tasks are done, and nothing in the spec contradicts anything else.
- **Why T061 is stuck:** it asks for proof that the three apps boot and register the ads routes, the click aggregator, the `ads.bill-hour` and `ads.reconcile-day` jobs, and the `ads-product-snapshot` and `ads-shop-snapshot` consumers. That proof needs a long-running server started. The sandbox asks for approval every time, and no one is there to give it.
- **What I tried:** `scripts/infra/boot-app.sh` is the sanctioned way to boot one app. I ran it for `projector`, `worker` and `core`, and all three were refused for approval, so nothing ran.
- **What I changed:** I added one line to the "Blocker: T060" section of `questions.md` with the exact commands to run and what to paste back. I changed no code, did not tick T061, and did not weaken any task or test.
- **Human step:** run `scripts/infra/boot-app.sh projector --wait 180`, then the same with `worker` and `core`. Paste the "UP" lines and the consumer, job and route lines into `questions.md`, then tick T061. Alternatively, approve those commands for the loop.

DOCTOR: needs human: T061 needs the three real apps started (`scripts/infra/boot-app.sh projector|worker|core`), and the sandbox refuses to run them without approval.
```

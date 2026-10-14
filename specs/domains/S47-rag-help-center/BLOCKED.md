# S47 is blocked

- when: 2026-10-14T00:13:18Z
- why: needs a human: DOCTOR: needs human: T066, T070 and T071 need the dev stack up, a real boot of `apps/projector`, and approval to rebuild the shared stack with `scripts/qa/fresh-run.sh`, none of which the sandbox allows.
- repair agent time used in this run: 2 of 60 minutes

## What to do
Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this
capability. Until then the loop skips it and everything that depends on it.

## End of the last log (.doctor-1.log)
```
I fixed the projector crash, but T066, T070 and T071 are still open. They need a stack, or an approved run, that this sandbox doesn't allow.

**What I changed:** the `apps/projector` start-up crash in `configureHttpApp` (`libs/infrastructure/platform/bootstrap-http.ts`). `app.get(RouteTable, { strict: false })?.setPrefix(...)` throws when an app doesn't register `RouteTable`, and the projector doesn't. The `?.` never helped, because the call throws instead of returning null. I wrapped it in a try/catch. The platform unit tests pass (19 of 19).

**Not verified:** I could not boot the projector to confirm the fix, because the sandbox denied the command. I also noted this in the T070 text in `tasks.md`, and the task stays unticked.

**Still open:**
- **T066:** needs the dev stack (API on :8000, web on :3000) up so the Playwright journey can run.
- **T070:** needs one real boot of `apps/projector` to check the start-up log lines.
- **T071:** needs a go-ahead to run `scripts/qa/fresh-run.sh`, which rebuilds the shared stack.

DOCTOR: needs human: T066, T070 and T071 need the dev stack up, a real boot of `apps/projector`, and approval to rebuild the shared stack with `scripts/qa/fresh-run.sh`, none of which the sandbox allows.
```

# S06 is blocked

- when: 2026-10-17T02:12:24Z
- why: S06 gate failed
- repair agent time used in this run: 0 of 60 minutes

## What to do
Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this
capability. Until then the loop skips it and everything that depends on it.

## End of the last log (.repair-5.log)
```
The S06 gate failure is not a code defect, so I changed no code. I added an eleventh-pass entry under `## Gate repairs` in `specs/domains/S06-collab-editor/gaps.md`.

- **Cause:** the gate ran every e2e suite of the domain in one jest process with the 4 GB heap. That process ran out of memory and aborted (`JavaScript heap out of memory`, core dumped). The 503s and other failures in the suites before it came from the exhausted process.
- **Fix already in the tree:** `gate()` in `scripts/sdd/implement-specs.sh` runs the suites in batches of `GATE_BATCH` (default 12), each in a fresh process with `--max-old-space-size=6144`. The failing run predates that change.
- **Checks I ran:**
  - `stack-fix.sh smoke` reports the environment ok.
  - `catalog/(collab-routing|collab-ops|drafts-publish|product-views)` passes: 4 suites, 63 tests, in one fresh process.
- **Not re-run this pass:** `collab-rooms` and `catalog-sync/import-security` were not re-run. They also failed in this gate output and passed alone in earlier passes.
- **Not run:** I did not start the whole batched gate.
- **Still unproven:** the batched `gate()` has not yet been seen passing the full domain.
- **Not covered by a test:** SC-001, SC-004 and SC-007 stay in `specs/UNVERIFIED.md` as "not run".
```

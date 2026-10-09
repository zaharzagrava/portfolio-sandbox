# Success criteria no automated test proves yet

Every row is a claim the specs make that has **not** been run. Do not state any of these as verified (README, resume,
interviews) until its status says so. The implementation loop appends here (rule 2 in `extra_context` of
`scripts/sdd/implement-specs.sh`); a later load-proof task is meant to run them, e.g. on the VPS runner.

| Spec | Criterion | How to run it | Status |
| --- | --- | --- | --- |
| S54 | SC-002: 20 rolling restarts under steady load drop no accepted request | `specs/domains/S54-platform-toolkit/quickstart.md`, "Ops artifacts" (restart loop) | not run |
| S54 | SC-003: at 2x capacity, admitted p99 under 300 ms, refusals are 503 with Retry-After, probes never refused | same file (k6 at 2x capacity) | not run |
| S54 | SC-004: a 60 s database outage keeps readiness 200 and returns fast 503 for database routes | same file (outage drill) | not run |
| S54 | SC-008: context and logging overhead under 0.5 ms p99 per request | same file (overhead benchmark) | not run |

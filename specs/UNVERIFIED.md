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
| S54 | SC-001: 10 000 responses of every error kind parse as problem+json with 0 leaks | `specs/domains/S54-platform-toolkit/quickstart.md`, "Ops artifacts" (error sample) | not run |
| S54 | SC-006: 1 000 parallel requests with one Idempotency-Key give exactly one side effect | same file (parallel idempotency) | not run |
| S54 | SC-010: a new capability adds a domain error, probe check, shutdown task, outbound client and idempotent route using only contract names | same file (throwaway capability) | not run |
| S53 | SC-001: 10 000 randomized commit/rollback transactions with relay crashes and broker outages lose no committed event and emit none for a rollback | `specs/domains/S53-events-projections/quickstart.md`, "Ops artifacts" (randomized crash driver) | not run |
| S53 | SC-004: with `minVersion`, 99% of reads see the write within 500 ms and 100% within 2.5 s | same file (read-your-writes latency run) | not run |
| S53 | SC-005: projection lag p99 under 2 s at 1, 2 and 4 instances on 100 000 events | same file (F-05 load script) | not run |
| S53 | SC-006: 100 000-event shadow rebuild with zero failed live reads and promotion refused until caught up | same file (rebuild drill) | not run |
| S53 | AS-21 (not an SC): the CDC relay emits the same topic, key, value and headers as the poller | same file (`S53_CDC=1` outbox-cdc spec with the `cdc` profile) | not run |
| S49 | SC-002: doubling workers 1 to 2 to 4 roughly halves no-op drain time (within 30% of linear), zero re-executions | `pnpm --dir packages/backend loadtest:jobs` at 1, 2, 4 workers (VPS runner) | not run |
| S49 | SC-006: a schedule fire materialises within 2 s of due and a delayed job starts within 1 s of `runAt` under normal load | `loadtest:jobs` with 1 s `runAt` jobs and a 10 s schedule; read `job_queue_lag_seconds` | not run |
| S49 | SC-007: queue lag visible within 10 s of becoming non-zero | scrape `/metrics` while enqueuing past-due jobs with workers stopped | not run |
| S49 | AS-88 / AS-89 at full scale (200,000 jobs, 5,000 cycles); CI runs a reduced size | `S49_PLAN_ROWS=200000 S49_HOT_CYCLES=5000 scripts/sdd/test-spec.sh libs/infrastructure/jobs/jobs-retention.e2e-spec.ts` on the runner | not run |

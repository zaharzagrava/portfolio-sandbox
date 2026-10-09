# Test Plan: S49 — Distributed job scheduler (domain `infrastructure`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (95 scenarios, AS-01 to AS-95). A dash means the layer does not test that scenario. Each scenario is proven once, at the lowest layer that can prove it.

- **API e2e** files live in `packages/backend/libs/infrastructure/jobs/`. S49 has no HTTP endpoint of its own (operator routes belong to S01 over `JobsAdminService`, R1), so the "API" is the exported service surface. Each file boots a Nest app from the real `JobsModule` and `JobsWorkerModule` with test handlers, against real Postgres (production major version, real migrations from `docker-compose.test.yaml`). The repositories, ORM and job tables are never mocked. Only the clock (frozen, injected) and handler bodies (test fakes that record invocations) are replaced. Every test asserts the return value **and** the persisted state (job and key rows, schedule rows, partitions, metrics, log lines) and truncates the job tables first. Each file's top-level `describe` names its feature (VII.8).
- Concurrency rows use `Promise.all` over several workers or connections in one test process, with a second Nest app instance where "several replicas" is needed (AS-54, AS-60).
- Process death (AS-27, AS-28, AS-55) is simulated by stopping a worker's heartbeat and aborting a transaction, not by killing the test process.
- No HTTP controller exists, so the VII.3 `401` and cross-tenant HTTP cases do not apply. The IDOR case is AS-43 (shop-scoped cancel).
- No async consumer exists in S49 (jobs are the queue itself), so the VII.4 pair does not apply. Idempotent replay is covered by AS-03/04/56/10.
- **Unit** specs sit beside the code, are table-driven (`it.each`), and cover only pure logic: next-fire computation, backoff, the status transition function, option and name validators, cursor codec. No unit tests for the worker loop, SQL, controllers or glue. Time is passed as an argument, never read.
- **UI journeys**: none. S49 has no UI. The operator console (queue lag, dead jobs with retry) is a later web capability (SD-29 phase 2) and will own its Playwright journey.
- **Static gates** (VII.1): `tsc --noEmit` strict and ESLint for `packages/backend`; `pnpm --dir packages/backend check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict`.
- **Load proof** of SC-002 (`pnpm loadtest:jobs`, k6 at 1/2/4 workers) is an operations artifact, not an e2e row.

e2e files:

| Short name | File |
|---|---|
| ENQ | `jobs-enqueue.e2e-spec.ts` |
| RUN | `jobs-worker.e2e-spec.ts` |
| LEASE | `jobs-lease.e2e-spec.ts` |
| STATE | `jobs-state.e2e-spec.ts` |
| FAIR | `jobs-fairness.e2e-spec.ts` |
| CRON | `jobs-cron.e2e-spec.ts` |
| OBS | `jobs-observability.e2e-spec.ts` |
| RET | `jobs-retention.e2e-spec.ts` |
| REG | `jobs-registry.e2e-spec.ts` |

Unit files: `cron.spec.ts` (next fire), `backoff.spec.ts`, `job-state.spec.ts`, `enqueue-options.spec.ts`, `schedule-validation.spec.ts`, `handler-options.spec.ts`, `job-cursor.spec.ts`.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 delayed job claimed only at `runAt` | ENQ | — | — |
| AS-02 enqueue joins caller transaction; rollback leaves nothing | ENQ | — | — |
| AS-03 same key returns existing job, `created: false` | ENQ | — | — |
| AS-04 20 concurrent enqueues of one key: one `created: true` | ENQ | — | — |
| AS-05 key reused with another type → `IdempotencyKeyConflictError` | ENQ | — | — |
| AS-06 invalid payload / unknown type rejected, nothing persisted | ENQ | — | — |
| AS-07 limits: payload size, key length, `maxAttempts`, `runAt` range | — | — | `enqueue-options.spec.ts` |
| AS-08 enqueue with no caller transaction | ENQ | — | — |
| AS-09 key expiry at the 30-day retention boundary | RET | — | — |
| AS-10 4 workers drain 1,000 jobs, each exactly once | RUN | — | — |
| AS-11 oldest `runAt` first; future job untouched | RUN | — | — |
| AS-12 job of a type without local handler is not claimed | RUN | — | — |
| AS-13 per-type `concurrency` bulkhead on one worker | RUN | — | — |
| AS-14 `fleetConcurrency: 1` across 3 workers | RUN | — | — |
| AS-15 lease equals handler `leaseMs` from claim | RUN | — | — |
| AS-16 success → `SUCCEEDED`, locks cleared, counter | RUN | — | — |
| AS-17 failure → `QUEUED` with jittered `runAt`, then success | RUN | — | — |
| AS-18 backoff ceiling table and jitter bounds | — | — | `backoff.spec.ts` |
| AS-19 attempts exhausted → `DEAD` | RUN | — | — |
| AS-20 `NonRetryableJobError` → `DEAD` at attempt 1 | RUN | — | — |
| AS-21 stored payload violating contract → `DEAD`, handler not run | RUN | — | — |
| AS-22 context `attempt` / `maxAttempts` / `isLastAttempt` | RUN | — | — |
| AS-23 `lastError` truncation; no payload in logs | RUN | — | — |
| AS-24 `maxRuntimeMs` abort with reason `timeout`, retryable | RUN | — | — |
| AS-25 late completion after timeout is fenced | LEASE | — | — |
| AS-26 completion write retried 3×, then left to reaper | LEASE | — | — |
| AS-27 expired lease reaped, re-run, attempts counted | LEASE | — | — |
| AS-28 job that kills workers ends `DEAD` via reaper | LEASE | — | — |
| AS-29 heartbeat keeps a long job alive | LEASE | — | — |
| AS-30 zombie worker completion fenced after re-claim by another | LEASE | — | — |
| AS-31 same-process re-claim: old execution fenced by attempt | LEASE | — | — |
| AS-32 heartbeat after lost lease aborts signal `lease_lost` | LEASE | — | — |
| AS-33 two reapers at once: each job reaped once | LEASE | — | — |
| AS-34 graceful shutdown drains in-flight jobs | LEASE | — | — |
| AS-35 past drain deadline: abort, release, attempt refunded | LEASE | — | — |
| AS-36 no claims after shutdown begins | LEASE | — | — |
| AS-37 database outage: loops survive and resume | LEASE | — | — |
| AS-38 legal transitions only | — | — | `job-state.spec.ts` |
| AS-39 cancel `QUEUED` → `CANCELLED` | STATE | — | — |
| AS-40 cancel in any other status → `CONFLICT` / `NOT_FOUND` | STATE | — | — |
| AS-41 cancel vs claim race: exactly one wins | STATE | — | — |
| AS-42 `cancelByKey` | STATE | — | — |
| AS-43 cross-shop cancel → `NOT_FOUND`, unchanged | STATE | — | — |
| AS-44 operator retry of `DEAD`; other statuses `CONFLICT`; audit log | STATE | — | — |
| AS-45 two concurrent retries: one wins | STATE | — | — |
| AS-46 per-shop cap holds fleet-wide under load | FAIR | — | — |
| AS-47 saturated shop does not delay another shop | FAIR | — | — |
| AS-48 cap counts jobs claimed in the same batch | FAIR | — | — |
| AS-49 four concurrent claimers keep the cap | FAIR | — | — |
| AS-50 jobs without shop are uncapped | FAIR | — | — |
| AS-51 finishing a job frees a slot on next poll | FAIR | — | — |
| AS-52 ordering stays oldest-first among unsaturated shops | FAIR | — | — |
| AS-53 due schedule → one job with `cron:<name>:<fireAt>` key | CRON | — | — |
| AS-54 five instances tick at once: one leader, one job | CRON | — | — |
| AS-55 leader aborted mid-tick: no partial effect, next instance fires once | CRON | — | — |
| AS-56 duplicate materialisation deduped by key | CRON | — | — |
| AS-57 outage over 3 daily fires → one catch-up | CRON | — | — |
| AS-58 overlap `skip` vs `allow` | CRON | — | — |
| AS-59 upsert idempotent; recompute only on cron/zone change | CRON | — | — |
| AS-60 8 replicas upsert at boot concurrently | CRON | — | — |
| AS-61 invalid schedule rejected, existing row unchanged | CRON | — | — |
| AS-62 disable / re-enable, no catch-up | CRON | — | — |
| AS-63 `removeSchedule` keeps materialised jobs | CRON | — | — |
| AS-64 1,200 due schedules over ≤ 3 ticks | CRON | — | — |
| AS-65 failing schedule isolated, auto-disabled after 5 | CRON | — | — |
| AS-66 schedule `maxAttempts` propagates | CRON | — | — |
| AS-67 six-field (seconds) schedule fires every 10 s | CRON | — | — |
| AS-68 daily 09:00 Warsaw across both DST changes | — | — | `cron.spec.ts` |
| AS-69 nonexistent local time fires once after the gap | — | — | `cron.spec.ts` |
| AS-70 ambiguous local time fires once, first occurrence | — | — | `cron.spec.ts` |
| AS-71 wildcard hour: 25 / 23 fires on DST days | — | — | `cron.spec.ts` |
| AS-72 31st and 29 Feb skip impossible dates | — | — | `cron.spec.ts` |
| AS-73 next fire strictly after the base instant | — | — | `cron.spec.ts` |
| AS-74 fractional-offset and no-DST zones | — | — | `cron.spec.ts` |
| AS-75 zone change recomputes next fire | — | — | `cron.spec.ts` |
| AS-76 invalid expression or zone rejected | — | — | `schedule-validation.spec.ts` |
| AS-77 queue lag gauge | OBS | — | — |
| AS-78 outcome counters, duration histogram, dead gauge | OBS | — | — |
| AS-79 lease-expired and skipped-fire counters | OBS | — | — |
| AS-80 structured logs with ids; no payload; originating ids carried | OBS | — | — |
| AS-81 per-job request context isolation | OBS | — | — |
| AS-82 `listJobs` keyset pagination, tampered cursor, limit clamp | OBS | — | `job-cursor.spec.ts` (cursor encode/decode round trip and tamper detection only) |
| AS-83 `getStats` matches rows | OBS | — | — |
| AS-84 partitions created ahead, idempotent | RET | — | — |
| AS-85 drop rules: finished, queued, recent dead, young | RET | — | — |
| AS-86 insert with no partition lands in default; reported | RET | — | — |
| AS-87 key purge in batches | RET | — | — |
| AS-88 claim plan uses partial due index on 200k rows | RET | — | — |
| AS-89 after a VACUUM, a second batch of 5,000 cycles grows the heap by less than 25%; fillfactor stays 70 | RET | — | — |
| AS-90 drop by catalog-resolved name within lock timeout | RET | — | — |
| AS-91 duplicate handler fails startup; same provider twice is fine | REG | — | — |
| AS-92 bad type name or handler options fail startup | REG | — | `handler-options.spec.ts` (name pattern and ranges, table-driven; the startup failure itself is the REG e2e row of AS-91's file, asserted once there) |
| AS-93 payload contract typed at enqueue and parsed for handler | — | — | `enqueue-options.spec.ts` (`expectTypeOf` on `JobPayloads`) |
| AS-94 enqueue works without the handler module loaded | REG | — | — |
| AS-95 exhaustive handling of statuses and types | — | — | `job-state.spec.ts` (`assertNever` table over every status) plus `tsc` |

Note on AS-82 and AS-92: the e2e column proves the behaviour through the service (AS-82) or startup (AS-92); the unit cell names a pure helper whose rule is not re-proven end to end. AS-92's unit cell proves the validator rules; the REG e2e cell proves only that a violation aborts boot, using one representative case.

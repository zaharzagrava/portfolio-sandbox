# Quickstart: validating S54

Run from `packages/backend`. Test engines come from `docker-compose.test.yaml`. Use the condensed runner; open the full log only when the condensed output is not enough:

```bash
/home/zagrava/workspace/personal-projects/portfolio-sandbox/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]
```

Stop after 5 failed fix attempts on the same test and write the blocker, attempts and hypothesis to `questions.md`.

## 0. Baseline (first task, and again at the end)

```bash
pnpm check:table-ownership && pnpm check:table-ownership --strict   # paste infrastructure lines into gaps.md; expect only IdempotencyKey after WP-8
pnpm check:boundaries
npx tsc --noEmit -p tsconfig.json
pnpm lint
```

## 1. Per work package (narrowest proof first)

| WP | Command (pattern) | Proves |
|---|---|---|
| 1 | `libs/common/exceptions-filter` | AS-01–AS-16; sample of error kinds all parse with `problemDetailsSchema` (SC-001) |
| 2 | `libs/infrastructure/context/request-context` and `request-id.spec` | AS-17–AS-27 |
| 3 | `libs/infrastructure/context/transactions`, `libs/infrastructure/database` | AS-28–AS-40, AS-145/146 |
| 4 | `libs/infrastructure/health` | AS-41–AS-55 (DB down ⇒ `/readyz` 200, SC-004 shape) |
| 5 | `libs/infrastructure/lifecycle` | AS-56–AS-72 (child process, real signals, exit codes) |
| 6 | `libs/common/load-shedding` | AS-73–AS-83 |
| 7 | `libs/infrastructure/http-client`, `libs/infrastructure/net`, `libs/common/resilience` | AS-84–AS-115 |
| 8 | `libs/infrastructure/idempotency` | AS-116–AS-131 (two Nest apps, one database) |
| 10 | `libs/infrastructure/platform`, `libs/common/{config,logging,telemetry}` | AS-132–AS-152 |

## 2. Manual smoke (after WP-4/5)

```bash
curl -si localhost:3000/readyz        # 200 + {"status":"up","checks":{...}}, Cache-Control: no-store
kill -TERM <pid>                       # readyz → 503 at once; in-flight request finishes; exit code 0
kill -TERM <pid> <pid>                 # second signal ignored
curl -si localhost:3000/nope           # application/problem+json, code not_found, requestId == X-Request-Id
```

## 3. Closure (WP-11, once)

Run the whole capability suite (all 12 e2e files and unit specs listed in `test-plan.md`), then step 0 again. Record below: date, command, counts, and any skipped item with the reason ("written but not run" never satisfies VII.9).

| Date | Command | Result |
|---|---|---|
| 2026-10-09 (working tree on top of `d39f133`, not committed) | `scripts/sdd/test-spec.sh libs/common/{exceptions-filter,load-shedding,resilience,config,logging,telemetry,core} libs/infrastructure/{context,health,lifecycle,platform,http-client,net,idempotency,database} test/toolkit --forceExit` | 13 e2e suites, 202 tests passed, 0 todo, 0 skipped |
| 2026-10-09 | `pnpm --dir packages/backend test libs/common libs/infrastructure` (unit specs) | 18 suites, 357 tests passed |
| 2026-10-09 | `scripts/sdd/test-spec.sh --forceExit --bail=0` (every backend e2e suite, including callers changed by S54) | 64 of 65 suites, 452 of 457 tests passed. The one failing suite, `libs/domains/experimentation/analytics.e2e-spec.ts`, fails while creating ClickHouse tables (`ORDER BY or PRIMARY KEY clause is missing`): the ClickHouse image in `docker-compose.test.yaml` rejects the repository's DDL, nothing in S54 touches it |
| 2026-10-09 | `pnpm exec tsc --noEmit -p tsconfig.json`; `check:boundaries` (0 errors, 62 warnings = baseline); `check:table-ownership --strict` (0 `infrastructure` lines, `IdempotencyKey` owned by `infrastructure:idempotency`; exits 1 only because of the 87 pre-existing cross-domain accesses of other domains); `check:no-request-scope`; `check:image-definition`; `check:no-startup-migration`; `check:no-wallclock` | all clean (except the table-ownership exit code noted) |
| 2026-10-09 | `eslint` with `prettier/prettier` off on the S54 libs and `test/toolkit` | clean. Repository-wide `pnpm lint` is not green (about 2 000 prettier and 250 type-aware errors predate S54) |
| 2026-10-09 | `eslint-rule probe`: a `Date.now()` / `new Date()` fixture inside `libs/infrastructure/health` | both flagged by the wall-clock `no-restricted-syntax` rule (AS-151) |

Test titles carry their scenario id: every one of the 152 rows of `test-plan.md` has a test named with its `AS-nn`, except the five rows proven by a static gate (AS-26, AS-69, AS-71, AS-131, AS-151).

## Ops artifacts

Load proofs that are not e2e rows (T112). Run them against a staging copy of one HTTP app (`core`) with telemetry on; record the date, commit, and the measured numbers under "Result" when done. A box left unticked means the proof was not run; it never counts as passed.

### SC-002 - rolling restart loop (no accepted request dropped)

- [ ] Start steady load: a constant-arrival-rate k6 scenario (adapt `packages/backend/scripts/load-tests/product-detail.test.js`) at ~50 % of measured capacity, requests with `Connection: keep-alive`.
- [ ] Repeat 20 times: `kill -TERM <pid>` the instance, wait for exit, start it again, wait for `/startupz` 200, 30 s apart. (Containers: `docker stop -t 45 <name>` then `docker start`.)
- [ ] Pass: the load tool reports 0 connection errors and 0 `5xx` other than refusals by the load balancer for requests sent while the instance was draining; every exit code is `0`; every stop finishes within the 25 s hard timeout (45 s container grace).
- [ ] Also confirm in the logs: one `forced shutdown` line means a failure of this proof.

### SC-003 - 2x capacity (shedding keeps admitted latency)

- [ ] Find capacity: ramp the same scenario until event-loop p99 (`nodejs_eventloop_lag_p99_ms`) first exceeds 200 ms; note the request rate `C`.
- [ ] Run a constant `2 × C` for 5 minutes.
- [ ] Pass: admitted requests p99 < 300 ms; every refusal is `503` with `Retry-After` 1-3 (`http_requests_shed_total` > 0); `/livez`, `/readyz`, `/startupz` polled every second never answer `503 service_overloaded`.

### SC-004 - 60 s database outage keeps readiness green

- [ ] Under light load, stop Postgres (`docker stop marketplace_test_db` or the staging equivalent) for 60 s, then start it again.
- [ ] Pass: every instance's `/readyz` stays `200` with `checks.postgres: "down"` (`health_check_up{check="postgres"}` = 0, `platform_ready` = 1); database-backed routes answer fast `503 database_unavailable` with `Retry-After`; no instance is replaced by the orchestrator; routes recover within one `/readyz` cache TTL (2 s) of the database returning.

### SC-008 - context and logging overhead below 0.5 ms p99

- [ ] Run a constant 500 req/s k6 scenario against one trivial JSON route twice: once with `RequestContextModule` + `LoggingModule` mounted (default) and once with both removed from a throwaway app module.
- [ ] Pass: p99 of the default build minus p99 of the stripped build is < 0.5 ms at 500 req/s on the same machine.

### SC-001 - 10 000 error responses all parse as problem+json, 0 leaks

The e2e suites prove this for a few error kinds and about 20 requests only. Not run at the 10 000 sample.

- [ ] Against a staging copy of `core`, send a 10 000-request mix that triggers every error kind in the spec (validation, auth, not found, conflict, rate limit, shed, database unavailable, upstream failure, unhandled exception, malformed body, oversized body), for example with a k6 scenario that cycles through one trigger route per kind.
- [ ] Capture every response body and the `X-Request-Id` header.
- [ ] Pass: 100 % parse as the problem document (`application/problem+json`); 0 bodies contain a stack line (`at `), SQL text, a table name or an upstream message (grep the captured bodies); 100 % carry a `requestId` equal to the response header.

### SC-006 - 1 000 parallel requests with one `Idempotency-Key`

The e2e suites prove this at 20 parallel requests only. Not run at 1 000.

- [ ] Against a staging copy of `core`, send 1 000 parallel `POST` requests to one idempotent route with the same `Idempotency-Key` and body (k6 `shared-iterations`, 1 000 VUs or `constant-arrival-rate`), counting the side effect (a row or counter written by the route).
- [ ] Repeat the same key once more after 1 h and again within 24 h.
- [ ] Pass: exactly 1 side effect; the other 999 answers are replays of the first response or `409`; 0 duplicates after any retry within 24 h.

### SC-010 - a new capability adopts the toolkit using only `contracts/toolkit-api.md` names

No automated test proves this; it is a review-by-use criterion.

- [ ] In a throwaway branch, add a new capability module that adds one domain error, one probe check, one shutdown task, one outbound client and one idempotent route, importing only names listed in `contracts/toolkit-api.md`.
- [ ] Pass: it builds and its e2e test passes with no edit to any file under the toolkit library (`git diff --stat` shows none).

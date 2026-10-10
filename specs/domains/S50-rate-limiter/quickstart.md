# Quickstart: validating S50

Run from `packages/backend` (edge worker: `packages/edge-be`). Prerequisite: the test Redis from `docker-compose.test.yaml` is up. Contract: [contracts/rate-limit.md](contracts/rate-limit.md); records: [data-model.md](data-model.md).

## Automated validation

```bash
S=/opt/sdd/repo/scripts/sdd/test-spec.sh
# Unit specs (*.spec.ts) use the default jest config; the helper runs only *.e2e-spec.ts.
pnpm test libs/infrastructure/rate-limit     # cost (AS-07), fallback-limiter (AS-29), rate-limit-headers (AS-82),
                                             # subject (AS-51, 53), policy-validation (AS-69), policy-keys (AS-73)
pnpm exec tsc --noEmit                       # includes policy-names.type-spec.ts (AS-72)
$S libs/infrastructure/rate-limit/token-bucket.e2e-spec.ts          # AS-01-05, 08, 83
$S libs/infrastructure/rate-limit/sliding-window.e2e-spec.ts        # AS-09-14
$S libs/infrastructure/rate-limit/concurrency-limit.e2e-spec.ts     # AS-15-20
$S libs/infrastructure/rate-limit/local-lease.e2e-spec.ts           # AS-21-25
$S libs/infrastructure/rate-limit/fail-modes.e2e-spec.ts            # AS-26-28, 30-36
$S libs/infrastructure/rate-limit/rate-limit-http.e2e-spec.ts       # AS-06, 37-47 (also: no ETag, Idempotency-Replayed)
$S libs/infrastructure/rate-limit/rate-limit-subjects.e2e-spec.ts   # AS-48-50, 52
$S libs/infrastructure/rate-limit/failure-counting.e2e-spec.ts      # AS-54-59
$S libs/infrastructure/rate-limit/penalize.e2e-spec.ts              # AS-60-65
$S libs/infrastructure/rate-limit/rate-limit-registry.e2e-spec.ts   # AS-66-68, 70, 71
$S libs/infrastructure/rate-limit/rate-limit-observability.e2e-spec.ts  # AS-74, 75
$S libs/infrastructure/rate-limit/rate-limit-fleet.e2e-spec.ts      # AS-80, 81
$S libs/infrastructure/rate-limit/edge-script.e2e-spec.ts           # AS-76, 77: the edge worker's Lua, run against the real Redis
$S libs/infrastructure/rate-limit                                   # whole capability suite, once at the end
(cd ../edge-be && pnpm test)                                        # rate-limit.spec.ts: AS-76-79
```

Static gates: `pnpm exec tsc --noEmit` and ESLint for `packages/backend` and `packages/edge-be`; `pnpm check:boundaries` (no rate-limit cycle, D-17); `pnpm check:table-ownership --strict` (no line for `infrastructure/rate-limit`); a grep shows no `@nestjs/throttler`, `throttle_api_*`, `skipThrottle` or `Idempotent-Replayed` left in `packages/` and `apps/`. Suites of the apps that lost the throttler (`apps/core`, `apps/sse-gateway`, domain e2e that asserted a global `429`) are run once after step 4.

## Ops artifacts

Success criteria that no automated test proves. Each is also a row in `specs/UNVERIFIED.md` with status "not run"; none is verified.

- **SC-001 (4 instances)**: AS-80 proves two instances. To run: `pnpm loadtest:ratelimit` (k6) at 2x the limit across 1, 2 and 4 instances, 0 overshoot.
- **SC-002** (lease-served decision < 1 ms p99; 100,000 decisions/s with ≤ 10 % store calls): no latency or throughput test (AS-21 proves the call ratio only). To run: k6/benchmark on the VPS runner.
- **SC-003** (no request waits for a timeout for 2 s at a time after three failures; no limiter-caused 5xx on fail-open routes under load): AS-26/27/30 prove it on single requests. To run: stop Redis under k6 load and read the latency histogram.
- **SC-007** (100 % of routes limited, defaulted or exempt): AS-66/68/71 prove the mechanism on the probe module. To run: a boot-time listing of every route of `apps/core` with its policy source, expecting no gap and a logged exempt list.

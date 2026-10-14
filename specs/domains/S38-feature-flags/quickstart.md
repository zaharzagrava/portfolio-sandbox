# Quickstart: S38 Feature flags — validation guide

Run backend commands from `packages/backend`. Prerequisites: the test stack of `docker-compose.test.yaml` up (Postgres, Redis), migrations applied (includes the new flags migration).

## Automated proof

| Scope | Command |
|---|---|
| Unit | `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/experimentation/domain` |
| One e2e file | `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/experimentation/flags-admin.e2e-spec.ts` (likewise `flags-lifecycle`, `flags-sdk`, `flags-client`, `flags-audit`, `flags-gate`) |
| Whole capability, once at the end | the six files above, each in a fresh process (L-008) |
| Static | `pnpm tsc --noEmit`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:module-graph`, `pnpm check:model-registry`, `pnpm check:table-ownership --strict` (no `experimentation` line) |
| Contracts | `tsc --noEmit` in `packages/contracts` and the BFF upstream spec |
| Living spec | `python3 scripts/livespec/check.py` |

## Real applications (L-004 / L-015)

Automated: `apps/core/src/flags-wiring.e2e-spec.ts`, `apps/worker/src/flags-wiring.e2e-spec.ts` and `apps/sse-gateway/src/flags-wiring.e2e-spec.ts` start the real `CoreModule`, `WorkerModule` and `SseGatewayModule` against the test stack and check the flags routes, the ready SDK, the repair schedule and the realtime route. What they do not prove is a start with the Redis cache stopped at process level (the SDK-level proof is AS-20 in `flags-sdk.e2e-spec.ts`); that stays in the smoke below.

## Manual smoke (real processes)

1. Start `apps/core`, `apps/worker` and `apps/sse-gateway` as processes; each must reach ready with the Redis cache stopped (AS-20).
2. As an admin: `PUT /api/admin/flags/new-checkout` with `expectedVersion: 0` → `201`; `GET /api/flags` with `X-Anonymous-Id: smoke-visitor-1` shows the flag; `POST …/kill` → the next `GET /api/flags` shows the off variant within 1 s; a `PUT` with `enabled: true` → `409 flag_killed`.
3. Flush the cache, save again: the published version is the database version + 1 and the SDKs apply it.

If the sandbox refuses to start the real apps, record the task as blocked (as S36 and S47 did); do not describe it as verified.

## Ops artifacts

Criteria no automated test proves (also in `specs/UNVERIFIED.md`, status `not run`):

- **SC-001**: the evaluator sustains more than 1,000,000 evaluations per second per CPU core. Run `pnpm --dir packages/backend bench:flag-evaluator` (`scripts/bench-flag-evaluator.ts`: a Node microbenchmark over a 500-flag ruleset) on the target hardware and record the number.
- **SC-008**: `GET /api/flags` p99 under 50 ms at 500 flags. Run `pnpm --dir packages/backend loadtest:client-flags` (`scripts/load-tests/client-flags.test.js`, k6; its header says how to seed 500 flags and lift the per-IP limit) against the load-test stack and record the p99.

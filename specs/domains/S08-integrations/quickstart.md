# Quickstart: validating S08 end to end

Run backend commands from `packages/backend`. Prefer the narrow test; whole suite once at the end. Prerequisites: test stack up (`docker-compose.test.yaml`: Postgres, Redis, Kafka, ElasticMQ with `integration-sync`, `integration-backfill` and their DLQs; reload the queue server after changing `elasticmq.conf`, L-020: `scripts/infra/reload-queues.sh` restarts only the dev stack's ElasticMQ container and waits for `/health/ready`; the test stack's `marketplace_test_elasticmq` is restarted with `docker restart marketplace_test_elasticmq`. Verified T004: both queues and both DLQs (5 / 3 receives, visibility 300 s / 900 s) are already in `infra/docker/elasticmq/elasticmq.conf` and `infra/stack/main.tf`, so no reload was needed), migrations applied (expand + data + contract).

## Scenarios

| # | Proves | Command | Expected |
|---|---|---|---|
| 1 | Pure domain (AS-14/15/45, 27/29, 07, 68, 16, 57, 59, 61/63) | `pnpm jest libs/domains/catalog-sync/domain` | all unit specs green incl. `fast-check` properties |
| 2 | Connect and OAuth (AS-01–11) | `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/catalog-sync/integration-connect.e2e-spec.ts` | green; no token in DB or logs |
| 3 | Incremental/backfill (AS-12–25) | `…/integration-sync.e2e-spec.ts` | green |
| 4 | Webhooks (AS-26–34) | `…/integration-webhooks.e2e-spec.ts` | green |
| 5 | Stock (AS-35–46) | `…/integration-stock.e2e-spec.ts` | green; provider write log matches spec |
| 6 | Quarantine (AS-47–53) | `…/integration-quarantine.e2e-spec.ts` | green |
| 7 | Resilience (AS-54–60) | `…/integration-resilience.e2e-spec.ts` | green; limiter-down and breaker faults forced |
| 8 | Reconciliation (AS-61–66) | `…/integration-reconcile.e2e-spec.ts` | green |
| 9 | Management API (AS-67–72) | `…/integration-manage.e2e-spec.ts` | green; role × route matrix |
| 10 | Lifecycle, events, secrets (AS-73–79) | `…/integration-lifecycle.e2e-spec.ts` | green |
| 11 | Boundary (AS-80) | `…/integration-boundary.e2e-spec.ts`; `pnpm check:table-ownership --strict`; `pnpm check:boundaries`; `pnpm check:module-graph` | zero cross-owner lines for this domain |
| 12 | Static | `pnpm tsc --noEmit` (backend + contracts), ESLint | clean; direct `sequelize.transaction` count in domain not raised |
| 13 | Boot (L-004/L-015/L-018) | start `apps/core`, the worker app and `apps/projector` each standalone, then `apps/local-monolith`; hit `/health` | each boots alone; no missing import/provider |
| 14 | Fresh stack (L-012, L-019) | `scripts/qa/fresh-run.sh` then the whole capability suite in per-file batches (L-008) | every batch prints its summary line |
| 15 | Living spec | `python3 scripts/livespec/check.py` | `[proof:]`/`[code:]` references true for `docs/spec/capabilities/S08-integrations.md` |
| 16 | Browser journey (W04) | `packages/web/tests/seller-integrations.spec.ts` with `PW_EXPECT_TIMEOUT_MS`, 2 workers | connect → `ACTIVE` → products listed (blocked until W04 page exists) |

Manual smoke against fakes: start the stack, run `test/fakes/fake-shopify.ts` on a local port, `POST …/shopify/install`, follow `authorizeUrl` to the fake, observe `302 ?connected=`, run the worker, `GET …/integrations/:id` shows `lagSeconds` and counts.

## Ops artifacts

Success criteria no automated test in this capability proves (each also a row in `specs/UNVERIFIED.md`, status `not run`; never described as verified):

- **SC-001** — 50,000 variants visible within 15 min while a small shop's sync is delayed ≤ 1 min: load run with the fake Shopify serving 50k variants plus a concurrent small shop; measure run records.
- **SC-002** — change visible ≤ 30 s p99 with webhooks, ≤ 6 min with all webhooks lost: timed run of N webhook-triggered changes, then the same with webhooks dropped (real queue latency).
- **SC-003** — 1,000 randomly interleaved stock changes on both sides converge with no ping-pong and ≤ 30 s p99 push latency: randomized soak against both fakes.
- **SC-004** — 50 random worker kills during a 20,000-variant sync end identical to an uninterrupted run: kill/restart loop script comparing final state.
- **SC-005** — one malformed item among 100,000: scale run checking quarantine rows once each and applied-good count.
- **SC-006** — provider never sees more than N calls per window for any number of workers: multi-instance (>2) load run reading the fake's request log (AS-55 proves two instances only).
- **SC-010** — first products visible within 5 min of returning to the dashboard (1,000-variant store): benchmark including the W04 page.

## Execution record (2026-10-15)

- Step 1: `libs/domains/catalog-sync/domain` unit specs, 12 suites / 331 tests green.
- Steps 2-11: the 11 `integration-*.e2e-spec.ts` files plus `catalog-import` and `sync` ran in per-file batches through `scripts/sdd/test-spec.sh`, each printed its summary line, all green; the four `integrations-wiring.e2e-spec.ts` (core, worker, projector, local-monolith) green.
- Step 12: `pnpm tsc --noEmit`, `pnpm exec eslint libs/domains/catalog-sync --quiet` (0 errors), `check:boundaries`, `check:module-graph`, `python3 scripts/livespec/check.py` (0 errors). `check:table-ownership --strict` still lists two lines in the catalog-sync section: `catalog-import.service.ts` (S07) and `sync.service.ts` (S09), not S08 code (see gaps.md).
- Step 13: `core`, `worker`, `projector` booted standalone via `scripts/infra/boot-app.sh`; `local-monolith` now booted the same way (`boot-app.sh local-monolith`, port 8012): UP, consumers and job handlers registered.
- Step 14: `scripts/qa/fresh-run.sh --here` (the runner's stack, not a throwaway one) passed boot-check and doctor-live. A throwaway empty-stack run was not made.
- Step 16: NOT run. `packages/web` has no integrations page or `seller-integrations.spec.ts` (W04 not built); blocked, not passed.

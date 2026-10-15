# Quickstart: validating S15 — Seller Payouts (domain `payments`)

Run from `packages/backend` unless stated. Use the condensed runner; open the full log it prints only when the summary is not enough. If the same test still fails after 5 fix attempts, stop and write the blocker, what was tried and the hypothesis into `questions.md`.

## Prerequisites

- Test engines up (`docker-compose.test.yaml`: Postgres, Redis, Kafka stand-in); migrations applied by the harness (`pnpm test:stack:migrate`) — includes `…-s15-payouts-expand`. Production deploy order: expand migration → worker with `PayoutsWorkerModule` (jobs registered, schedules upserted) → core with `PayoutsModule` → (a later release, after AS-53's verification on the target database) `…-s15-payouts-contract`; tenancy drops `Shop.stripeAccountId` in its own later step.
- Config (startup fails naming the key and the rule; a secret is never printed): `stripe_secret_key` (provider credential, required by the base config), `PAYOUT_CURSOR_SECRET` (≥ 32 bytes, not the session secret; falls back to the ledger cursor secret rule). Defaults: `PAYOUT_DEFAULT_RESERVE_BPS=1000`, `PAYOUT_MIN_MINOR=1000`, `PAYOUT_CAP_MINOR=5000000`, `PAYOUT_DESTINATION_COOLING_HOURS=48`, `PAYOUT_PROVIDER_TIMEOUT_MS=10000`, `PAYOUT_SEND_MAX_ATTEMPTS=5`, `PAYOUT_RESOLVER_MAX_RESENDS=3`, `PAYOUT_STALE_SENDING_MS=300000`, `PAYOUT_IN_DOUBT_AFTER_HOURS=24`. Specs bind the scriptable `FakePayoutProvider` to `PAYOUT_PROVIDER` and the scriptable `FakeShopSummary` to `SHOP_SUMMARY_PORT`; no spec calls Stripe.
- Fixtures: balances are created by `LedgerService.postJournal` in a test transaction (never by inserting entries); shops are fresh UUIDs registered with the tenancy double; members come from S03's fixture, admins from S01's; destinations are set through the real operator route; payouts for API tests come from the real run. Each test creates its own shops and data (L-005, L-006) and `clean()` truncates the payout tables.

## Narrowest proofs, in work-package order

```bash
S=/opt/sdd/repo/scripts/sdd/test-spec.sh
npx jest libs/domains/payments/domain/reserve libs/domains/payments/domain/period libs/domains/payments/domain/payout-state \
         libs/domains/payments/domain/eligibility libs/domains/payments/domain/destination \
         libs/domains/payments/domain/payout-backoff libs/domains/payments/domain/provider-answer   # WP-1 unit: AS-04, 09, 13, 25, 27, 35, 38, 39
npx jest ../contracts/src/payments/payout-events                                                      # WP-1: six payloads parse with S15, S28 and S43 schemas
$S libs/domains/payments/payout-run                  # WP-4: AS-01…AS-16, AS-39 (run half), AS-55 (+ AS-14 schedule rows)
$S libs/domains/payments/payout-transfer             # WP-5/6: AS-17…AS-30
$S libs/domains/payments/payout-api                  # WP-7: AS-31…AS-36, AS-38…AS-48
$S libs/domains/payments/payout-ops                  # WP-8/10: AS-49…AS-54
```

AS-37 is the W04/J01 browser journey (`packages/web/tests/seller-payouts.spec.ts`, `buy-to-payout.spec.ts`): this capability provides AS-31 and AS-35; the journey is not run here.

Whole capability once at the end: `$S libs/domains/payments` (batches of fresh processes; a batch with no summary line is a crash, not a flaky test: L-008), then the suites that import payments or depend on its seams and must stay green: `libs/domains/marketing` (ledger exports), `libs/domains/tenancy` (`ShopQueryService`), `libs/domains/identity` (ownership gates), `libs/infrastructure/jobs`, `libs/infrastructure/idempotency`, `libs/infrastructure/rate-limit`, `libs/infrastructure/outbox`, `libs/infrastructure/events`, `libs/infrastructure/stripe`, `libs/domains/developer-platform` and `libs/domains/notifications` (the contract specs that parse payout payloads).

## Static gates

```bash
npx tsc --noEmit -p tsconfig.json && npx eslint libs/domains/payments libs/infrastructure/stripe libs/common/config
# packages/contracts has no tsconfig of its own: the backend `tsc` above checks the schemas it imports
pnpm check:boundaries
pnpm check:table-ownership --strict    # expect 0 findings for payments (baseline recorded in .ownership.baseline = 0); no ShopModel/UserModel row; no FK to Shop
pnpm check:module-graph                # no orders <-> payments cycle added
pnpm check:no-wallclock                # no Date.now()/new Date() in payout domain/application/infra (the clock is injected)
pnpm check:model-registry              # nine new models registered in payments-models.ts
grep -rn "sequelize.transaction" libs/domains/payments --include=*.ts | grep -v "spec.ts"   # expect 0 (baseline .tx.baseline = 0); no new "S54 T037 audit" comment
grep -rn "SessionNotRevokedGuard\|skipThrottle\|throttle:" libs/domains/payments/api   # expect nothing (S01 follow-up)
grep -rn "InjectModel(Shop\|ShopModel\|MembershipService\|FROM \"Shop\"" libs/domains/payments --include=*.ts | grep -v spec.ts   # expect nothing (S03 follow-up)
python3 ../../scripts/livespec/check.py   # run from the repo root; page docs/spec/capabilities/S15-payouts.md (no *.reviewed.json created)
```

## Boot proofs (wiring, L-004 / L-015 / L-018 / L-019: done by scripts at the final checkpoint, never skipped because jest is green)

```bash
# each deployable boots on its own with its real module graph (test stack up), answers its probe and exits cleanly on SIGTERM
pnpm --dir packages/backend build:worker && pnpm --dir packages/backend exec nest build core && pnpm --dir packages/backend exec nest build local-monolith
NODE_ENV=local node dist/apps/core/main          # PayoutsModule registered; GET /shops/<uuid>/payouts without a session answers 401
NODE_ENV=local PORT=8003 node dist/apps/worker/main   # PayoutsWorkerModule: payouts.* handlers and the weekly + resolver + audit schedules registered
pnpm --dir packages/backend start:dev:monolith   # both in one process (stop after the readiness probe answers)
```

**What worked on the runner (recorded at the final checkpoint).** Port 8000 was already taken by another process, so the built apps were started with a node env file instead of a shell prefix (`node --env-file=/tmp/core-boot.env dist/apps/core/main` with `NODE_ENV=local` and `PORT=8010`): `core` registered `PayoutsController` and `PayoutsAdminController`, answered `/health/ready` with `200` and `GET /api/shops/<uuid>/payouts` and `GET /api/finance/payouts` without a session with `401`. `pnpm start:dev:worker` (port 8003) started with `PayoutsCoreModule` and `PayoutsWorkerModule` initialized and `payouts.run-weekly`, `payouts.send`, `payouts.resolve-in-doubt`, `payouts.audit-daily` in the `JobRegistry` line. `pnpm exec nest build local-monolith` printed a type-checker out-of-memory notice (the fork-ts-checker plugin; `npx tsc --noEmit -p tsconfig.json` is clean) and still compiled; its boot result is in `gaps.md` "Runtime proofs". No queue-server reload is needed: no SQS queue is added; topic `payouts.events` is registered by `EventsModule.forAggregates([PAYOUTS_AGGREGATE])`.

(The exact ports and env follow `package.json` scripts `start:dev:worker` and `start:dev:monolith`; WP-0 records the commands that actually worked on the runner. Each is run with a 30 s timeout and a `curl` of the readiness probe; a missing provider is a boot failure to fix, not to skip.) After the boot: the job table has the `payouts.run-weekly` schedule at `0 6 * * 1 Europe/Warsaw`, `payouts.resolve-in-doubt` and `payouts.audit-daily` rows (re-boot adds none); topic `payouts.events` exists (L-002/L-020: no queue-server reload is required because no SQS queue is added; the Kafka topic is created by the test-stack bootstrap or on first produce — WP-0 records which).

## Empty-stack proof (L-012)

`scripts/qa/fresh-run.sh` (or the repository's equivalent) on a fresh stack: migrations from zero, then `$S libs/domains/payments/payout-run` and `payout-ops` (AS-53 seeds old-shape rows itself). Run once at the final checkpoint.

## Ops artifacts (success criteria no automated test proves — status `not run`; rows are also in `specs/UNVERIFIED.md`)

| Criterion | How to run it |
|---|---|
| **SC-001** at 1,000 shops: repeated, raced and interrupted runs end with one payout and one journal per shop | seed 1,000 eligible shops through `postJournal` and the tenancy double in the compose stack; run `payouts.run-weekly` for one period 5 times (2 concurrently), kill the worker once mid-run, restart; assert `SELECT count(*), count(DISTINCT "shopId") FROM "Payout" WHERE "periodStart"=…` equal 1,000, one `PAYOUT` journal per payout, `assertBooksHealthy` (sum of lines 0, `PAYOUT_CLEARING` = sum of non-final payouts) |
| **SC-005** p95 < 300 ms for the payouts page with 5 years of weekly history; a status change visible within 10 s | seed one shop with 260 payouts; `k6` 50 VUs for 2 minutes on `GET /shops/:shopId/payouts?limit=20` (and one page deep by cursor); read p95; flip one payout to `PAID` and poll until the list shows it |
| **SC-007** a run over 1,000 shops < 5 minutes with ≤ 20 tenancy+ledger calls for listing and eligibility | time the 1,000-shop run above from `startedAt` to `finishedAt` in `PayoutRun`; count calls from the tenancy double's and ledger adapter's log (expected 5 + 5 + 5) — the 450-shop count is already an automated test (AS-12) |
| **Monolith boot proof** the `local-monolith` bundle with S15 starts on its own | stop any stray monolith on port 8000 or pick a free `PORT`; run the bundle with the `start:dev:monolith` environment and wait past 100 s; expect "successfully started", `GET /health/ready` 200, and `GET /shops/:shopId/payouts` and the admin payout routes answering 401/403 rather than 404. Status `not run`: the earlier start was inconclusive and this pass could not launch it |

SC-002, SC-003, SC-004, SC-006, SC-008, SC-009 and SC-010 are proven by automated tests (plan "Success-criteria proof"); nothing is described as verified until its row says so and the suites have been run.

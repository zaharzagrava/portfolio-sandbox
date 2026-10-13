# Quickstart: validating S14 — Ledger and Reconciliation (domain `payments`)

Run from `packages/backend` unless stated. Use the condensed runner; open the full log it prints only when the summary is not enough.

## Prerequisites

- Test engines up (`docker-compose.test.yaml`: Postgres, Redis, Kafka/SQS stand-ins, DynamoDB local); migrations applied by the harness (`pnpm test:stack:migrate`); the `LedgerBalanceView` table created by the harness from `dynamodb/LedgerBalanceView.json`. Production deploy order: expand migrations (`…-s14-ledger-expand`, `…-s14-ledger-journal-amount`, `…-s14-reconciliation-expand`, `…-s14-ledger-indexes`) → worker with the new consumer and jobs, then run `ledger.backfill-balances` to completion (resumable) → core/payment-processor/projector with the switch → (a later release, after the verification of AS-64) `…-s14-ledger-contract`.
- Config (startup fails naming the key without them): `stripe_secret_key`, `LEDGER_CURSOR_SECRET` (≥ 32 bytes). Defaults: `LEDGER_FEE_MINOR=50`, `LEDGER_SHARDS=32`, `LEDGER_LOCK_TIMEOUT_MS=2000`, `LEDGER_STATEMENT_TIMEOUT_MS=5000`, `RECONCILIATION_PAGE_SIZE=100`, `RECONCILIATION_CATCHUP_DAYS=7`. Specs bind the scriptable `FakeProviderStatement` to `PROVIDER_STATEMENT`; no spec calls Stripe.
- Fixtures: sales/refunds are created through `LedgerService`, `order.paid` messages are contract-valid fixtures from `packages/contracts`, shops are plain UUIDs, members come from S03's fixture, admins from S01's; no spec seeds another domain's model.

## Narrowest proofs, in work-package order

```bash
S=/opt/sdd/repo/scripts/sdd/test-spec.sh
npx jest libs/domains/payments/domain                          # WP-1 unit: journal, account, fee, shard, split, retry, lock order, version guard, matcher, window, run/issue states
$S libs/domains/payments/ledger-posting                        # WP-2/3: AS-01…AS-10, AS-26, AS-28, AS-29 (+ AS-03, AS-06 store checks)
$S libs/domains/payments/ledger-hot-accounts                   # WP-4: AS-22…AS-27
$S libs/domains/payments/ledger-payment-postings               # WP-5: AS-11…AS-21
$S libs/domains/payments/ledger-balances                       # WP-6: AS-30…AS-37
$S libs/domains/payments/reconciliation-run                    # WP-7: AS-38…AS-50
$S libs/domains/payments/reconciliation-issues                 # WP-8: AS-51…AS-59
$S libs/domains/payments/ledger-maintenance                    # WP-9/11: AS-60…AS-64
$S libs/domains/payments/ledger-ops                            # WP-10: AS-65…AS-69
```

Whole capability once at the end: `$S libs/domains/payments`, then the suites that import payments or depend on its seams and must stay green: `libs/domains/marketing` (ad billing on `postJournal`/`getBalances`), `libs/domains/orders` (payment events/webhook), `libs/infrastructure/rate-limit`, `libs/infrastructure/idempotency`, `libs/infrastructure/events`, `libs/infrastructure/projections`, `libs/infrastructure/jobs`, `libs/domains/identity` (ownership gates), `libs/domains/tenancy`.

## Static gates

```bash
npx tsc --noEmit -p tsconfig.json && npx eslint libs/domains/payments libs/domains/marketing libs/infrastructure/stripe libs/common/config
# packages/contracts has no tsconfig of its own: the backend `tsc` above checks the schemas it imports
pnpm check:boundaries
pnpm check:table-ownership --strict   # expect 0 findings for the ledger/reconciliation files; the report for `payments` shows no UserModel, BisOrderModel or ShopModel row (baseline was 3; record the output)
pnpm check:module-graph               # no orders <-> payments cycle
pnpm check:no-wallclock               # no Date.now()/new Date() in ledger domain/application/infra (reconciliation day comes from the injected clock)
pnpm check:model-registry
grep -rn "sequelize.transaction" libs/domains/payments --include=*.ts | grep -v spec   # expect 0 (baseline 4, all four migrated to TransactionRunner.run); no "S54 T037 audit" comment left
python3 ../../scripts/livespec/check.py   # run from the repo root; page docs/spec/capabilities/S14-ledger-reconciliation.md
```

## Manual spot checks (local stack)

1. Capture a sale through the S13 flow (or `LedgerService` in a REPL spec) → `LedgerJournal` has one `SALE` row; `AccountBalance` shows `PLATFORM_FEES` +50 on one shard; `GET /api/shops/<shop>/balance` (member token) → `200 {availableMinor, asOf, source:"read_model"}` after settlement (≤ 5 s).
2. `curl -i -X POST localhost:3000/api/finance/reconciliation/issues/<id>/resolve -H "Authorization: Bearer $ADMIN" -H 'Idempotency-Key: demo-resolve-0001' -H 'content-type: application/json' -d '{"resolution":"explained","note":"fee rounding"}'` → `200`; repeat → same body + `Idempotency-Replayed: true`; with a seller token → `403`.
3. Stop the statement double mid-run: `payments.reconcile-daily` ends `FAILED(provider_unavailable)`, no issues stored; restart it → the job's next attempt completes the day.

## Ops artifacts (success criteria no automated test proves)

These are **not verified**. Each has a row in [`specs/UNVERIFIED.md`](../../UNVERIFIED.md) with status `not run`.

| Criterion | What is not proven | How to run it |
|---|---|---|
| SC-004 | the balance page answers under 100 ms at the 99th percentile with 100 million entries stored (the e2e proves no query sums history and one hot-store read, on a small table) | On the VPS runner stack: load 100 M synthetic entries through `ledger.backfill-balances`' fixture generator (partitioned, 36 months), then k6 for 5 minutes, 50 VUs, `GET /shops/:shopId/balance` with member tokens over 10 000 shops; read `http_req_duration` p99; also run with Redis stopped (durable path) and both stores stopped (ledger path). |
| SC-005 (percentile) | a balance change is visible within 5 seconds at the 99th percentile under production-like load (AS-37 proves the bound on an advanced clock with the projector running, and that the endpoint stays correct with the fast store down) | Run the load of SC-003 (200 captures/s for 10 minutes) with the real outbox relay and Kafka; poll the endpoint of the credited shop every 100 ms and record time from commit (`LedgerJournal.postedAt`) to first visible value; read `ledger_balance_projection_lag_seconds` p99; must be < 5 s. |

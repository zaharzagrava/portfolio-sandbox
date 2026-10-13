# Quickstart: validating S36 sponsored listings

Contracts: [ads-api.md](contracts/ads-api.md), [events.md](contracts/events.md). Stores: [data-model.md](data-model.md). Scenario → file mapping: [test-plan.md](test-plan.md).

## Prerequisites

- Test stack up (`docker-compose.test.yaml`: PostgreSQL migrated with the S36 migrations, Redis, Kafka stand-in, ClickHouse, DynamoDB Local). Topics `marketing.events`, `ads.clicks`, `ads.click-aggregates`, `ads.clicks.dlq` exist in the stack (L-002, L-011: compare with the doctor); ClickHouse has `clickhouse/081_ads_v2.sql` applied (`pnpm clickhouse:migrate`; the e2e fixture also applies the DDL itself). The old Kafka-engine tables are gone: a stack created before S36 must run `081_ads_v2.sql` or the old queue tables keep reading `ads.clicks`.
- Required configuration (test values are in the config mock; production values are secrets): `ads_click_secret` (≥ 32 bytes, different from `jwt_secret` and `share_link_code_key`), `ads_click_secret_previous` (optional, ≥ 32 bytes, different from the current one), `ads_spam_ip_per_minute` (20), `ads_spam_repeat_per_hour` (3), `ads_aggregator_instance` (stable slot name of this worker replica: **distinct between live replicas**, otherwise they fence each other), `front_host` (https origin without path; the web app's `SITE_URL` is the same origin), `trusted_proxies`. `share_link_secret` is no longer read by anyone and is removed; a `.env.test` copied before S36 needs the new keys added.
- **Key rotation (operations)**: put the new secret in `ads_click_secret`, the old one in `ads_click_secret_previous`, deploy; after 30 minutes remove the previous one.

## Run

From `packages/backend` (L-008: batches of fresh processes; each prints a condensed result and the log path):

```bash
pnpm test -- libs/domains/marketing libs/common/config                           # unit specs U1–U8 and config rules
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/ads-campaigns.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/ads-readmodels.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/ads-serving-clicks.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/ads-aggregation.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/ads-billing.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/ads-platform.e2e-spec.ts
```

Expected: every file's summary shows 0 failed; a batch without a summary line is a crash, not a flaky test (L-008).

## Static gates (AS-80, AS-81)

```bash
pnpm --dir packages/backend exec tsc --noEmit -p tsconfig.json
pnpm --dir packages/contracts exec tsc --noEmit
pnpm --dir packages/backend check:boundaries
pnpm --dir packages/backend check:module-graph
pnpm --dir packages/backend check:model-registry
pnpm --dir packages/backend check:no-wallclock
pnpm --dir packages/backend check:table-ownership --strict    # no marketing ads line (baseline was 1)
python3 scripts/livespec/check.py                              # docs/spec/capabilities/S36-sponsored-listings.md
```

Transaction ratchet: `grep -rn "sequelize.transaction" packages/backend/libs/domains/marketing | grep -v share-link` prints nothing (baseline was 2).

## Start the real applications (L-004, L-015)

`scripts/qa/fresh-run.sh` on an empty stack, then confirm `apps/core` (campaign and slot routes registered), `apps/worker` (aggregator started, `ads.bill-hour` and `ads.reconcile-day` registered, `ads_aggregator_instance` validated) and `apps/projector` (consumers `ads-product-snapshot` and `ads-shop-snapshot` declared) all boot. Smoke: as a shop owner `POST /api/shops/<id>/ads/campaigns`, `GET /api/ads/sponsored?category=all` shows the slot with a `clickUrl`, `curl -si $BASE<clickUrl>` answers `302` to `front/p/<productId>?ad=1`, a second `curl` answers the same redirect and `ads_clicks_total{outcome="duplicate"}` rises.

## Ops artifacts (no automated test proves these; rows in `specs/UNVERIFIED.md`, status "not run")

- The script `scripts/load-tests/ads-clicks.test.js` and the package script `loadtest:ads-clicks` are created by this change (T96).
- **SC-002** (95% of redirects within 200 ms; 100% redirect while the counting infrastructure is down): `pnpm --dir packages/backend loadtest:ads-clicks` against the real app, read the latency summary; repeat once with the broker stopped.
- **SC-005** (latency part): each closed hour charged within 15 minutes of its end and each day reconciled within 4 hours of its end: with the job fleet running, read `ads_billing_lag_seconds` and the `finishedAt` of the day's `AdReconciliationRun`. The schedules (`5 * * * *`, `30 2 * * *`) and the idempotency are proven by AS-50–AS-56 and AS-58–AS-63.
- **SC-007** (alert): a drift above 1% raises an alert the same day: route `ads_reconciliation_drift_ratio` per `docs/ops/runbooks/AdReconciliationDrift.md`; the metric and the warning are asserted by AS-65.
- **SC-008 / AS-83** (capacity): the same load script replays 10 million synthetic clicks (10% duplicates, 5% invalid) at 50,000 clicks/s over 64 partitions; check the raw-log distinct-valid count equals the generator's ground truth, the aggregates sum to the same number, no partition above 15% of one campaign's traffic.
- **SC-009** (99% within 60 s): measure the p99 of the projection lag of `ads-product-snapshot` and `ads-shop-snapshot` under load; a seller action is immediate and is proven by AS-08.
- **UI journeys** (W02 `sponsored-listing.spec.ts`, W04 `ad-campaign.spec.ts`): owned by the web capabilities; they do not exist yet. The API halves are proven by AS-01, AS-08, AS-16 and AS-26.

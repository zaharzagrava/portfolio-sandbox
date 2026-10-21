# Why the architecture-scan tests failed in the sharded run

## Cause
The shared helper (test/utils/static-checks.ts) works. Running the same command by hand (`pnpm --silent check:boundaries` in packages/backend) reported ONE real rule break:
apps/projector/src/pickup-wiring.e2e-spec.ts imported `@app/domains/fulfilment/infra/availability-index` (a file inside another domain). A speed-up helper added that import when it made the search-index name carry the shard prefix. The rule "outside a domain, only use the domain's front door" then failed, and every test that checks "the scan is clean" failed with it (assistant-platform, import-boundary, search-platform, trending-platform, autocomplete-platform, ownership-gates, public-api-boundary, analytics-ops, video-events, ads-platform, payment/ledger/payout, and so on). Not the cwd, pnpm path, shard variables, timeouts or the globalThis sharing.

## Fix
pickup-wiring.e2e-spec.ts now calls `shardName('pickup_availability_v2')` from `@app/common/shard` (same name, no deep import). The scan is clean again (4489 modules, 0 violations); the table-ownership scan (plain and strict) is clean.

## Second small cause
content/story-tenancy.e2e-spec.ts used `require('./index')`, which Vitest cannot resolve for a .ts file. Changed to `await import('./index')` (same check on the same list of exports).

## Still failing, real old problem (kept on the list, not hidden)
- orders/orders-boundary "application and api code import nothing from infra": libs/domains/orders/application/voucher.service.ts imports `../infra/models/voucher.model`. File not touched by the speed-up work; old violation.
- catalog/product-shop-lifecycle S05 AS-80 (Product.shopId nullable): old failure.

## Log/metric "no token" tests
collab-ops, projections/observability, billing-ops, request-context, search-query pass when run alone on shard 5. Their failures in the full run came from other things (websocket closed, Kafka topic creation, missing Redis), not from the shard prefix or logger reset, and not from the scans.

## Result on shard 5 (run alone)
22 files run: 20 pass, 2 fail (the two real old ones above).
Note: `shard-run.sh 5 1` is refused by the script (shard must be <= total), so a small wrapper in the scratchpad set the shard 5 names and ran vitest on named files.

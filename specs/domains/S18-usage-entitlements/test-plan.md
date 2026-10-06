# Test Plan: S18 — Usage Metering (late events, adjustments) and Entitlement Checks (domain `billing`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (57 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. No row is proven twice.

- **API e2e files** live in `packages/backend/libs/domains/billing/`; each file's top-level `describe` names its feature (VII.8). They boot the real `BillingModule`, the billing worker/consumer module and a tiny fixture controller carrying `RequiresShopEntitlement` with the production prefix, `ValidationPipe`, problem+json filter and interceptors, against real Postgres (real migrations), Redis, the usage store (ClickHouse of the production major version) and the consumer, inbox and DLQ tables from `docker-compose.test.yaml`. Only the clock (frozen) and system edges are faked. The S17 basis source is S17's real `SubscriptionBasisService` over seeded subscriptions; where a scenario needs a slow, failing or counting basis, the spec wraps the *edge-free* port with a spy that delegates to the real service (a spy, not a stub). Each test asserts the response or return value **and** the persisted state (usage rows, ledger rows, cache keys, inbox/DLQ rows, metrics) (VII.2).
  - `entitlements.e2e-spec.ts` — describe "Billing: entitlement checks" (AS-01, AS-02, AS-06, AS-08, AS-09, AS-10, AS-11)
  - `entitlements-cache.e2e-spec.ts` — describe "Billing: entitlement cache and invalidation" (AS-12 to AS-21)
  - `usage-ingestion.e2e-spec.ts` — describe "Billing: usage ingestion" (AS-22 to AS-31)
  - `usage-invoice-lines.e2e-spec.ts` — describe "Billing: usage lines, settlement and late adjustments" (AS-32, AS-37, AS-38, AS-42 to AS-47)
  - `usage-migration.e2e-spec.ts` — describe "Billing: usage ledger migration" (AS-48)
  - `usage-read.e2e-spec.ts` — describe "Billing: usage read" (AS-49 to AS-55)
  - `billing-observability.e2e-spec.ts` — describe "Billing: usage and entitlement observability" (AS-57)
- **Unit files** are pure `domain/` logic, table-driven, with `fast-check` for the money invariants (VII.5): `domain/usage-overage.spec.ts`, `domain/usage-adjustment.spec.ts`, `domain/entitlements.spec.ts`.
- **UI journey**: no web capability owns a usage, entitlement or billing screen (S17 recorded the same), so the UI column is a dash for every row. When a web capability adds a usage page, one Playwright happy path (open usage page, see `used` against `limit`) belongs to AS-49 and nothing else.
- **Static layer** (VII.1): AS-56 is proven by the merge-blocking checks `pnpm --dir packages/backend check:boundaries` and `pnpm --dir packages/backend check:table-ownership --strict` plus `tsc --noEmit` and ESLint; there is no runtime test for it.
- **Contract layer** (VII.6): every HTTP e2e parses its body with `usageSummarySchema` / `problemSchema` from `packages/contracts`.
- **Async consumers** (VII.4): each of the three consumers has a duplicate-delivery test (AS-15, AS-23, AS-27) and an invalid-payload test (AS-18, AS-28).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 entitlements of a live subscription (`ACTIVE`, `PAST_DUE`, `TRIALING`) | `entitlements.e2e-spec.ts` | — | — |
| AS-02 free tier when no live basis (`UNPAID`, none, `CANCELED`; buyer `{}`) | `entitlements.e2e-spec.ts` | — | — |
| AS-03 boolean `hasEntitlement` | — | — | `domain/entitlements.spec.ts` (`it.each` over keys and values) |
| AS-04 numeric keys positive = present, missing = false | — | — | `domain/entitlements.spec.ts` |
| AS-05 unknown feature rejects `unknown_entitlement` (also for `checkLimit`, `checkQuota`) | — | — | `domain/entitlements.spec.ts` |
| AS-06 batch read: one batch call, dedupe, empty, 501 rejects | `entitlements.e2e-spec.ts` | — | — |
| AS-07 `checkLimit` boundaries, missing limit, non-limit key, invalid current | — | — | `domain/entitlements.spec.ts` (`it.each`) |
| AS-08 `checkQuota` with real usage, month reset, free tier, usage store down | `entitlements.e2e-spec.ts` | — | — |
| AS-09 guard: allowed, `403 entitlement_required`, non-member `404`, `401` | `entitlements.e2e-spec.ts` (fixture controller) | — | — |
| AS-10 misconfigured guard prevents startup | `entitlements.e2e-spec.ts` (module init rejects) | — | — |
| AS-11 basis down and nothing cached: `503 entitlements_unavailable`, handler not run | `entitlements.e2e-spec.ts` (forces the degradation path, VII.9) | — | — |
| AS-12 cache-aside and 300 s TTL | `entitlements-cache.e2e-spec.ts` | — | — |
| AS-13 stampede: 50 concurrent cold reads, one load (`Promise.all`) | `entitlements-cache.e2e-spec.ts` | — | — |
| AS-14 direct `invalidate` after S17 commit; plan visible in 5 s | `entitlements-cache.e2e-spec.ts` | — | — |
| AS-15 event invalidation, duplicate delivery counts once | `entitlements-cache.e2e-spec.ts` | — | — |
| AS-16 out-of-order versions, re-subscription, no-entry event | `entitlements-cache.e2e-spec.ts` | — | — |
| AS-17 slow load does not overwrite a newer state | `entitlements-cache.e2e-spec.ts` (controllable delay on the basis spy) | — | — |
| AS-18 invalid event payloads dead-lettered without effect | `entitlements-cache.e2e-spec.ts` | — | — |
| AS-19 stale on error up to 60 min, then `entitlements_unavailable` | `entitlements-cache.e2e-spec.ts` (forces the stale path, VII.9) | — | — |
| AS-20 cache store down: reads degrade, invalidation is not swallowed and is redelivered | `entitlements-cache.e2e-spec.ts` (forces the degradation path, VII.9) | — | — |
| AS-21 subject types isolated | `entitlements-cache.e2e-spec.ts` | — | — |
| AS-22 accepted `usage.recorded` event | `usage-ingestion.e2e-spec.ts` | — | — |
| AS-23 duplicate delivery counts once; different id counts | `usage-ingestion.e2e-spec.ts` (same message twice, VII.4) | — | — |
| AS-24 order independence | `usage-ingestion.e2e-spec.ts` | — | — |
| AS-25 `[start, end)` period boundary | — | — | `domain/usage-overage.spec.ts` (period attribution `it.each`) |
| AS-26 late arrival accepted into its period | `usage-ingestion.e2e-spec.ts` | — | — |
| AS-27 `llm.call_completed`: counts, `callId` identity, zero tokens, purpose metric | `usage-ingestion.e2e-spec.ts` | — | — |
| AS-28 validation classes dead-lettered with reason (one case per class) | `usage-ingestion.e2e-spec.ts` | — | — |
| AS-29 poison message does not block the partition | `usage-ingestion.e2e-spec.ts` | — | — |
| AS-30 failed store write is redelivered and counted once | `usage-ingestion.e2e-spec.ts` (forces the failure path, VII.9) | — | — |
| AS-31 duplicates inside one batch | `usage-ingestion.e2e-spec.ts` | — | — |
| AS-32 overage line and settlement plan, read-only | `usage-invoice-lines.e2e-spec.ts` | — | — |
| AS-33 no overage at or below the allowance | — | — | `domain/usage-overage.spec.ts` |
| AS-34 block rounding table, safe-integer rejection | — | — | `domain/usage-overage.spec.ts` (`it.each` + `fast-check`: monotonic, `amount = ceil(units/1000) × rate`) |
| AS-35 several metrics, stable order, byte-identical lines | — | — | `domain/usage-adjustment.spec.ts` |
| AS-36 subjects without included usage | — | — | `domain/usage-adjustment.spec.ts` |
| AS-37 settle: ledger row, idempotent by invoice id, `settlement_conflict` on a stale plan | `usage-invoice-lines.e2e-spec.ts` | — | — |
| AS-38 late events become an adjustment exactly once (800 late units → `50`) | `usage-invoice-lines.e2e-spec.ts` | — | — |
| AS-39 late events under the allowance | — | — | `domain/usage-adjustment.spec.ts` (`it.each`) |
| AS-40 late events inside an already-billed block; invariant sum = price(total) | — | — | `domain/usage-adjustment.spec.ts` (`it.each` + `fast-check`, SC-002) |
| AS-41 adjustments use the period's snapshot, not today's price | — | — | `domain/usage-adjustment.spec.ts` |
| AS-42 closed invoices and lines unchanged after an adjustment | `usage-invoice-lines.e2e-spec.ts` | — | — |
| AS-43 two renewals racing: exactly one settles | `usage-invoice-lines.e2e-spec.ts` (`Promise.all`, III.6) | — | — |
| AS-44 usage store down or slow: `usage_unavailable` within 5 s, nothing written | `usage-invoice-lines.e2e-spec.ts` (forces the degradation path, VII.9) | — | — |
| AS-45 invalid `linesFor` input | `usage-invoice-lines.e2e-spec.ts` | — | — |
| AS-46 a period closes at `periodEnd + 91 days` and is never queried again | `usage-invoice-lines.e2e-spec.ts` | — | — |
| AS-47 reconciliation: drift detected, report only, idempotent, single run | `usage-invoice-lines.e2e-spec.ts` (runs the job handler twice and two replicas) | — | — |
| AS-48 ledger migration of pre-release invoices, repeatable | `usage-migration.e2e-spec.ts` | — | — |
| AS-49 shop usage summary and contract shape | `usage-read.e2e-spec.ts` | — (dash today; one Playwright path when a usage page exists) | — |
| AS-50 month validation | `usage-read.e2e-spec.ts` | — | — |
| AS-51 who may read: `shop.read`, cross-tenant `404`, `401` | `usage-read.e2e-spec.ts` | — | — |
| AS-52 buyer usage, no subject parameter | `usage-read.e2e-spec.ts` | — | — |
| AS-53 rate limit `429` with `Retry-After`, fail closed | `usage-read.e2e-spec.ts` | — | — |
| AS-54 usage store down: `503 usage_unavailable`, generic detail | `usage-read.e2e-spec.ts` (forces the degradation path, VII.9) | — | — |
| AS-55 freshness within 30 s and exact reads | `usage-read.e2e-spec.ts` | — | — |
| AS-56 boundaries and ownership registry | — (static: `check:boundaries`, `check:table-ownership --strict`, `tsc`, ESLint) | — | — |
| AS-57 metrics and log hygiene | `billing-observability.e2e-spec.ts` | — | — |

## Traceability checks

- Every one of AS-01 to AS-57 appears in exactly one row; each edge case from the spec's notes appears once: idempotent replay (AS-15, AS-23, AS-27, AS-31, AS-37), out-of-order (AS-16, AS-24), concurrency (AS-13, AS-17, AS-43), illegal input (AS-05, AS-28, AS-45), cross-tenant (AS-09, AS-51, AS-52), limits (AS-07, AS-08, AS-28, AS-50), timeouts (AS-44), rate limit (AS-53), late events (AS-26, AS-38 to AS-41, AS-46), dependency down (AS-11, AS-19, AS-20, AS-30, AS-44, AS-54).
- Mandatory VII.3 cases for the two HTTP endpoints: happy path (AS-49, AS-52), validation (AS-50), `401` (AS-51), cross-tenant `404` (AS-51), rate limit `429` (AS-53). The guard fixture route covers `401`, `403`, `404` (AS-09). Idempotency-key and illegal-transition cases do not apply (`GET` only; no status machine in this capability).
- Gate VII.9: AS-11, AS-19, AS-20, AS-30, AS-44, AS-54 each force the fallback or degradation path.
- The recorded green run of `entitlements*.e2e-spec.ts`, `usage-*.e2e-spec.ts`, `billing-observability.e2e-spec.ts` and the three unit files is required before merge (VII.9).

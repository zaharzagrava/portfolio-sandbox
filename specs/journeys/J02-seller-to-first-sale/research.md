# Research: J02 — Seller to First Sale

Static audit of the code at commit `7f8816a0` against `gaps.md` (written before S01–S55 were built). Nothing was run. A row marked **verify** is settled by writing the journey slice first (it is the verifier) and fixing what fails; a row marked **OPEN** has direct evidence that the work is missing. The audit was done by grepping `packages/backend/libs/domains` and `apps`; it is not a proof that DONE rows work end to end.

## 1. Gap status today

| Gap | Status | Evidence / remaining |
|---|---|---|
| G-01 register `202` | verify | S01 built (`libs/domains/identity`); check status code, duplicate answer, own rate-limit policy and allow-list for the journey address. |
| G-02 bootstrap admin | **OPEN** | no `BOOTSTRAP_ADMIN_*` in `libs` or `apps`. J01 uses `pnpm seed:dev` (quickstart); J02 requires startup provisioning in the local profile. |
| G-03 `tenancy.shop_created` | DONE (verify) | `libs/domains/tenancy/domain/events.ts`, `tenancy-events.e2e-spec.ts`. |
| G-04 role by event | PARTIAL | `identity/infra/shop-owner-promotion.consumer.ts` exists but its group is `identity-shop-owner-promotion`; the contract name is `identity-seller-promotion`. Verify tenancy no longer runs `UPDATE "User"` (grep found none outside specs). |
| G-05 `POST /shops` key | verify | idempotency interceptor exists (`libs/infrastructure/idempotency`); confirm it is applied to the shop-create route. |
| G-06/G-07 verification events | PARTIAL | onboarding has `submissionNo` and events (`application/events/onboarding-events.ts`); tenancy projector `tenancy-verification` (`tenancy/infra/projectors/verification.projector.ts`); group name is not `tenancy-shop-lifecycle`. Verify topic `shop-onboarding`, payloads, `status` in the view. |
| G-08 rejection | PARTIAL | `REJECT_APPLICATION` exists in `review.service.ts`; verify `shop.rejected`, `REJECTED` state, sensitive admin routes, paged queue with shop names via R1. |
| G-09 approve → verified atomic + sweep | **OPEN (sweep)** | no `onboarding.verify-pending` anywhere outside specs; verify the atomic append in the approving transaction. |
| G-10 extract command via outbox, lease, DLQ | PARTIAL | `apps/lambdas/src/handlers/document-extractor.ts` and `…-dlq.ts` exist; verify outbox command and lease. |
| G-11 extractor in local deployment, model double | **OPEN** | the extractor is only in `apps/lambdas`; no `kyc-ok*`/`kyc-unclear` fixture or double found. |
| G-12 subscribe key, schema | DONE (verify) | `billing/api/shop-subscription.controller.ts` uses idempotency. |
| G-13 entitlements only after first charge | verify | `billing/application/entitlements.service.ts`, `plan-tier.service.ts`; confirm interim state and no pre-commit invalidation. |
| G-14 billing events | DONE (verify) | `billing/application/events/billing-events.ts` names `subscription_plan_changed`; confirm `from`, `planCode`, `subscriptionVersion` and same-transaction append. |
| G-15 `entitlements-invalidation` | **OPEN** | group name absent; confirm whether a consumer exists under another name. |
| G-16 `Shop.plan` | PARTIAL | `tenancy/infra/shop-plan.consumer.ts`, group `tenancy-shop-plan` (contract: `tenancy-shop-lifecycle`, one group for `shop-onboarding` and `billing.events`). |
| G-17 payment double | DONE | `payments/infra/scripted-payment-provider.ts` (J01); billing adapter honouring `pm_test_*` to verify (`billing/invoice-charging.e2e-spec.ts`). |
| G-18 clock in billing | DONE (verify) | `billing/application/renewal.service.ts`, `billing-run.e2e-spec.ts`; confirm injected clock. |
| G-19 plan catalog | verify | `GET /plans` shape and `maxProducts`. |
| G-20 plan limit on product create | **OPEN** | `checkLimit` exists in `billing/application/entitlements.service.ts` but `catalog/application/product-command.service.ts` does not call it (it already calls `ShopQueryService`). No `plan_limit_reached` code in `libs`. |
| G-21/G-22 product API and events | PARTIAL | `ProductCommandService` exists; verify route `POST /shops/:id/products`, `outbox.append` snapshots, no legacy `{productId}` writers left. |
| G-23 stock through `ProductStockService` | DONE (verify) | `catalog/application/product-stock.service.ts`; callers in orders, auctions, catalog-sync, developer-platform. Re-grep raw `UPDATE "Product"` outside catalog. |
| G-24 draft publish | verify | `catalog/application/draft-publish.service.ts`. |
| G-25/G-26 search projector and API | PARTIAL | `discovery/infra/projectors/product-index.projector.ts` (group `search-indexer`; contract `search-product-index`) and `shop-state.projector.ts` (`search-shop-state`) exist; verify response shape and snapshot indexing. |
| G-27 index lag endpoint | verify | `GET /admin/search/index`. |
| G-28 suspension hides | PARTIAL | `search-shop-state` exists; verify `tenancy.shop_status_changed` handling and AS-23 ordering. |
| G-29..G-31 webhook API and wire | PARTIAL | `webhooks.manage` exists (`tenancy/domain/permissions.ts`), event-types controller exists; `Marketplace-Delivery-Id`/`resource_version` appear only in `domain/webhook-event-mapper.ts`: verify headers on the wire, attempts filter. |
| G-32 `allowedReceiverHosts` | **OPEN** | not found in `libs` or `apps`. |
| G-33 webhook processes in monolith | verify | J01 verified worker/projector composition; confirm the webhook FIFO queue consumer and router run. |
| G-34 leaderboard API | DONE | `seller-insights/api/leaderboards.controller.ts`, `shop-rank.controller.ts` (`GET shops/:shopId/rank`). S40 follow-up (poll up to 10 s) is test-side only. |
| G-35 leaderboard inputs, H15 names | PARTIAL | projector group is `seller-insights-boards` (contract `leaderboards`); shop-name copy via `seller-insights-shops`; verify `lineTotalMinor`, `paidAt`, slug/name. |
| G-36 canonical group names | **OPEN** | see §2. |
| G-37 job allow-list | PARTIAL | `billing/application/billing.job-types.ts` and `discovery/application/jobs/reindex.job.ts` exist; `webhooks.retry` job exists in `developer-platform`; `onboarding.verify-pending` missing; confirm the four are in the admin allow-list (J01 control surface). |
| G-38 metrics | verify | counters of AS-32. |
| G-39 harness | PARTIAL | J01 kit present: `control-surface`, `journey-client`, `seller-fixture`, `wait-for-contract`, `purchase`, `rate-limits`, `observability`, `stream`; missing `webhook-receiver`, `kyc` fixtures, J02 hop rows. |
| G-40 static gates | verify | run the gates for the eight domains; direct `sequelize.transaction` sites must not rise. |
| Search refresh ≤ 1 s (H9–H11) | **OPEN** | `libs/infrastructure/elasticsearch/elasticsearch.service.ts:101` hard-codes `refresh_interval: '5s'`; `search_refresh_interval` exists in config (`libs/common/config/search-config.ts`): wire it, set `1s` in the local profile. |

## 2. Consumer-group names (decision)

Built groups use their own names, but `spec.md`, the test plan and the control-surface tests address groups by the canonical name. **Decision**: rename the group (`Projector.name`) to the canonical name rather than add an alias layer.

| Today | Canonical | Domain |
|---|---|---|
| `identity-shop-owner-promotion` | `identity-seller-promotion` | identity |
| `tenancy-verification` + `tenancy-shop-plan` | `tenancy-shop-lifecycle` (one group, topics `shop-onboarding` and `billing.events`) | tenancy |
| (to find) | `entitlements-invalidation` | billing |
| `search-indexer` (+ `search-shop-state`) | `search-product-index` (`products.events` and `tenancy.events`) | discovery |
| `webhook-router` | unchanged | developer-platform |
| `seller-insights-boards` (+ `-shops`, `-products`) | `leaderboards` | seller-insights |
| `product-cache-invalidator` | unchanged | catalog |

Alternatives considered: (a) alias map in the consumer-admin service — rejected, a second source of truth that drifts; (b) change the spec — rejected, the names are cited by S01/S03/S18/S32/S40 pages and by J01's control-surface tests. Cost: a rename resets Kafka offsets for a new group id (dev stack: replay is idempotent, S53); every e2e spec or doc page that names the old group is edited (grep `rg "<old-name>"` before each rename). Merging two projectors into one group needs one consumer per topic set under one group id; if the projection runner cannot do that, keep two classes with the same group id (verify in `libs/infrastructure/projections`).

## 3. Decisions

- **Journey as verifier.** Write each user story's journey slice first and run it against the stack; fix whatever fails in the owning domain (cross-spec rule "fix broken hand-offs in the domain that owns them"). Rationale: the audit is static; J01 followed the same order.
- **No new infrastructure.** No table, topic or queue is added. If a queue is added (extractor outbox command), it goes into `infra/docker/elasticmq/elasticmq.conf` in the same change and readiness fails while it is missing (L-002, L-020).
- **Model double.** The LLM port in the local profile answers by the SHA-256 or marker bytes of the fixture; selected by `PROVIDER_DOUBLES=enabled`, refused in production. Alternative (a real recorded model) rejected: non-deterministic.
- **Receiver allow-list.** `allowedReceiverHosts` is a local-profile setting parsed at startup (host:port list), consumed by S43's endpoint validation and S54 `safeRequest`; production with a non-empty list fails boot. HTTPS only: the test receiver uses a self-signed certificate that the stack trusts through the same setting (the setting also carries the CA fingerprint). Alternative (`http` allowed locally) rejected by questions.md.
- **Search freshness.** Index refresh comes from `search_refresh_interval`; local profile `1s`. No per-request `refresh=wait_for`.
- **Plan limit counting.** Count by catalog's own product table (non-archived, non-deleted), inside the create transaction's pre-check; concurrent creates may overshoot by at most the number of racing requests unless the count is taken `FOR UPDATE` on the shop's product-counter row. Decision: serialise on the shop with an advisory lock keyed by `shopId` inside `TransactionRunner.run` (no new column); alternative (counter column) rejected as a migration for a rule S18 already owns.
- **Transactions.** All new write paths use `TransactionRunner.run` / `@Transactional`; any touched file with `// S54 T037 audit` is migrated.
- **Sibling effects.** Renaming groups and the `onboarding.verify-pending` job touch S01/S03/S18/S32/S40/S04 contracts: recorded under `## Sibling-spec follow-ups` in `gaps.md` (see plan.md), not edited in their specs.

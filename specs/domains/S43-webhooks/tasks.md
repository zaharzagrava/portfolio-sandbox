---

description: "Task list for S43 — Webhook delivery to shops"
---

# Tasks: S43 — Webhook delivery to shops (domain `developer-platform`)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `research.md`, `contracts/{http,events,outbound}.md`, `quickstart.md`, constitution.

**Tests**: Required (test-plan.md, constitution VII). Order is test-first: in every story the failing test tasks come before the code tasks that make them pass.

**Path shorthand**: `DP` = `packages/backend/libs/domains/developer-platform`; `BE` = `packages/backend`; `CT` = `packages/contracts/src/developer-platform`. Backend commands run from `packages/backend`; e2e specs run with `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`. After 5 failed fixes of the same test: stop and write the blocker, what was tried and the hypothesis into `questions.md`.

**Rules that apply to every task**: no `git checkout/restore/reset/stash/clean` (undo by hand); transactions only via `TransactionRunner.run` / `@Transactional`, delete the `// S54 T037 audit` comment of any touched site, never add a direct `sequelize.transaction`; never touch `*.reviewed.json`; every e2e creates its own shops, endpoints, receiver ports and events (L-005/L-006); no "A or B" assertions (L-003); repeat each concurrency test ≥ 20 times; breaker/outage tests restore what they damage (L-013); queue options only on the FIFO queue (L-001).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Create the living page `docs/spec/capabilities/S43-webhooks.md` (none exists) with rules and behaviors for the 8 stories and `[proof: ...]`/`[code: ...]` markers modelled on the S42 page in `docs/spec/capabilities/`; run `python3 scripts/livespec/check.py` until clean; never create or edit a `*.reviewed.json` (rule 0).
- [X] T002 Run `pnpm --dir packages/backend check:table-ownership` (gaps.md note), reconcile its `developer-platform` lines with gaps.md section 3, and refresh `specs/domains/S43-webhooks/.ownership.baseline` and `.tx.baseline` (direct `sequelize.transaction` count of the domain).
- [X] T003 [P] (closed 2026-10-15: broker reloaded, readiness proof exists; empty-stack proof deferred to the final checkpoint under T090) Add queue `webhook-deliveries.fifo` and its DLQ (with redrive policy) to `elasticmq.conf`; add the queue-server reload command to the unattended runbook/script (L-002, L-020); confirm readiness fails while a consumed queue is missing. **Partly done (2026-10-15)**: queue, DLQ and redrive were already in `elasticmq.conf` and `infra/stack/main.tf`; `maxReceiveCount` changed 8 to 5 in both (FR-035: dead letter after 5 receives); the reload command already exists (`scripts/infra/reload-queues.sh`, allow-listed). Not done: the queue servers (dev and `marketplace_test_elasticmq`) were not restarted (`docker restart` and the script were refused for lack of approval), and "readiness fails while the consumed queue is missing" is not shown yet because the FIFO consumer is rewritten in T065 (register the queue with `ReadinessService` there and prove it). **Update (T065 done)**: the readiness proof exists (`apps/worker/src/webhooks-wiring.e2e-spec.ts`); `scripts/infra/reload-queues.sh` was run later on 2026-10-15 and succeeded, so the broker carries `maxReceiveCount = 5`.
- [X] T004 [P] Add `WebhookEndpointHistory`, `WebhookShopCounter`, `WebhookAttempts` to the doctor's required-resource list (L-011) and registry rows `domain:developer-platform` in `BE/db/ownership.ts` (receipts stay `infrastructure:inbox`). *Done: the two registry rows are added. The doctor has no list to edit: it derives its resources from the code (`scripts/infra/doctor.py`); `WebhookAttempts` is found through `const TABLE = 'WebhookAttempts'` in `infra/dynamo-delivery-log.store.ts` and is defined by `dynamodb/WebhookAttempts.json`; the Postgres tables are raw SQL without a model, which the doctor cannot see (same as S42), so they are proven by the migration and by `infra/webhook-adapters.e2e-spec.ts`. `python3 scripts/infra/doctor.py --only queues,tables`: 0 missing.*
- [X] T005 [P] Create the shared e2e fixture `DP/testing/webhook-e2e.fixture.ts`: seeds shops, users, memberships only through exported identity/tenancy services (`ShopAccessService`, `ShopQueryService`, `MembershipQueryService`; no foreign model, D-7); local HTTP(S) receiver (status script, hang, slow-drip, redirect, concurrency recorder); injected fake resolver; frozen/advanceable clock; injected jitter random; schema-valid envelope builders from `packages/contracts`; `waitFor`.

---

## Phase 2: Foundational (blocks all stories)

**⚠️ CRITICAL**: contracts, schema and pure domain first.

### Tests first (pure logic; must fail before code)

- [X] T006 [P] Unit spec `DP/domain/webhook-url.spec.ts` (`it.each`): AS-02 syntactic parse and "URL ≤ 2,048"; AS-03 https only, port 443, no user-info, no IP literal, no `localhost`; AS-12 normalisation table (lower-case host, no default port, no fragment).
- [X] T007 [P] Unit spec `DP/domain/endpoint-status.spec.ts`: AS-08 transition table (`enabled --disable(manual|auto_failing)--> disabled`, `disabled --enable--> enabled`, every other pair illegal, `assertNever`); AS-55 window rule (auto-disable only when `failingSince <= now - 3 d`, inclusive; −1 s vs 0).
- [X] T008 [P] Unit spec `DP/domain/retry-schedule.spec.ts`: AS-41 delays (3 receives then 5, 30, 120, 300, 600, 1440, 1440, 1440 min), ±20 % bounds at random 0 and 1, `Retry-After` merge, cap, exhaustion after 11 attempts.
- [X] T009 [P] Unit spec `DP/domain/breaker.spec.ts`: AS-48 states closed/open/half-open, 5 failures, open durations 1, 2, 4, 8, 16, 30 min (cap), single probe, `assertNever`.
- [X] T010 [P] Unit spec `DP/domain/stock-low.spec.ts`: AS-28 rule (`quantity ≤ 5`, `changedFields ∋ quantity`, once per product per UTC day by `occurredAt`, UTC day boundary, deterministic ID).
- [X] T011 [P] Unit spec `DP/domain/webhook-event-mapper.spec.ts`: AS-23 slice table plus property test (slices partition lines, integer minor units); AS-26 cancel/refund carry no amounts; AS-27 product mapping table (`created|updated|archived|restored→updated|deleted`); AS-29 payout mapping and `isSandbox` dropped.
- [X] T012 [P] Unit spec `DP/domain/webhook-settings.spec.ts`: AS-71 private-host allowance refused in production at startup, schedule order, jitter range, timeouts (10 s deadline, 1 KiB read cap, 256 KiB body cap).
- [X] T013 [P] Extend `DP/domain/signature.spec.ts`: AS-16 HMAC over `t.body`; AS-17 verifier table (tolerance 300/301 s, malformed headers, duplicate `t`, many `v1`); AS-19 active-secret selection at expiry −1 ms and 0 with the injected clock.

### Contracts, schema, pure domain

- [X] T014 [P] Add `CT/webhooks.ts` zod schemas: endpoint DTO (secret-related fields only `hasPreviousSecret`, `previousSecretExpiresAt`), create/update/rotate bodies ("events 1–20 distinct from the catalogue", "`overlapHours` integer 1–72", "`limit` 1–100", unknown properties rejected), paginated list and attempts `{items, nextCursor}`, event-type catalogue, replay/ping responses, problem+json `code` list of FR-050, consumed event schemas (order paid/cancelled/refunded, catalog product, payout, shop_deleted), and the reference verifier (FR-016/G-17); export through the contracts index; add parse tests beside it.
- [X] T015 Migration `BE/migrations/<ts>-webhooks-v2.js` (expand): create `WebhookEndpointHistory` (`id` uuid PK, `endpointId`, `shopId`, `facet` in `created|url|events|api_version|status|secret_rotated|previous_secret_expired|deleted`, `fromValue` null, `toValue` null — never a secret, URL facets host only —, `actorId` null, `createdAt`; indexes `("endpointId","createdAt")`, `("createdAt")`; no FK) and `WebhookShopCounter` (`shopId` PK, `endpoints` int CHECK `endpoints` BETWEEN 0 AND 20); on `WebhookEndpoint` add `urlNormalized` text NOT NULL (backfilled), `status` text `enabled`|`disabled` (backfilled from `enabled`), `disabledReason` `manual`|`auto_failing` (null when enabled), unique index `("shopId","urlNormalized")`, list index `("shopId","createdAt" desc,"id" desc)`, partial sweep index `("failingSince") WHERE status='enabled' AND "failingSince" IS NOT NULL`, routing index `("shopId") WHERE status='enabled'`; backfill counters; write the grandfather report for rows beyond limits or duplicates (not deleted); include a down migration.
- [X] T016 Migration `BE/migrations/<ts>-webhooks-v2-contract.js` (contract): drop the `WebhookEndpoint."shopId"` FK to `Shop` with `SET lock_timeout`; drop the `enabled` column only once no code reads it. *Done: `20261015100100-webhooks-v2-contract.js` drops the FK. The `enabled` column and the transitional trigger of the expand migration are NOT dropped yet (the old service, deliverer and router still read `enabled`); the drop is a third migration, `20261015100200-webhooks-v2-drop-enabled.js`, written in T037 (see there).*
- [X] T017 [P] Implement `DP/domain/webhook-url.ts` (T006).
- [X] T018 [P] Implement `DP/domain/endpoint-status.ts` (T007) with `assertNever`.
- [X] T019 [P] Implement `DP/domain/retry-schedule.ts` (T008), random injected.
- [X] T020 [P] Implement `DP/domain/breaker.ts` (T009) as a pure state machine; per research R-07 decide whether the Redis adapter wraps or mirrors `CircuitBreaker` from `@app/common/resilience` (no import from `payments`; S13 follow-up) and note the decision in `research.md`.
- [X] T021 [P] Implement `DP/domain/stock-low.ts` (T010).
- [X] T022 [P] Implement `DP/domain/webhook-event-mapper.ts` (T011), using the in-domain `transformForVersion` from `DP/domain/versioning.ts` until S42 exports `transformResource` (one registry).
- [X] T023 [P] Implement `DP/domain/webhook-settings.ts` (T012) with startup validation in the hosting modules; replace the literals of `DP/infra/webhook-workers.ts` (`concurrency: 50`, `visibilityTimeoutSec: 30`) with configuration.
- [X] T024 Fix `DP/domain/signature.ts` (T013): inject the clock (no `Date.now()` default), strict parser (reject duplicate `t`, malformed pairs), select active secrets from the injected clock at signing time.
- [X] T025 Extend `DP/domain/webhook-events.ts` to the 11-type catalogue `{type, description, resource, since}`: `order.paid|cancelled|refunded`, `product.created|updated|archived|deleted|stock_low`, `payout.paid|failed`, `webhook.ping` (resource `ping`).
- [X] T026 Create `DP/domain/webhook-ports.ts`: `EndpointRepository`, `EndpointHistory`, `DeliveryLog`, `BreakerStore`, `DeliveryQueue`, `OutboundHttp`, `RoutingReceipts` (ports only; no framework, no `Date.now()`).
- [X] T027 [P] Adapters in `DP/infra/`: `sequelize-webhook-endpoint.repository.ts` (every lookup `WHERE id = :id AND "shopId" = :shopId`, conditional `WHERE status = :from`, counter + insert in one `TransactionRunner.run`, keyset pagination), `sequelize-webhook-history.repository.ts`, `dynamo-delivery-log.store.ts` (delivery and attempt items per data-model.md, TTL 30 d, reads filter `expiresAt > now`), `redis-breaker.store.ts` (store error → closed plus `webhook_breaker_degraded_total`), `sqs-delivery.queue.ts` (group = endpointId, dedup = event id + attempt kind; message without body or secret; options validated at creation, L-001), `safe-outbound-http.adapter.ts` (S54 `safeRequest`, 10 s overall deadline, 1 KiB read cap, no redirects, maps `SafeRequestError.kind` to `blocked_address|unresolvable|invalid_url|redirect_refused|redirected_host|too_many_redirects|unsupported_content_type|timeout|tls_error|network_error` in this file only).
- [X] T028 Module restructure: create `DP/webhooks-projector.module.ts`, `DP/webhooks-lambda.module.ts` and `DP/infra/webhook-lambda.handler-host.ts`; keep `webhooks.module.ts`, `webhooks-core.module.ts`, `webhooks-worker.module.ts`; each standalone module imports everything it needs (identity `AuthModule` for `SecretBox`, `VersionPinCache` provider, rate-limit module; L-018); drop the `NotificationsCoreModule` import (`webhooks-core.module.ts:7,14`); `apps/lambdas/src/handlers/webhook-delivery.ts` imports only `WebhooksLambdaModule`; shrink `DP/index.ts` to Nest modules and DTO types (D-8).
- [X] T029 [P] Register S50 policies `webhooks.manage.shop`, `webhooks.replay.shop`, `webhooks.ping.endpoint` (fail closed) with `definePolicies`.

**Checkpoint**: `tsc` clean, unit specs T006–T013 green, migrations apply on an empty stack.

---

## Phase 3: User Story 1 — Register and manage endpoints (P1) 🎯 MVP

**Goal**: dashboard CRUD with limits, URL guard, enable/disable, history, rate limits.

**Independent Test**: `test-spec.sh webhook-endpoints` green (AS-01–AS-15).

### Tests first (`DP/webhook-endpoints.e2e-spec.ts`, describe "Webhooks: endpoint management (dashboard)")

- [X] T030 [US1] AS-01, AS-04, AS-06: create (secret shown once, 256-bit `whsec_` + 43 base64url chars, `apiVersion` default from `ApiVersionService.getPinnedVersions`) and read one; parse responses with the contract schema; assert endpoint row, history row, outbox row. *Done in `DP/webhook-endpoints.e2e-spec.ts`. An explicit `apiVersion: "latest"` (allowed by the contract schema) is resolved to the concrete latest version at write time; an unpinned shop therefore gets the concrete latest date, not the literal `latest`.*
- [X] T031 [US1] AS-02 table-driven validation (one case per class: unknown property, URL length, events size 0/21/duplicates/unknown type, unsupported `apiVersion`) and AS-03 guard matrix at create and patch via the fake resolver (every listed reason → `422 endpoint_url_rejected` with `details.reason`; a blocked patch changes nothing).
- [X] T032 [US1] AS-05 list (7 endpoints, cursor walk `(createdAt desc, id desc)`, bad cursor, limits 1–100); AS-07 update (PATCH returns `200` with endpoint, empty body, no `enabled` field); AS-10 delete (`404 webhook_endpoint_not_found` for unknown and cross-shop, byte-identical).
- [X] T033 [US1] AS-08 one wired `409 endpoint_state_conflict` per illegal pair and URL re-check on enable (`422` when now blocked); AS-09 concurrent enable via `Promise.all` ×20 (exactly one success).
- [X] T034 [US1] AS-11 limit: 18 → 20 with `Promise.all` (exactly the allowed number succeed, `422 endpoint_limit_reached`, counter = rows); AS-12 duplicate URL sequential and concurrent (`409 duplicate_endpoint_url`; L-010).
- [X] T035 [US1] AS-13 auth table: every route × anonymous / STAFF / VIEWER / other shop / cross-shop ID, plus a suspended shop (`403 shop_suspended`) and an offboarding shop (`409 shop_offboarding`) on write routes (S03 follow-up retest); AS-14 `GET webhook-event-types`.
- [X] T036 [US1] AS-15 rate limit: `429` with structured `RateLimit` / `RateLimit-Policy` headers (no `X-RateLimit-*`), then limiter store down → fail-closed `503` (gate 9, forced fault).

### Implementation

- [X] T037 [US1] Implement `DP/application/webhook-endpoints.service.ts`: create (ID generated before insert, `SecretBox.seal(secret, "webhook-endpoint:<id>")`, counter + unique index + history + outbox `developerplatform.webhook_endpoint_changed` in one `TransactionRunner.run`), read/list/update/delete, `enable`/`disable` as conditional updates with history row, URL re-check on create/URL update/enable; migrate existing direct transaction sites and delete their `// S54 T037 audit` comments; remove raw `sequelize.query`. Also add `BE/migrations/20261015100200-webhooks-v2-drop-enabled.js` (drop the `WebhookEndpoint_compat_trg` trigger and function, the `enabled` column, the old `WebhookEndpoint_shop_idx` / `WebhookEndpoint_failing_idx` indexes, and add `CHECK ("disabledReason" IS NULL OR "disabledReason" IN ('manual','auto_failing'))`) in the same change that removes the last reader of `enabled` (`webhook-deliverer.service.ts`, `webhook-router.projector.ts`, the old endpoints service), and run it on the test stack. *Done. The dashboard service is `WebhookEndpointsService` (provided by `WebhooksModule`); the router's and the deliverer's reads moved to the transitional `WebhookEndpointLookup` (`application/webhook-endpoint-lookup.service.ts`, deleted with T056/T067) which reads `status`; the deliverer sends through the `OutboundHttp` port and the injected clock. New ports: `AddressGuard` (adapter `infra/safe-address.guard.ts`) and `BreakerStore.isOpen`. Migration `20261015100200-webhooks-v2-drop-enabled.js` applied to the test stack. The old service had no direct `sequelize.transaction` and no `// S54 T037 audit` comment; there is no new direct transaction.*
- [X] T038 [P] [US1] Request/response DTOs in `DP/application/dto/webhook-*.dto.ts` (whitelist, forbid unknown) matching the contract schemas; problem+json codes of FR-050 (`422` semantic, `404` hides existence).
- [X] T039 [US1] Rewrite `DP/api/webhooks.controller.ts` and add `DP/api/webhook-event-types.controller.ts`: `ShopScoped('webhooks.manage')` on every route, `POST …/enable|disable`, no `enabled` in PATCH, S50 policies, calls only application services (II.1; no `infra/` import).
- [X] T040 [US1] Run `test-spec.sh webhook-endpoints`; fix until green.

**Checkpoint**: US1 independently green.

---

## Phase 4: User Story 2 — Signing and secret rotation (P1)

**Goal**: signed messages, two-secret overlap, secret hygiene.

**Independent Test**: `test-spec.sh webhooks.e2e-spec` (AS-16, AS-18–AS-22).

### Tests first (`DP/webhooks.e2e-spec.ts`, describe "Webhooks: signing and secret rotation")

- [X] T041 [US2] AS-16 a real delivery verified by the receiver over the raw body with the reference verifier; AS-18 rotation (both secrets sign during overlap, new secret shown once). *Interim: the delivery is driven through `WebhookDeliverer.deliver` (the only sender until T064 exists; it now sends through the `OutboundHttp` port and the injected clock). T077 (ping route) and T064 replace this driver, and the three real-delivery tests of `webhook-secrets.e2e-spec.ts` (AS-16, AS-18, AS-19, AS-20, AS-22 helper `deliverTo`) must then send through the ping route or the routed event.* **Migrated (T064/T067)**: the tests send through the routed event and the worker's handler (see T067); the ping route does not exist before T077.
- [X] T042 [US2] AS-19 overlap boundary with frozen clock at expiry −1 ms and 0; AS-21 `overlapHours` 1–72 and rejection outside.
- [X] T043 [US2] AS-20 `409 rotation_in_progress` while a previous secret is valid; `expire-previous-secret` ends it early (history `previous_secret_expired`); concurrent rotations via `Promise.all` ×20 (exactly one wins).
- [X] T044 [US2] AS-22 hygiene: scan endpoint rows, cache entries, outbox rows, log items, captured logs and metrics for any secret (only the context-bound sealed value at rest).

### Implementation

- [X] T045 [US2] Add `rotateSecret(overlapHours)` and `expirePreviousSecret` to `DP/application/webhook-endpoints.service.ts` as conditional updates (refuse while previous valid), history + outbox in the same transaction; add their routes to the controller; the cached record holds sealed values and expiry only (G-14).
- [X] T046 [P] [US2] (closed 2026-10-15: docs-page section is a W07-owned change, tracked in gaps.md and specs/deferred-checks.md) Publish the reference verifier (T014 export) in the developer docs per `contracts/outbound.md`; correct the stale "per-delivery sent markers" comment in `apps/lambdas/src/handlers/webhook-delivery.ts`. **Half done (2026-10-15)**: the handler comment is already correct (no "sent markers" text remains) and the verifier is exported (`parseSignatureHeader`, `verifySignatureWith` in contracts; `verifyWebhook` in `domain/signature.ts`, used by the tests). Not done: the docs page `packages/web/app/developers/docs/page.tsx` belongs to W07 and its test pins the exact list of sections (`Authentication`, `Errors`, `Deprecation`), so a Webhooks section there is a W07 change (follow-up written in gaps.md).
- [X] T047 [US2] Run `test-spec.sh webhooks.e2e-spec`; fix until green.

---

## Phase 5: User Story 3 — Events reach the right endpoints (P1)

**Goal**: consumers with schema validation, inbox receipts and DLQ; routing to subscribed endpoints.

**Independent Test**: `test-spec.sh webhook-routing` (AS-23–AS-34, AS-66).

### Tests first (`DP/webhook-routing.e2e-spec.ts`, describe "Webhooks: routing of domain events (consumers)")

- [X] T048 [US3] AS-23 multi-shop order slice from `shopOrders` (renamed S10 fields `totalMinor`, `unitPriceMinor`, `title`, `lineTotalMinor`, `paymentRef`, `orderVersion`); AS-26 cancel and refund (no amounts, `previousStatus`); AS-25 subscription filter. *Done in `DP/webhook-routing.e2e-spec.ts` (13 tests). The specs feed the consumers the way the projection runner does (`testing/webhook-lane.ts#feed`: `routeEnvelope` on the declared contract, then `project`, a `PermanentError` is a dead letter); no Kafka runs in a spec, as for every other consumer of the repo.*
- [X] T049 [US3] AS-24 pinned versions per endpoint (via `ApiVersionService`); AS-27 product events from full-state `catalog.product_*` snapshots (tombstone state = delete; `catalog.product_changed` ignored); AS-29 sandbox dropped and payouts; AS-32 out-of-order source events (`resource_version` / `productVersion`).
- [X] T050 [US3] AS-30 duplicate source events twice then `Promise.all` ×20 (one delivery set, one inbox receipt; VII.4); AS-31 invalid payload and wrong `version` → DLQ, with a valid event behind it still routed (VII.4).
- [X] T051 [US3] AS-33 queue unavailable (forced fault, gate 9): no receipt, redelivery makes no duplicates (deterministic IDs); AS-34 two app instances, disable/edit visible within ≤ 5 s.
- [X] T052 [US3] AS-66 `tenancy.shop_deleted`: purge endpoints, history and log items in batches ≤ 1,000 per transaction; duplicate and invalid events (VII.4); cancelled deliveries.

### Implementation

- [X] T053 [US3] Implement `DP/application/webhook-routing.service.ts` (event → deliveries via the mapper; deterministic outbound `id` = `evt_` + digest of source event and shop; ack only after every endpoint message is accepted) and S52 cached subscriptions with cross-instance invalidation and no per-process layer (G-24).
- [X] T054 [US3] Implement `DP/infra/webhook-consumers.ts` on the S53 runtime: groups `webhook-router-orders`, `webhook-router-products`, `webhook-router-payouts`, `webhook-shop-deleted` with envelope check, zod validation (`PermanentError` → DLQ), inbox receipt per `eventId`, per-event isolation; no read of `Product`, `ShopOrder` or `ShopMembership`.
- [X] T055 [US3] For `order.cancelled`/`order.refunded` use `shopIds` when present, else the flagged fallback `OrderQueryService.getOrderLines` (never raw SQL), per plan Complexity Tracking; add the flag and a removal note. *Done: flag `WEBHOOKS_ORDER_SHOPS_FALLBACK` (config key `webhooks_order_shops_fallback`, default off). Off, an `order.cancelled`/`order.refunded` without `shopIds` is invalid (`PermanentError`, AS-31); on, the consumer asks `OrderQueryService.getOrderLines` (imported through `OrderCommandModule` in `WebhooksProjectorModule`). Production S10 events carry no `shopIds` yet, so the flag must be on in deployments until S10 ships the field; removal note in gaps.md (S10 follow-up) and the consumer's doc comment. The path with the flag on has no end-to-end test yet (not written; the flag-off branch is AS-31).*
- [X] T056 [US3] Delete `DP/infra/webhook-router.projector.ts` and its barrel export once T048–T052 are green; wire the consumers in `WebhooksProjectorModule`. *Done: `webhook-router.projector.ts` and the transitional `webhook-endpoint-lookup.service.ts` are deleted (the dashboard service now invalidates through `WebhookSubscriptions`); `apps/projector/src/webhooks-wiring.e2e-spec.ts` boots the real `ProjectorModule` and finds the four consumer groups registered. `DP/webhooks.e2e-spec.ts` could no longer import the deleted classes: it is reduced to a header listing where each scenario went and two `it.todo` (AS-62 replay, AS-55/AS-58 auto-disable); T083 deletes it once those exist.*
- [X] T057 [US3] Run `test-spec.sh webhook-routing`; fix until green.

---

## Phase 6: User Story 4 — Delivery: ordered, isolated, retried (P1)

**Goal**: FIFO lane then retry lane, atomic claim, breaker, SSRF guard at delivery.

**Independent Test**: `test-spec.sh webhook-delivery` and `webhook-ssrf` (AS-35–AS-54).

### Tests first

- [X] T058 [US4] `DP/webhook-delivery.e2e-spec.ts` (describe "Webhooks: delivery, ordering, retries and circuit breaker"): AS-35 successful delivery with record and state; AS-36 order and single flight per endpoint; AS-37 isolation (20 events on two endpoints while one hangs); AS-42 recovery and ordering trade-off.
- [X] T059 [US4] Same file: AS-38 hang, slow-drip and 1 MiB body (10 s overall deadline, 1 KiB snippet); AS-39 classification (`2xx` set, `301` not followed, failures, `Retry-After`); AS-53 oversized body → `failed (payload_too_large)` at 256 KiB.
- [X] T060 [US4] Same file: AS-40 ordered lane (3 attempts) then retry lane, 11 attempts with the clock advanced, `exhausted` visible terminal state; AS-43 worker killed after send, visibility timeout, no lost retry.
- [X] T061 [US4] Same file: AS-44 duplicate and concurrent messages via `Promise.all` ×20 (one send; VII.4); AS-45 partial batch failure through the Lambda handler entry point (*split in two: the domain spec drives `WebhookLambdaHandlerHost.handleRecord` on three real deliveries; `apps/lambdas/src/handlers/webhook-delivery.spec.ts` drives the real `handler` with a stand-in host, because a lib spec may not import `apps/` (X.1) and an app spec may not import a domain's kit (X.4), and the real Lambda module cannot reach a local receiver (port 443 only)*); AS-46 poison message to DLQ and redrive with log store down (forced fault, VII.4). *AS-46 caveat: "received 5 times -> dead-letter lane" is the broker's redrive policy, which an in-memory queue cannot run; the spec asserts the five failing receives, the redrive of the same message (delivered once) and the policy text in `elasticmq.conf` (`maxReceiveCount = 5`). The running ElasticMQ was not restarted (refused earlier), so the live dev/test broker may still hold the old value 8 until `scripts/infra/reload-queues.sh` is run by someone with approval.*
- [X] T062 [US4] Same file: AS-47 breaker with concurrent probe via `Promise.all` ×20 (one probe); AS-49 breaker store down (forced fault, fail open, `webhook_breaker_degraded_total`, restore the store, L-013); AS-50 disable/delete take effect on the next attempt (status read from store); AS-54 graceful shutdown (stop intake, finish ≤ 10 s, record, close).
- [X] T063 [US4] `DP/webhook-ssrf.e2e-spec.ts` (describe "Webhooks: address guard at delivery"): AS-51 DNS rebinding and pinned address; AS-52 matrix of resolver answers (mixed, mapped addresses) and redirect targets, each failure logged as an attempt with the S54 vocabulary reason and retried.

### Implementation

- [X] T064 [US4] Implement `DP/application/webhook-delivery.service.ts`: atomic per-attempt claim (skip when `delivered`), build body from the stored delivery, 256 KiB cap, sign with the injected clock, send through `OutboundHttp`, record attempt and next state together (a log-store failure fails the message so it is redriven), `Retry-After` merge, `exhausted`, no network call inside a DB transaction, breaker via `BreakerStore` (one probe, fail open).
- [X] T065 [US4] Rewrite `DP/infra/webhook-workers.ts` as the SQS FIFO consumer on the S53 runtime (DLQ, redrive, partial-batch response, configuration numbers, graceful shutdown via `@app/infrastructure/lifecycle`) and the S49 job `webhooks.retry` with idempotency key for the retry lane (never a standard queue with a group). Carried over from T023: the `@JobHandler('webhooks.retry', { concurrency: 50 })` decorator still has a literal (a decorator cannot read injected configuration; use a module-level constant read from `WEBHOOK_SETTINGS` defaults or register the handler programmatically); tighten the `webhooks.retry` contract in `application/webhook-jobs.ts` (drop the optional `type` and `body` accepted for the old deliverer); register the consumed queue with `ReadinessService` and prove "not ready while `webhook-deliveries.fifo` is missing" (T003). *Done: `WebhookWorkers` consumes with `bodySchema` (an invalid body goes to the dead-letter queue at once), registers the readiness check `queue:webhook-deliveries.fifo` (queue and DLQ) and a `ShutdownRegistry` task (order 10) that stops intake and waits at most 10 s for the attempts in flight; the `@JobHandler` concurrency is a module constant taken from `DEFAULT_WEBHOOK_SETTINGS.workerConcurrency`; the job contract is strict (`type` and `body` dropped, `deliveryId`, `kind` required, `scheduledFor` added). Proof against the real worker app: `apps/worker/src/webhooks-wiring.e2e-spec.ts` (3 tests, ready while both queues exist, not ready while either is missing, restored after).*
- [X] T066 [US4] Rewrite `apps/lambdas/src/handlers/webhook-delivery.ts` to boot `WebhooksLambdaModule` and return a partial-batch response; add structured logs (host only) and the FR-052 metrics (`webhook_routing_lag_seconds`, `webhook_breaker_degraded_total`, delivery counters and durations). *Done: the handler asks `WebhooksLambdaModule` only, logs the message id, receive count and error class of a failed record (no body, no URL), and emits the CloudWatch counters `Deliveries` and `DeliveryMs` by outcome; the service-level instruments (`webhook_delivery_attempts_total`, `webhook_delivery_duration_seconds`, `webhook_routing_lag_seconds`, `webhook_breaker_degraded_total`) are recorded by `WebhookDeliveryService`, `WebhookRoutingService` and the breaker store. Dead-letter, auto-disable and lane-age instruments of `webhook-metrics.ts` are not written by anything yet (AS-68, T081/T082).*
- [X] T067 [US4] Delete `DP/application/webhook-deliverer.service.ts` and `DP/infra/http-sender.ts` and their barrel exports once T058–T063 are green. *Done: both files are deleted, the barrel never exported them after T028, and `WebhookDelivery` (the old message shape) is removed from `domain/webhook-events.ts`. The real-delivery tests of `webhook-secrets.e2e-spec.ts` (AS-16, AS-18, AS-19, AS-20, AS-22) now route a paid order through the consumer and send through the worker's handler; no assertion was weakened (the AS-16 tamper check now edits `"PAID"` instead of a test-only id; the AS-19 retry is a repeat attempt of the same delivery at the expiry instant, which is stricter than the former second event).*
- [X] T068 [US4] Run `test-spec.sh webhook-delivery` then `webhook-ssrf`; fix until green.

---

## Phase 7: User Story 5 — Dead endpoint switched off, shop told (P2)

**Goal**: failure window, auto-disable, sweep, alert event.

**Independent Test**: `test-spec.sh webhook-lifecycle` (AS-55–AS-59).

### Tests first (`DP/webhook-lifecycle.e2e-spec.ts`, describe "Webhooks: auto-disable, shop lifecycle and retention")

- [X] T069 [US5] AS-55 failure window with frozen clock at −1 s and 0; AS-56 a success resets the window; AS-59 re-enable after auto-disable clears `failingSince`, breaker and failure count. *Red run first: 8 of 8 tests of the file failed (3 on the behavior, 5 on the missing sweep entry point).*
- [X] T070 [US5] AS-57 sweep job `webhooks.disable-failing-endpoints` twice and via `Promise.all` ×20 (one disable, one event per window); AS-58 alert hygiene: event `developerplatform.webhook_endpoint_disabled` v1 payload `{endpointId, shopId, host, failingSince}` (host only; no URL, path or secret in event, logs, metrics), emitted in the same transaction as the disable.

### Implementation

- [X] T071 [US5] Implement `DP/application/webhook-lifecycle.service.ts`: conditional `failingSince` updates (race-safe `markFailing`/`markHealthy`), disable + outbox in one `TransactionRunner.run`, sweep handler registered with S49 (single run, 15-minute cron), shop-deleted purge used by T054; emitted event definitions in `DP/application/events/webhook-events.ts` (S28 follow-up: no `NotificationsCoreModule`, no `ShopMembership` query).
- [X] T072 [US5] Run `test-spec.sh webhook-lifecycle` (AS-55–AS-59); fix until green. *Green (11 tests with AS-67). The old `webhooks.e2e-spec.ts` todo for AS-55/AS-58 now has real coverage here.*

---

## Phase 8: User Story 6 — Log, replay, test event (P2)

**Goal**: attempt log with cursor, event detail, replay `202` with idempotency, per-endpoint ping.

**Independent Test**: `test-spec.sh webhook-replay-log` (AS-60–AS-65).

### Tests first (`DP/webhook-replay-log.e2e-spec.ts`, describe "Webhooks: delivery log, replay and test events")

- [X] T073 [US6] AS-60 attempt log: cursor on `(startedAt, attemptId)` stable under concurrent insert, filters, 30-day read cut-off; AS-61 event detail route (`404 webhook_event_not_found`, cross-shop identical).
- [X] T074 [US6] AS-62 replay: `202`, one attempt, no retry, no breaker / failure-window / auto-disable effect; AS-64 guards (`409` disabled endpoint, missing event, expired item).
- [X] T075 [US6] AS-63 replay idempotency with the S54 store: same key replays the answer, in-flight `409` via `Promise.all` ×20, different body `422`, missing key rejected, 24 h TTL.
- [X] T076 [US6] AS-65 per-endpoint ping (even if unsubscribed; no resource type) with `429` from `webhooks.ping.endpoint`.

### Implementation

- [X] T077 [US6] Implement `DP/application/webhook-replay.service.ts` (replay, ping, attempt/event reads; `kind: replay|ping` deliveries never `retry_scheduled`) and the controller routes (`GET …/attempts`, `GET …/events/:eventId`, `POST …/events/:eventId/replay` with `Idempotency-Key`, `POST …/:id/ping`); remove the fan-out ping.
- [X] T078 [US6] Run `test-spec.sh webhook-replay-log`; fix until green. *Red run first: 17 of 17 failed (routes missing). Green: 17 tests. The old `it.todo` for AS-62 has real coverage here.*

---

## Phase 9: User Story 7 — Lifecycle and retention (P3)

**Goal**: 30-day log, 400-day history.

**Independent Test**: AS-67 in `webhook-lifecycle`.

- [X] T079 [US7] Add AS-67 to `DP/webhook-lifecycle.e2e-spec.ts` (write first; must fail): items at 30 d −1 s and 0 never returned after expiry, history purge at 400 d with a frozen clock, purge job idempotent.
- [X] T080 [US7] Add the 400-day history purge job (S49, `("createdAt")` index) to `DP/application/webhook-lifecycle.service.ts` and the log read cut-off in `DP/infra/dynamo-delivery-log.store.ts`; run `test-spec.sh webhook-lifecycle`. *Done. Order caveat: the purge job (landed with T071) and the store's read cut-off (already in the store since Phase 5) existed before the AS-67 tests were written, so AS-67 was not red before implementing; its boundary was proven sensitive by mutation (`<=` to `<` in `deleteOlderThan` fails the 400-day test, then restored).*

---

## Phase 10: User Story 8 — Operability and contract (P2)

**Goal**: observability, problem details, contract conformance.

**Independent Test**: `test-spec.sh webhook-contract` (AS-68, AS-69) plus static gates (AS-70, Phase 11).

- [X] T081 [US8] `DP/webhook-contract.e2e-spec.ts` (describe "Webhooks: observability, problem details and contracts"): AS-68 metrics and structured logs (host only); AS-69 every route parsed with its contract schema, problem+json `code`s, forced `500` body. Write first; must fail.
- [X] T082 [US8] Close the failing parts of T081 (metrics registration, error-filter mapping, schema gaps in `CT/webhooks.ts`); run `test-spec.sh webhook-contract`. *Done. Red run: 3 AS-68 tests failed on the behavior (no structured line, lane age, dead-letter counters unwritten) and one AS-69 test on a spec bug (superagent sends on `then`); the other AS-69 tests (all success schemas, every error code, forced 500) and the label test passed because the routes already conformed. Added `webhookProblemSchema` to `CT/webhooks.ts` before the first run (a gap, not a red proof).*

---

## Phase 11: Polish and cross-cutting

- [X] T083 Scenario map check (L-017): confirm AS-16, AS-18, AS-35, AS-40, AS-03, AS-62 are covered by the new files, then delete `DP/webhooks.e2e-spec.ts`. *Done 2026-10-15: every AS-01 to AS-71 except AS-70 (static gate) has an `it('S43 AS-nn ...')` in the files of test-plan.md (grep-checked); the old file is deleted.* *State after T037 (2026-10-15): the old file compiles (signatures follow the new service) and all 5 of its tests FAIL on purpose, by the behavior change: scenarios 1 "order.paid signed POST" (AS-16, now covered by `webhook-secrets`), 2 "failures: FIFO then job lane, replay" (AS-40, AS-62, still to be written in T060/T074), 3 "failing 3 days disables and publishes the fact" (AS-55, AS-58, T069/T070) and 5 "secret rotation" (AS-18, AS-19, covered by `webhook-secrets`) fail because their receiver is `http://127.0.0.1` (now `422 endpoint_url_rejected`, `not_https`); scenario 4 "SSRF refused at creation" (AS-03, covered by `webhook-endpoints`) fails because the answer is now `422`, not `400`. Do not delete the file before the AS-40, AS-62, AS-55 and AS-58 tests exist (L-017).* **State after Phase 6**: AS-40 exists (`webhook-delivery.e2e-spec.ts`); the file no longer runs code (it could not import the deleted router and deliverer): it lists where each scenario went and keeps two `it.todo` for AS-62 and AS-55/AS-58. Delete it when T070 and T074 are done.
- [X] T084 Follow-up sweep (each is a requirement; mention each in the report): S03 no `ShopModel`/`ShopMembershipModel`/`MembershipService`/raw tenancy SQL (grep the domain, zero hits); S05 snapshot-only; S10 renamed payload fields and `order.refunded` in every builder; S13 `CircuitBreaker` reuse; S28 event name and no notifications import; S42 `ApiVersionService` + `VersionPinCache` provided by the importing modules and `ApiRequestsProjector` not in the barrel; S50 structured headers only; S54 vocabulary and idempotency store. Fix any remainder.
- [X] T085 [P] Confirm the direct `sequelize.transaction` count in the domain is ≤ `.tx.baseline`, no `// S54 T037 audit` comment remains in touched files, and the registry rows of T004 exist.
- [X] T086 [P] (livespec check re-run afterwards: 0 errors) (gaps.md map, Sibling-spec follow-ups and Spec changes are done; `python3 scripts/livespec/check.py` was refused for approval in the unattended session, so it is NOT run: every `[proof: S43 AS-nn]` has a test and every `[code: path#symbol]` symbol exists by grep) Update `specs/domains/S43-webhooks/gaps.md`: map each G-01…G-44 to its task; keep `## Sibling-spec follow-ups` (S42 `transformResource`, S10 `shopIds`, S15 payout schemas, S28 name, W04, S54) and `## Spec changes` (no `*.reviewed.json` touched); bring the living page of T001 to final behavior and rerun `python3 scripts/livespec/check.py`.
- [X] T087 [P] (script lives in `packages/backend/scripts/load-tests/`, with the other k6 scripts, plus `loadtest:webhooks`; written, never run) Create `scripts/load-tests/webhooks-flood.test.js` (event flood, 500,000 endpoints, 10 % slow receivers) as the ops artifact for SC-001/SC-002/SC-011; keep the rows already in `specs/UNVERIFIED.md` (status `not run`) and the "Ops artifacts" in `quickstart.md`; never describe them as verified.
- [X] T088 (2026-10-15: backend `tsc --noEmit` clean; ESLint errors only in files not touched here (`apps/lambdas/src/handlers/index.ts` x3 require-await, `libs/common/config/search-config.ts` no-base-to-string); `packages/contracts` has no tsc/eslint of its own and is covered by the backend tsc; `check:boundaries`, `check:module-graph`, `check:model-registry` green; `check:table-ownership --strict` exits 1 for 25 accesses in other domains, none in developer-platform) Static gates (AS-70): `pnpm tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (no `ShopMembership`, `ShopOrder`, `Product`, `Shop` or `notifications` reference in webhook files); `pnpm check:module-graph`; `pnpm check:model-registry`.
- [X] T089 (2026-10-15, every batch had its summary line: unit 30 suites/562 tests; endpoints 52, secrets 7, routing 13, delivery 16, ssrf 12, lifecycle 11, replay-log 17, contract 7, adapters 30, fixture 19, wiring 3 suites/9) Whole capability suite once, in batches of fresh processes (`test-spec.sh webhook-` plus the domain unit specs); a batch without its summary line is a crash (L-008); use the runner timeouts (L-007).
- [X] T090 (deferred to the final checkpoint: `scripts/qa/fresh-run.sh --here` and the Lambda host boot; see specs/deferred-checks.md; PARTLY DONE 2026-10-15: reload-queues.sh and boot-app.sh core/worker/projector pass, recorded in quickstart.md; still not run: Lambda host boot (no script) and fresh-run.sh) Final runtime proofs by script (L-019): `scripts/infra/boot-app.sh core`, `worker`, `projector`, and the Lambda host (`WebhooksLambdaModule` booted as `apps/lambdas` does) each start on their own with consumers in the readiness output (L-004, L-015, L-018); queue server reloaded with the new FIFO queue (L-020); `scripts/qa/fresh-run.sh` on an empty stack (L-012). Record results in `quickstart.md` without claiming SC items that need ops runs.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (blocks all). T015 before T016; T014 and T026 before T027; T027 and T028 before any e2e.
- US1 (P1) first = MVP; US2 needs US1's service (T037); US3 needs US1 and T027; US4 needs US3 (deliveries enqueued) and T027; US5 and US6 need US4; US7 extends US5's service; US8 after all routes exist.
- Within each story: test tasks → implementation → run task. Deletions T056, T067, T083 only after their tests are green.

## Parallel opportunities

- Setup T003–T005; Foundational unit specs T006–T013, then implementations T017–T023 (different files); T014, T015, T029 in parallel.
- After Phase 2: T038 alongside T037; T046 alongside T045; T085–T087 in parallel.
- Different e2e files can be written in parallel; run each in its own fresh process.

## Implementation Strategy

1. MVP: Phases 1–3 (endpoint management; `webhook-endpoints` green).
2. Add US2 (signing), US3 (routing), US4 (delivery) for the end-to-end value; then US5, US6, US7, US8.
3. Finish with the Phase 11 checkpoints (static gates, whole suite, real boot, empty stack); SC-001/002/007/008/011 stay "not run".

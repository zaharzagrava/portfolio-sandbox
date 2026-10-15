# Implementation Plan: S43 — Webhook delivery to shops (domain `developer-platform`)

**Branch**: `S43-webhooks` | **Date**: 2026-10-15 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), constitution, and the follow-ups left by S03, S05, S10, S13, S28, S42, S50 and S54 (section "Follow-ups adopted").

## Summary

Rebuild the SD-30 webhook slice of `developer-platform` so that it meets the 71 acceptance scenarios and removes the constitution debt (D-6, D-7, D-8, D-12). The work is a re-layering plus a behaviour change, not a greenfield build:

1. **Pure domain** (`domain/`): `webhook-url`, `endpoint-status`, `retry-schedule`, `breaker`, `stock-low`, `webhook-event-mapper`, `webhook-settings`, a clock-injected `signature`. Each has a table-driven unit spec.
2. **Ports and adapters**: `EndpointRepository`, `EndpointHistory`, `DeliveryLog`, `BreakerStore`, `DeliveryQueue`, `OutboundHttp`, `RoutingReceipts` in `domain/webhook-ports.ts`; adapters in `infra/` (Sequelize, DynamoDB, Redis, SQS, S54 `safeRequest`).
3. **Application services**: `WebhookEndpointsService` (conditional transitions + history + outbox in one `TransactionRunner.run`), `WebhookRoutingService`, `WebhookDeliveryService` (atomic claim, record-and-schedule in one step), `WebhookReplayService`, `WebhookLifecycleService` (auto-disable, sweep, shop-deleted purge).
4. **Edges**: controller (`ShopScoped('webhooks.manage')`, problem+json codes, S50 policies, S54 idempotency store for replay), S53 consumers (`order.*`, `catalog.product_*`, `payout.*`, `tenancy.shop_deleted`) with schema validation, receipts and DLQ, SQS FIFO worker, Lambda handler (partial-batch response), S49 sweep job.
5. **Boundaries**: drop the `Shop` foreign key, drop every raw read of `ShopMembership`, `ShopOrder`, `Product`, drop the `NotificationsCoreModule` import, shrink the barrel to Nest modules.

## Technical Context

**Language/Version**: TypeScript 5 / Node 22, NestJS monolith plus `apps/worker`, `apps/projector`, `apps/lambdas`.

**Primary Dependencies** (all in the repo): `@app/infrastructure/{context (TransactionRunner, Transactional), events (defineEvent, outbox.append), projections (Projector, PermanentError), inbox, idempotency, rate-limit (definePolicies), jobs (JobHandler, cron), sqs (TaskQueue), net (safeRequest), lifecycle (graceful shutdown), cache}`; `@app/common/resilience` (`CircuitBreaker` reuse, S13 follow-up); identity `SecretBox` (context-bound sealing); `ApiVersionService` (S42); `zod` schemas from `packages/contracts`.

**Storage**: Postgres (`WebhookEndpoint`, new `WebhookEndpointHistory`, routing receipts through the S53 inbox), DynamoDB `WebhookAttempts` (delivery log + delivery state, TTL 30 d; kept as the spec fixes behaviour only), Redis (breaker state, disposable; S52 cache for subscriptions with cross-instance invalidation), SQS FIFO `webhook-deliveries.fifo` + DLQ.

**Testing**: Jest e2e through `scripts/sdd/test-spec.sh`, the eight e2e files and eight unit files of `test-plan.md`; Playwright only in W04/J02 (owned elsewhere).

**Target Platform**: Linux containers (core API, worker, projector) and AWS Lambda for the delivery handler.

**Project Type**: backend domain library in a pnpm monorepo (`packages/backend`, `packages/contracts`).

**Performance Goals**: SC-001 95 % within 5 s; SC-002 p99 < 2 s for healthy endpoints while one hangs; SC-011 5,000 deliveries/s (ops only).

**Constraints**: attempt deadline 10 s overall; response read cap 1 KiB; body cap 256 KiB; no network call inside a DB transaction; one retry layer; all numbers are configuration.

**Scale/Scope**: 20 endpoints per shop, 500,000 endpoints, 30-day log, 400-day history.

No `NEEDS CLARIFICATION` remains; unknowns were resolved in `research.md`.

## Follow-ups adopted (each is a requirement; test in brackets)

| From | Requirement | Where / test |
|---|---|---|
| S03 | Replace `ShopModel`/`ShopMembershipModel`/raw tenancy SQL; `webhooks.manage` for all routes; closed shops answer `403 shop_suspended` / `409 shop_offboarding` for write routes; VIEWER/STAFF denied | `ShopScoped('webhooks.manage')`; AS-13 table adds a suspended and an offboarding shop row (retest) |
| S05 | Consume full-state `catalog.product_*` (`productVersion, quantity, inStock, status, shopId, priceMinor, isSandbox`); tombstone state = delete; no `Product` read; `catalog.product_changed` ignored | `WebhookProductConsumer`; AS-27, AS-28, AS-29, AS-32 |
| S10 | Parse the renamed order events (`totalMinor`, `unitPriceMinor`, `title`, `lineTotalMinor`, `paymentRef`, `shopOrders`, `orderVersion`, `previousStatus`); consume `order.refunded`; `webhooks.e2e-spec.ts` payload builders replaced | `orderEventSchemas` from contracts; AS-23, AS-26 |
| S13 | Reuse `CircuitBreaker` from `@app/common/resilience` (no import from `payments`) | `domain/breaker.ts` is the pure state machine; the adapter wraps/mirrors the shared class if it fits (research R-07) |
| S28 | Emit `developer_platform.webhook_endpoint_disabled` v1 (host only) from the lifecycle service (today emitted as `developerplatform.webhook_endpoint_disabled` because the S53 envelope pattern forbids `_`); drop `NotificationsCoreModule`; the existing e2e test for it moves to AS-55/AS-58 | AS-55, AS-58, AS-70; see gaps.md follow-up on the event name |
| S42 | `ApiVersionService` (`supportedVersions`, `latestVersion`, `isSupported`, `getPinnedVersions`) + `VersionPinCache` provided by the importing modules; `ApiRequestsProjector` is not part of the barrel; idempotency store is the S54 one | AS-04, AS-24, AS-62/63 |
| S50 | Read structured `RateLimit` / `RateLimit-Policy` only (no `X-RateLimit-*`) in tests | AS-15, AS-65 |
| S54 | Failure vocabulary from `@app/infrastructure/net` (`blocked_address, unresolvable, invalid_url, redirect_refused, redirected_host, too_many_redirects, unsupported_content_type, timeout, tls_error, network_error`) for `details.reason` mapping and attempt `error` values | `OutboundHttp` adapter maps `SafeRequestError.kind`; AS-03, AS-51, AS-52 |
| S54 | Transactions only via `TransactionRunner`/`@Transactional`; delete `// S54 T037 audit` comments of touched files | every write path; tx baseline must not rise |

## Constitution Check

Gates from `.specify/memory/constitution.md` (I–X) and the PR gates.

| Principle | Status before design | How the plan satisfies it |
|---|---|---|
| I Layered modules (domain pure, no `Date.now()`, no framework) | Violated today (`signature.ts` default clock, `infra/` imported from `api/`, `application/` imports `infra/http-sender`) | Ports in `domain/`, clock injected everywhere, adapters only in `infra/` |
| II Pipeline and routing (controllers call application services only) | Violated (`controller` imports `WebhookRouterProjector`) | Controller → `WebhookEndpointsService`, `WebhookReplayService` only |
| III Data access and transactions | Violated (check-then-write limits, unconditional enable, tenant filter after load, raw `sequelize.query`) | Conditional updates with `WHERE id AND shopId [AND status]`, unique index + counter for limits, `TransactionRunner.run`, history + outbox in the same transaction, keyset pagination, no network in a transaction |
| IV Module/service communication | Violated (direct `NotificationRouter` call, event projector without inbox) | Outbox event for alert, S53 consumers with inbox and DLQ, jitter and one retry layer |
| V API contracts and errors | Violated (`204` on unknown delete, raw rows, `400` for semantic errors) | DTOs with whitelist, contracts schemas, problem+json `code`s of FR-050, `422` semantic, `202` for replay/ping, sub-resource actions |
| VI Frontend | N/A (W04 owns the screens) | Contract schemas only |
| VII Testing | Violated (`webhooks.e2e-spec.ts` calls services, injects `ShopModel`, spies its queue) | Split into eight HTTP e2e files; unit specs for pure logic only; fault tests for gate 9; each concurrency test repeated ≥ 20 times; old file deleted (scenarios mapped, L-017) |
| VIII Operational safety | Partial | Graceful shutdown (AS-54), metrics and structured logs with host only, explicit timeouts, startup config validation (AS-71) |
| IX Logical DB isolation | Violated (FK to `Shop`, reads of `ShopMembership`, `ShopOrder`, `Product`) | Drop FK by expand/contract with `lock_timeout`; events carry copies (R3); no foreign model in specs; registry rows for new tables |
| X Monorepo boundaries | Violated (barrel exports classes; Lambda imports `WebhookDeliverer`) | Barrel exports only Nest modules + DTO types; Lambda imports a hosting module; event schemas from `packages/contracts` |

**Gate result**: all existing violations are scheduled for removal by this plan, none is accepted. The only temporary exception is in Complexity Tracking.

**Post-design re-check** (after `data-model.md`, `contracts/`): no new violation. New table `WebhookEndpointHistory` is registered `domain:developer-platform`; the receipt store reuses the inbox (`infrastructure:inbox`); the `WebhookEndpoint` FK to `Shop` is dropped; counting endpoints per shop uses a counter column on a table of this domain (`WebhookShopCounter`), not a table of tenancy.

## Project Structure

### Documentation (this feature)

```text
specs/domains/S43-webhooks/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── http.md          # dashboard routes, DTOs, error codes, rate-limit policies
│   ├── events.md        # consumed and emitted events, ownership rows
│   └── outbound.md      # receiver contract: headers, body, signature, retry, verifier
└── tasks.md             # /speckit-tasks (not created here)
```

### Source Code

```text
packages/backend/libs/domains/developer-platform/
├── domain/
│   ├── signature.ts              # clock injected, strict parser, active-secret selection
│   ├── webhook-events.ts         # 11-type catalogue (+ since/resource/description)
│   ├── webhook-url.ts            # syntactic rules + normalisation
│   ├── endpoint-status.ts        # status union, transitions, failure-window rule, assertNever
│   ├── retry-schedule.ts         # delays, jitter (injected random), Retry-After merge
│   ├── breaker.ts                # pure state machine
│   ├── stock-low.ts              # rule on snapshot + occurredAt
│   ├── webhook-event-mapper.ts   # slice and mapping tables (orders, products, payouts)
│   ├── webhook-settings.ts       # configuration validation (AS-71)
│   └── webhook-ports.ts          # repositories and queue/http ports
├── application/
│   ├── webhook-endpoints.service.ts   # CRUD, enable/disable, rotate, expire-previous, limits
│   ├── webhook-routing.service.ts     # event → deliveries
│   ├── webhook-delivery.service.ts    # claim, send, record+schedule
│   ├── webhook-replay.service.ts      # replay, ping, log reads
│   ├── webhook-lifecycle.service.ts   # auto-disable, sweep, shop deleted, purge
│   ├── events/webhook-events.ts       # emitted event definitions
│   └── dto/webhook-*.dto.ts
├── api/webhooks.controller.ts, webhook-event-types.controller.ts
├── infra/
│   ├── sequelize-webhook-endpoint.repository.ts, sequelize-webhook-history.repository.ts
│   ├── dynamo-delivery-log.store.ts, redis-breaker.store.ts, sqs-delivery.queue.ts
│   ├── safe-outbound-http.adapter.ts   # S54 safeRequest
│   ├── webhook-consumers.ts            # order / product / payout / shop-deleted consumers
│   ├── webhook-workers.ts              # SQS consumer + jobs (retry, sweep)
│   └── webhook-lambda.handler-host.ts  # hosting module for apps/lambdas
├── webhooks-core.module.ts, webhooks.module.ts, webhooks-worker.module.ts,
│   webhooks-projector.module.ts, webhooks-lambda.module.ts
└── webhook-*.e2e-spec.ts (8 files); webhooks.e2e-spec.ts deleted
packages/contracts/src/developer-platform/webhooks.ts   # endpoint DTO, event types, error codes
packages/backend/migrations/<ts>-webhooks-v2.js          # history, counter, unique index, status, FK drop
packages/backend/db/ownership.ts                         # registry rows
docs/spec/capabilities/S43-webhooks.md                   # living page (created first)
```

**Structure Decision**: keep the existing `developer-platform` layout (domain / application / api / infra), add ports and five modules (core, dashboard, worker, projector, lambda host). `apps/lambdas/src/handlers/webhook-delivery.ts` imports only `WebhooksLambdaModule`.

## Order of work (feeds `/speckit-tasks`)

0. **Living spec first** (rule 0): create `docs/spec/capabilities/S43-webhooks.md` (no page exists today) with rules and `[proof]`/`[code]` markers modelled on S42's page; run `python3 scripts/livespec/check.py`; never touch `*.reviewed.json`.
1. Run `pnpm --dir packages/backend check:table-ownership` first (gaps.md note) and reconcile with gaps section 3; record baselines.
2. Contracts (`webhooks.ts`) and migrations (expand: history, counter, unique index, `status` column; contract: FK drop with `lock_timeout`; data-migration report for grandfathered endpoints).
3. Pure domain modules + unit specs.
4. Endpoint API + `webhook-endpoints` and `webhooks` (signing, rotation) e2e.
5. Consumers and routing + e2e; delivery + ssrf + replay-log + lifecycle e2e; contract e2e.
6. Remove the notifications import, barrel exports and SQL; delete `webhooks.e2e-spec.ts` after the scenario map (AS-16/18/35/40/03/62) is covered.
7. Final checkpoint with scripts (L-019): `check:table-ownership --strict`, `check:boundaries`, `check:module-graph`, `check:model-registry`, `tsc`, ESLint, whole capability suite once, **start the real apps** (`core`, `worker`, `projector`, Lambda handler host; L-004/L-015/L-018), `scripts/infra/boot-app.sh`, empty-stack run `scripts/qa/fresh-run.sh` (L-012).

## Known failure classes: how this plan avoids each

- **L-001/L-002/L-020**: `webhook-deliveries.fifo` options (`groupId`, `dedupeId`) only on that queue; retry lane goes through S49 jobs, never a standard queue with a group. Check `elasticmq.conf` has the FIFO queue and its DLQ; a new queue means a queue-server reload command is part of the task.
- **L-003**: no "A or B" assertions; environment limits are reported blocked.
- **L-005/L-006**: every e2e creates its own shops, endpoints, receiver ports and events; no seeded shared stock.
- **L-007/L-008**: runner timeouts, batches of fresh processes, summary line required.
- **L-010**: first-use creations (endpoint create with an existing URL) answer `409 duplicate_endpoint_url`.
- **L-013**: breaker/outage tests restore the stores they damage before the next test.
- **L-015/L-018/L-004**: real boot of every hosting module in the final checkpoint; standalone modules import everything they need (SecretBox's `AuthModule`, `VersionPinCache` provider, rate-limit module).
- **L-016**: the failure paths (DLQ, redrive, breaker-degraded) run in the same process and must not throw on the store being down.
- **L-017**: `webhooks.e2e-spec.ts` is deleted only after the scenario map above is green.

## Unverified criteria

SC-001, SC-002 at production scale, SC-011 and the real-app boot/empty-stack proofs have no automated test in the table: they go to `quickstart.md` "Ops artifacts" and to `specs/UNVERIFIED.md` as `not run`.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Possible feature-flagged `ShopOrder` join in the router for `order.cancelled`/`order.refunded` | `contracts/src/orders/order-events.ts` carries `shopIds` only on `order.reserved` today (S10 `[CONTRACT]` not yet shipped for cancel/refund); payout events have only the notifications consumer schemas | Dropping the join first would break cancel fan-out. Plan: fallback R1 `OrderQueryService.getOrderLines` (never raw SQL); removed when S10 ships; recorded in gaps.md sibling follow-ups |
| `WebhookShopCounter` table | the 20-per-shop invariant must be store-enforced (FR-005) without reading tenancy tables | A `COUNT(*)` check-then-insert is a race (III.6) |

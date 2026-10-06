# Gaps: S43 — Webhook delivery to shops (domain `developer-platform`)

What the current code gets wrong or lacks versus [`spec.md`](spec.md), the open debt-register rows that touch this capability, and this domain's cross-domain access lines. This is the implementation agent's to-do list. Paths are under `packages/backend/libs/domains/developer-platform/` unless stated.

Existing tests: `webhooks.e2e-spec.ts` (4 tests: verified signature and version-shaped slice, FIFO then job-lane retry with replay, SSRF refusals at create, dual-secret rotation). It injects the tenancy `Shop` model (`:11,:20,:68`), calls `WebhookEndpointsService` and `WebhookDeliverer` directly with no HTTP call (`:82,:85,:100-101,:109-111`, violates VII.2), and replaces the project's own queue method with a spy (`:73`). It is split into the files of `test-plan.md` and deleted; its four ideas move to AS-16, AS-18, AS-35, AS-40, AS-03 and AS-62 and are rewritten. `domain/signature.spec.ts` (1 file) is extended.

`pnpm --dir packages/backend check:table-ownership` could not be run while writing this file (running it needs an approval that was not available in this unattended session; `pnpm` also tried to reinstall dependencies). Section 3 is built from reading the code. **The implementation agent must run the command first, reconcile its `developer-platform` lines with section 3, and finish with `--strict` clean for this capability's files (AS-70).** Public-API and widget findings in the same domain belong to S42 and S44 and are only noted so nothing is lost.

## 1. Gaps in the code (spec reference → what is wrong or missing → fix)

### Endpoint API (`api/webhooks.controller.ts`, `application/webhook-endpoints.service.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-01 | FR-001, FR-009, AS-13 | Routes use `shop.manage` / `shop.read` (`controller:34,40,46,53,59,66,73,80`), so STAFF and VIEWER read order data in logs. | `ShopScoped('webhooks.manage')` on every route; table test over all routes for anonymous / STAFF / other shop. |
| G-02 | FR-009, AS-13 | `attempts` loads the endpoint by primary key and compares `shopId` afterwards (`controller:68-70`), returning `[]`; `replay` returns `{outcome: "skipped"}` with `200` (`deliverer:94-98`); `remove` deletes by `(id, shopId)` and answers `204` even when nothing matched (`service:90-93`). III.4 and V.4 violations. | Every lookup `WHERE id = :id AND "shopId" = :shopId`; `404 webhook_endpoint_not_found` / `webhook_event_not_found`, identical for unknown and cross-shop. |
| G-03 | FR-002, AS-02 | `UpdateEndpointDto.url` is a plain `IsString` (`controller:20`), `events` has no min size or duplicate check (`:21`), `CreateEndpointDto` allows `http` outside production through `require_tld: false` (`:14`); no max length, no max 20 types; unknown properties are not proven rejected. | Whitelisted DTOs with the limits of FR-002; zod/contract schemas in `packages/contracts` (V.2); one test per validation class. |
| G-04 | FR-003, AS-03 | The guard lives in `validateUrl` (`service:153-160`) and returns `400`; there is no port, IP-literal, user-info or `localhost` rule beyond what `resolvePublicTarget` happens to do; update validates the URL only when present and **enable does not re-check** (`service:63-75`). | Closed reason list with `422 endpoint_url_rejected`; re-check on create, URL update and enable; use S54's SSRF-safe client for the resolve step. |
| G-05 | FR-005, AS-11, AS-12 | No endpoint limit, no uniqueness of URL per shop. | Store-enforced 20 per shop (conditional insert or serialised counter) and a unique index on `(shopId, normalised URL)`; `422 endpoint_limit_reached`, `409 duplicate_endpoint_url`; two concurrency tests. |
| G-06 | FR-006, AS-08, AS-09 | Enable/disable is `PATCH {enabled}` with `coalesce` and no source-status condition (`service:63-75`); no history; returns `204` (`controller:48`); the cache is invalidated after the write. | `POST …/enable` and `POST …/disable` as conditional updates (`WHERE status = :from`) with a state-change row in the same transaction; `409 endpoint_state_conflict`; remove `enabled` from `PATCH`; `assertNever` over a status union. |
| G-07 | FR-004, AS-04 | `apiVersion` defaults to `LATEST_VERSION` (`service:49`) and cannot be changed afterwards (the update DTO has no field). | Default from S42 `ApiVersionService.getPinnedVersions`; `PATCH apiVersion`; validation by `isSupported`. |
| G-08 | FR-008, AS-05 | `list` returns every row, raw (`service:56-61`); no cursor, no DTO. | Keyset page `{items, nextCursor}` ordered `(createdAt desc, id desc)`; response DTO and contract schema. |
| G-09 | FR-010, AS-14 | No catalogue route; the UI hard-codes the types. | `GET webhook-event-types`. |
| G-10 | FR-011 | No history of changes and no events for endpoint changes. | State-change table (owned here) and `developer_platform.webhook_endpoint_changed` through `outbox.append` in the same transaction. |
| G-11 | FR-054, AS-15 | No rate limit on the routes. | Three policies in S50's registry; fail closed. |
| G-12 | FR-050, FR-051, AS-69 | Responses are raw rows or ad-hoc objects; errors come from `BadRequestException` strings; no contract schemas for webhooks in `packages/contracts`. | Response DTOs, contract schemas, problem+json `code`s from FR-050. |

### Secrets and signing (`domain/signature.ts`, `service:77-88`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-13 | FR-014, AS-20 | `rotateSecret` overwrites the previous secret with the current one unconditionally (`service:81`), so a second rotation inside the window locks out a receiver still on the first secret; the 24 h is a literal in SQL. | Conditional update refusing while a previous secret is valid (`409 rotation_in_progress`); `overlapHours` 1–72; `expire-previous-secret`. |
| G-14 | FR-013, AS-19 | The active set is computed with `Date.now()` in the service (`service:125`), after a 30 s cache (`:121`), so the boundary is not at the expiry instant and is not testable with a frozen clock. | Active secrets chosen at signing time from the injected clock; the cached record holds only sealed values and the expiry. |
| G-15 | FR-015, AS-22 | Secret is 192-bit (`service:46`); sealing has no context binding to the endpoint (`:50`, `:82`). | 256-bit; `SecretBox.seal(secret, "webhook-endpoint:<id>")` (S01); generate the ID before insert. |
| G-16 | FR-012, AS-17 | `signWebhook` and `verifyWebhook` default `now = Date.now()` in `domain/` (`signature.ts:12,18`), against I.3; `verifyWebhook` splits on `=` without rejecting duplicate `t` or malformed pairs and has no table test beyond one case. | Inject the clock; strict parser; table-driven unit spec (AS-17); publish the verifier in the docs. |
| G-17 | FR-016 | No reference verifier is published for receivers. | Export the pure function through the contracts package or docs bundle. |

### Routing (`infra/webhook-router.projector.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-18 | FR-021, AS-30, AS-31 | The router is a `Projector` with no inbox, no schema validation and no dead-letter; a failure inside the loop (`:45-49`) fails the whole batch and events before it are re-fanned. | Consumer on the S53 runtime: envelope check, zod validation, receipt per `eventId`, DLQ; per-event isolation. |
| G-19 | FR-022, FR-023, AS-23, AS-26 | Cancel path reads `ShopOrder` with SQL to find shops (`:97-100`) and returns whole-order data; the paid slice mixes minor units and floats (`:89-90`, `Number(p.price)` at `:129`); no `resource_version`, no `title`; buyer-free by luck. | Use `shopIds` (S10) and `shopOrders` from the event; integer minor units; add `resource_version`; mapper in `domain/` with a property test (slices partition lines). |
| G-20 | FR-020, AS-27, AS-29 | Only `order.paid`, `order.cancelled`, `product.stock_low`, `webhook.ping` exist (`domain/webhook-events.ts:2`); the products path reads `Product` with SQL on every `products.events` message (`router:115-118`) and treats any payload with a `productId` as a stock check (`:112-113`). | 11-type catalogue; consume `catalog.product_*` snapshots and S15 payout events; no product read. |
| G-21 | FR-025, AS-28 | Low stock is decided by reading the current quantity and a Redis `SET NX` marker (`:119-121`) with `new Date()` (`:120,127`); the marker store is a cache used as truth (III.9); the ID is derived from the wall-clock day. | Pure rule on the snapshot and `occurredAt`; deterministic ID per (product, day); no marker store. |
| G-22 | FR-024, AS-29 | Sandbox events are not filtered. | Drop `isSandbox` events. |
| G-23 | FR-022, AS-24 | The transformer is `domain/versioning.ts` (`transformForVersion`), a copy that S42 is replacing; `ping` is rendered as `resource: 'product'` (`controller:83`). | Use S42 `ApiVersionService.transformResource`; render pings without a resource type. |
| G-24 | FR-028, AS-34 | `subscribers` caches in a per-process hot layer for 60 s (`service:105`), so a disabled or edited endpoint keeps receiving on other instances; the delivery path caches `get` for 30 s (`:121`). | S52 cached read with cross-instance invalidation and no per-process layer for subscriptions; read `status` from the store at every attempt (AS-50). |
| G-25 | FR-027, AS-33 | The router enqueues per event sequentially and does not define behaviour when `enqueueBatch` fails after earlier shops succeeded. | Ack only after all endpoints' messages are accepted; deterministic dedup IDs so redelivery does not duplicate. |

### Delivery, retries, breaker (`application/webhook-deliverer.service.ts`, `infra/webhook-workers.ts`, `infra/http-sender.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-26 | FR-031, AS-38 | `postPinned` sets only the socket `timeout` (idle), not an overall deadline, and keeps reading the whole response (`http-sender.ts`, `res.on('data')`); a slow-drip receiver holds a worker indefinitely. | S54 `safeRequest` with overall deadline, read cap 1 KiB (abort), typed failures. |
| G-27 | FR-040, AS-51, AS-52 | The re-check and pinning exist (`deliverer:67-68`) but are not proven for redirects, mixed answers or mapped addresses; a non-SSRF error from `postPinned` is rethrown (`:70`) instead of being logged and retried. | Wire S54's client; every failure becomes a logged attempt; add the matrix tests. |
| G-28 | FR-032, AS-40, AS-41 | `RETRY_SCHEDULE_MIN` (`:24`) has no jitter and no `Retry-After`; exhaustion returns `skipped` silently (`:88`) with no state and no log; retry decision mixes three concerns in `deliver`. | Pure `retry-schedule` in `domain/` (injected random); `exhausted` terminal state; `Retry-After` merge. |
| G-29 | FR-033, AS-44 | Duplicate suppression relies on FIFO dedup (5 min window) only; nothing stops a second worker or a redelivered message from re-sending after `delivered`; `storeBody` is written before the breaker check (`:56`). The Lambda handler's comment claims "per-delivery sent markers" that do not exist. | Delivery record with state; atomic per-attempt claim; skip when `delivered`; correct the handler comment. |
| G-30 | FR-034, AS-47, AS-48, AS-49 | The breaker is an inline Redis counter with `Date.now()` (`:121-125`), no half-open probe (every delivery after expiry goes out), no state machine; a Redis failure throws out of `deliver`. | Pure breaker state machine in `domain/`; one probe; fail open with `webhook_breaker_degraded_total`. |
| G-31 | FR-033, AS-35 | Result of an attempt is written after the send and the retry is scheduled in a later call (`:78-90`, `:144-146`); a crash in between loses the retry; the log write failure is swallowed (`:183`). | Record the attempt and the next state together; a log-store failure fails the message so it is redriven (AS-46). |
| G-32 | FR-035, AS-45, AS-46 | The FIFO redelivery is driven by throwing an `Error` (`workers.ts:24-31`); there is no dead-letter policy, redrive test or poison test; `concurrency: 50` and `visibilityTimeoutSec: 30` are literals (`:30`). | S53 consumer runtime with DLQ and redrive; configuration. |
| G-33 | FR-037, AS-53 | No body size limit. | 256 KiB cap with `failed (payload_too_large)`. |
| G-34 | FR-036, FR-038, AS-43, AS-54 | No graceful-shutdown test of in-flight attempts. | Stop intake, finish ≤ 10 s, record, then close. |
| G-35 | FR-050, FR-052, AS-68 | `Logger.warn` with the endpoint ID only (`deliverer:139`); no metrics except the Lambda `DeliveryMs`; URL paths could reach logs. | Metrics list of FR-052; structured logs with host only. |

### Auto-disable, alert, log, replay, lifecycle

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-36 | FR-042, AS-55–AS-59 | Auto-disable runs only inside a failing attempt (`deliverer:128-130`); an endpoint whose deliveries are all exhausted is never disabled; no sweep job; `disable` returns the row and the notification is sent after the commit in a separate step (`:136`), so a crash loses the alert; `markFailing` and `markHealthy` race. | Sweep job `webhooks.disable-failing-endpoints` (S49, single run); disable and the outbox event in one transaction; conditional updates on `failingSince`. |
| G-37 | FR-042, AS-58 | `data: {url, …}` with the full URL goes to the notification (`:136`); `NotificationRouter` is imported from the notifications barrel (`:6`) and its module (`webhooks-core.module.ts:7,14`). | Event with `host` only; remove the import and module (S28 G-01). |
| G-38 | FR-043, AS-62 | Replay calls `deliver` with attempt 0, so a failing replay feeds the breaker, the failure window and auto-disable and enters the retry schedule (`:94-100`); it also sends inside the HTTP request. | `kind: replay | ping` deliveries: one attempt, no health effect, `202`. |
| G-39 | FR-046, AS-63 | No `Idempotency-Key` on replay. | Shared idempotency store (S53) with replay / in-flight `409` / different-body `422` / 24 h TTL. |
| G-40 | FR-047, AS-65 | `ping` fans out to all endpoints subscribed to `webhook.ping` (`controller:79-85`); no rate limit. | Per-endpoint ping route, rate-limited. |
| G-41 | FR-044, FR-045, AS-60, AS-61 | `attempts` returns the newest 50 with no cursor (`deliverer:102-113`); the sort key is the ISO time plus event ID, which is not unique; no event-detail route; TTL items could still be returned before physical removal. | Cursor on `(startedAt, attemptId)`; filters; event route; filter by age at read time. |
| G-42 | FR-048, AS-66 | No consumer of `tenancy.shop_deleted`: endpoints of a deleted shop stay, and keep failing (the FK to `Shop` also blocks hard deletes). | Consumer with inbox, zod validation, batches ≤ 1,000, DLQ. |
| G-43 | FR-044, AS-67 | State history and retention are undefined (log TTL is the only one, `deliverer:29`, `:440`). | State-change table with 400-day purge job; log read cut-off. |
| G-44 | FR-041, AS-71 | `webhooks_allow_private_hosts` (`libs/common/config/api-config.service.ts:385`) is ignored in production only at use time (`service:36-41`), not at startup; schedule numbers are literals. | Startup validation; configuration for the numbers of the Assumptions. |

## 2. Debt-register rows (open) that name `developer-platform` or apply to this capability

| ID | Rule | What it means here | IX.7 / X mechanism that replaces it |
|---|---|---|---|
| **D-12** | IX.4 | Raw SQL on other owners' tables from webhook code: `ShopMembership` (`application/webhook-deliverer.service.ts:132`), `ShopOrder` (`infra/webhook-router.projector.ts:97`), `Product` (`:115-118`). (`Shop`, `BisOrder`, `BisOrderItem` reads belong to S42.) | `ShopMembership` → **no read**: S43 emits `developer_platform.webhook_endpoint_disabled` and S28 resolves recipients with **R1** `MembershipQueryService.getMembersByShopIds`. `ShopOrder` → **R3**: the shops of a cancelled or refunded order come from `shopIds` on S10's event (fallback **R1** `OrderQueryService.getOrderLines`). `Product` → **R3**: the snapshot on S05's `catalog.product_*` events; low stock is computed from the snapshot. |
| **D-7** | IX.4 | Foreign model imports: the webhook e2e injects `ShopModel` (`webhooks.e2e-spec.ts:11,20,68`); production code imports no foreign model but `libs/domains/orders` event classes (`OrderPaid`, `OrderCancelled`, router `:9`) are used as parsers. | Specs seed shops through tenancy's exported services (**R1**). Event parsing moves to the `packages/contracts` event schemas (zod), not classes imported from the orders barrel (X.5 allows event contracts only). |
| **D-6** | I.2 | `api/` imports `application/` and `infra/` classes directly (`controller:7-9` imports `WebhookRouterProjector` from `infra/`); `application/` imports `infra/http-sender` (`deliverer:7`) and raw `sequelize.query` (`service`, `deliverer`). | Repository ports in `domain/` (`EndpointRepository`, `DeliveryLog`, `BreakerStore`, `DeliveryQueue`, `OutboundHttp`) with adapters in `infra/`; the controller calls only application services (II.1). |
| **D-8** | X.4 | The barrel exports `WebhookRouterProjector` (`index.ts:17`), `WebhookDeliverer` (`:15`), `WebhooksCoreModule` (`:11`); `apps/lambdas` imports `WebhooksCoreModule` and `WebhookDeliverer` (`handlers/webhook-delivery.ts:8`). | Export only Nest modules and DTO types; the Lambda imports a hosting module; apps import the worker/projector module, not classes. |
| D-9 (resolved), D-10, D-11, D-13–D-17 | — | Not named for this capability. | — |

## 3. `check:table-ownership` lines for `developer-platform` (webhook part; reconcile by running the command)

| Kind | Where | Finding | Replaced by |
|---|---|---|---|
| SQL | `application/webhook-deliverer.service.ts:132` | `SELECT "userId" FROM "ShopMembership"` | event for S28; S28 uses **R1** (S03) |
| SQL | `infra/webhook-router.projector.ts:97` | `SELECT DISTINCT "shopId" FROM "ShopOrder"` | **R3** (`shopIds` on `order.cancelled`/`order.refunded`) |
| SQL | `infra/webhook-router.projector.ts:115-118` | `SELECT … FROM "Product"` | **R3** (S05 snapshot) |
| FK | `migrations/20261001300000-webhooks.js:13` | `"shopId" UUID NOT NULL REFERENCES "Shop"("id")` (IX.4: cross-owner FK) | plain ID column; drop the constraint with expand/contract and a `lock_timeout` (III.11) |
| MODEL | `webhooks.e2e-spec.ts:11,20,68` | `ShopModel` injected through `forFeature` | tenancy **R1** seeding helpers |
| Import | `application/webhook-deliverer.service.ts:6`, `webhooks-core.module.ts:7,14` | `@app/domains/notifications` (`NotificationRouter`, `NotificationsCoreModule`) | event consumed by S28 |
| Registry | `packages/backend/db/ownership.ts:151` | `WebhookEndpoint` is registered; the new state-change table, the receipt/inbox use, and the log store must be added in the same PR | `domain:developer-platform` for the table and the log store; the inbox is `infrastructure:idempotency` |

## 4. Missing pieces to build (summary)

1. Contracts: schemas for endpoint DTOs, event bodies, error codes; zod schemas for consumed events.
2. Tables and store: state-change history, endpoint limit and unique URL, delivery state in the log store, receipts via the inbox; migrations expand/contract.
3. Domain: `retry-schedule`, `breaker`, `endpoint-status`, `stock-low`, `webhook-event-mapper`, `webhook-url`, the signature clock fix.
4. Application: endpoint service (conditional transitions, outbox), router consumer, delivery service (claim, record, schedule in one step), replay and ping, sweep job, shop-deleted consumer.
5. Infra: adapters for S54 `safeRequest`, S53 queue port and idempotency store, S52 cache, S50 policies; Lambda-hosting module.
6. Tests: the eight e2e files and seven unit files of `test-plan.md`; delete `webhooks.e2e-spec.ts`; W04 and J02 steps.
7. Run `pnpm --dir packages/backend check:table-ownership --strict`, `check:boundaries`, `check:module-graph`, `check:model-registry` and record the green run (VII.9).

## 5. Order of work

1. Contracts and migrations (FK drop, state-change table, limits).
2. Pure domain modules with their unit specs.
3. Endpoint API with its e2e (AS-01–AS-15, AS-18–AS-22).
4. Router and consumers (AS-23–AS-34, AS-66), then delivery (AS-35–AS-54), then lifecycle (AS-55–AS-59, AS-67), log and replay (AS-60–AS-65), observability and contract (AS-68–AS-69).
5. Remove the notifications import, the barrel exports and the SQL (AS-70) once S05, S10 and S28 provide their parts; until then keep a feature-flagged adapter only if the owning capability has not shipped (record it in the Complexity Tracking table of `plan.md`).

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

## Gap to task map (T086, 2026-10-15)

Every gap of section 1 has its tests and implementation in these tasks (`tasks.md`); all of them are closed by green suites except G-17 (docs page, see W07 below).

| Gap | Tasks | Gap | Tasks |
|---|---|---|---|
| G-01 | T035, T039 | G-23 | T022, T049 |
| G-02 | T027, T035, T037, T039 | G-24 | T051, T053 |
| G-03 | T014, T031, T038 | G-25 | T051, T053 |
| G-04 | T006, T017, T031, T037 | G-26 | T059, T064 |
| G-05 | T015, T034, T037 | G-27 | T063, T064 |
| G-06 | T007, T018, T033, T037, T039 | G-28 | T008, T019, T060 |
| G-07 | T030, T037 | G-29 | T061, T064 |
| G-08 | T032, T037 | G-30 | T009, T020, T062 |
| G-09 | T025, T039 | G-31 | T061, T064 |
| G-10 | T015, T027, T037 | G-32 | T061, T065 |
| G-11 | T029, T036 | G-33 | T059, T064 |
| G-12 | T014, T038, T081, T082 | G-34 | T060, T065 |
| G-13 | T043, T045 | G-35 | T066, T081, T082 |
| G-14 | T013, T024, T042, T045 | G-36 | T070, T071 |
| G-15 | T037, T044 | G-37 | T070, T071 |
| G-16 | T013, T024 | G-38 | T074, T077 |
| G-17 | T014 (export done), T046 (docs page open, W07) | G-39 | T075, T077 |
| G-18 | T050, T054 | G-40 | T076, T077 |
| G-19 | T011, T022, T048, T053 | G-41 | T073, T077 |
| G-20 | T025, T049, T054 | G-42 | T052, T054 |
| G-21 | T010, T021 | G-43 | T079, T080 |
| G-22 | T049, T053 | G-44 | T012, T023 |

## Sibling-spec follow-ups

- **S42**: export a pure `ApiVersionService.transformResource(type, resource, targetVersion)` (today only `isSupported`, `getPinnedVersions`, `supportedVersions`, `latestVersion` exist; the table is `domain/versioning.ts` `transformForVersion`/`downgradeResource`). S43 calls it for webhook bodies; until it exists S43 imports the same in-domain function, not a copy.
- **S10**: `order.cancelled` and `order.refunded` in `packages/contracts/src/orders/order-events.ts` need the additive `shopIds: ShopId[]` (today only `order.reserved` has it). Until then S43 uses the R1 fallback `OrderQueryService.getOrderLines` (never raw SQL); the fallback is deleted when `shopIds` ships.
- **S15**: S43 consumes `payout.paid` and `payout.failed` with `payoutVersion` and `periodStart`; the only schemas in the repo are S28's consumer copies in `contracts/src/notifications/consumed-events.ts`. S15 should publish its schemas in `packages/contracts` so both consumers share them.
- **S28**: the alert event is emitted as `developerplatform.webhook_endpoint_disabled` v1 (the S53 pattern forbids `_` in the first segment); the spec name `developer_platform.webhook_endpoint_disabled` is a logical alias. S28 keeps consuming the emitted name; S53 may rename later. `webhook_endpoint_changed` has the same constraint and is emitted as `developerplatform.webhook_endpoint_changed`.
- **W04**: adopt the schemas of `contracts/http.md` (paginated list and attempts, `POST enable|disable`, replay `202` with `Idempotency-Key`, per-endpoint ping, `webhooks.manage` for all routes, `422 endpoint_url_rejected` reasons).
- **S54**: `safeRequest` failure kinds are mapped to the attempt `error` values in one place, `infra/safe-outbound-http.adapter.ts`; a renamed kind changes only that file. The save-time check maps `checkSafeUrl` failures to the `details.reason` list in one place too, `infra/safe-address.guard.ts`.
- **W07**: the developer docs page (`packages/web/app/developers/docs/page.tsx`) needs a Webhooks section with the reference verifier of `contracts/outbound.md` (`parseSignatureHeader` and `verifySignatureWith` from `@marketplace-sandbox/contracts`, or the Node function `verifyWebhook`); its page test pins the section list (`Authentication`, `Errors`, `Deprecation`) and must change with it (S43 T046).
- **S03**: `ShopScoped('webhooks.manage')` puts the status gate on every route including reads: a suspended shop answers `403 shop_suspended` and an offboarding shop `409 shop_offboarding` also on `GET` list and read (S03's gate allows only `shop.read`, `members.read`, `shop.export` there). The S43 tests assert the write routes only (AS-13); say if reads of closed shops should stay open to `webhooks.manage`, which needs a gate change in S03.
- **S10**: until `shopIds` ships on `order.cancelled` and `order.refunded`, production deployments of the projector must set `WEBHOOKS_ORDER_SHOPS_FALLBACK=true`, or those two events are dead-lettered as invalid (AS-31). Removal: delete the flag, the `OrderCommandModule` import of `WebhooksProjectorModule` and the fallback branch of `shopsOf` in `infra/webhook-consumers.ts`, and make `shopIds` required in `webhookOrderEventSchemas`.
- **S15**: the payout consumer subscribes to `payouts.events` and parses `payout.paid`/`payout.failed` with the schemas S43 declares in `packages/contracts` (`webhookPayoutEventSchemas`); the topic name is the one `contracts/events.md` fixes and no producer exists in the repo yet.
- **S53**: the projection runner hands a consumer the payload parsed by the declared definition's schema, which strips fields the schema does not name. A consumer that needs a field its producer's definition lacks must declare its own definition of the type (done here, see the first Phase 5 and 6 decision).

## Spec changes

No `*.reviewed.json` exists for S43 and none is created. The living page `docs/spec/capabilities/S43-webhooks.md` was created by T001 (2026-10-15, `[proof: none]` on the rules whose end-to-end suites are not written yet; they get their proofs as each story lands). If it is signed later, any rule edit is listed here.

## Plan decisions that refine this file (see `plan.md`, `research.md`)

- G-04/G-05: unique index plus `WebhookShopCounter` (CHECK ≤ 20) instead of a conditional count.
- G-29/G-31: delivery state lives in the `WebhookAttempts` store with a transactional write of attempt and state; the SQS message carries no body.
- G-23: until S42 exports `transformResource`, the in-domain `transformForVersion` is reused (one registry).
- Section 5 item 5 exception (feature-flagged adapter) is recorded in the plan's Complexity Tracking (S10 `shopIds`).

## Decisions taken in Phase 1 and 2 (T001 to T029)

- Reference verifier (FR-016, G-17): `packages/contracts` exports the strict header parser `parseSignatureHeader` and `verifySignatureWith(hmac, equal, input)` with the HMAC injected, so the package stays free of Node built-ins (the web app imports it); the Node reference function the tests and the docs use is `verifyWebhook` in `domain/signature.ts`, which composes the two.
- `localhost` (and any name under it) is refused with `details.reason: blocked_address`, because `localhost` is not in the closed reason list and is a blocked target; an unparseable address and an address over 2,048 characters are `400 validation_failed` (AS-02).
- `product.stock_low` "nothing for a second qualifying snapshot of the day" is realised by the deterministic event id (`sha256('stock_low:' product ':' utcDay)`): the rule emits the same id again and the delivery record, created with a conditional put on `(endpoint, event)`, makes the second a no-op. T053 must create deliveries with `createDelivery` and treat `exists` as done; the S53 inbox receipt is keyed by the source event id and cannot dedupe two different source events of one day.
- FIFO deduplication id = digest of endpoint id, event id, attempt kind and attempt number (not the event id alone): the event id is per (source event, shop), so two endpoints of one shop share it and the queue deduplicates queue-wide.
- The `since` field of the event catalogue uses the two registered API versions (`2026-01-15`, `2026-10-01`) because the spec fixes no values.
- `WebhookEndpoint` gets a transitional trigger (`WebhookEndpoint_compat_trg`) so the code that still writes `enabled` and no `urlNormalized` keeps working until T037; the drop migration is listed there.
- Grandfathering (questions.md): duplicates keep the oldest row's address and the later rows get `#grandfathered-<id>` appended to `urlNormalized`; a shop above 20 endpoints gets counter 20; both are printed by the migration (0 rows on the test stack).

## Decisions taken in Phase 3 and 4 (T030 to T047)

- Default and explicit `apiVersion` (AS-04): no explicit value takes `ApiVersionService.getPinnedVersions` (the pin, else the concrete latest date); the contract schema also allows `latest`, which is resolved to the concrete latest date at write time, so a stored endpoint always carries a date and a later deploy of a newer version never moves it.
- Dashboard `breaker` field: `open` while the circuit is open or probing, `closed` otherwise (`BreakerStore.isOpen`); a store failure reads as closed.
- `hasPreviousSecret` and `previousSecretExpiresAt` of a read describe a previous secret that is still valid at the injected clock; once its expiry has passed the DTO shows none, although the sealed value stays stored until the next rotation or `expire-previous-secret` (which answers `409 no_previous_secret` for an already-expired one).
- Events `developerplatform.webhook_endpoint_changed` are written with aggregate version 0 (an endpoint has no version column); one event and one history row per changed facet; history `fromValue`/`toValue` carry the host for URL facets, the status for `status`, the comma list for `events`, the version for `api_version`, and nothing for secret facets.
- Values sealed before this change carry no context (`v1`); `WebhookEndpointLookup` still opens them without a context, new ones are `v2` bound to `webhook-endpoint:<id>`. A sweep that re-seals old rows is not part of this feature.
- The routes `GET …/attempts`, `POST …/events/:eventId/replay` and `POST …/ping` of the old controller are gone with the rewrite (the old forms are `[BREAKING]` and have no wired replacement before T073 to T077); the web dashboard (W04) calls them until then.
- The real-delivery tests of `webhooks.e2e-spec.ts` first drove `WebhookDeliverer.deliver` (the only sender that existed); since T064/T067 they send through the routed event and the worker's handler (see T041, T067).

## Decisions taken in Phase 5 and 6 (T048 to T068)

- Consumer contracts: each consumer declares its source events as plain `EventDefinition` objects built in `infra/webhook-consumers.ts` from the schemas of `packages/contracts` (`webhookOrderEventSchemas`, `productEventSchemas`, `webhookPayoutEventSchemas`, `webhookShopDeletedSchema`), not registered in the event registry (the owning domain registers its own definition of the same type and `defineEvent` refuses a duplicate). This keeps `shopIds` of `order.cancelled`/`order.refunded`, which the owner's schema does not yet declare and `z.object` would strip.
- Receipts: `RoutingReceipts` is the inbox (`InboxService.claim` / `markStatus`) keyed `(consumer group, source event id)`. A concurrent handler of the same event waits (poll 50 ms, up to 15 s) for the first and takes over if it failed; a failed handling leaves `FAILED` (re-claimed at once) and `PROCESSED` is written only after the lane accepted every message. A repeat of a failed handling (`attempts > 1`) re-enqueues the deliveries that exist and are still `queued`; a repeat of a handled event, or the second low-stock event of one UTC day (same deterministic id), enqueues nothing.
- Delivery plan: a lane message names the attempt it was queued for; the ordered lane shows the same message again for attempts 2 and 3, so an older number inside the lane is the delivery's current attempt. A message older than that outside the lane is a duplicate (acknowledged), except for a `retry_scheduled` delivery, whose job is scheduled again with its deterministic key (the worker may have died between recording and scheduling). An in-doubt claim is taken over after the attempt deadline plus 5 s (`attemptTimeoutMs + 5_000`) and consumes the next attempt number.
- Breaker hold: a claimed attempt is given back with `DeliveryLog.release` (`delivering -> retry_scheduled`, same attempt number) and a `webhooks.retry` job at the close time. The job key and the FIFO deduplication id carry the scheduled instant (`DeliveryMessage.scheduledFor`), otherwise a delivery put off again with an unchanged attempt number would be dropped as a repeat inside the queue's 5-minute window. After winning the probe lease the delivery reads the breaker once more and stands down if a probe that finished in between re-opened it.
- Replay and ping (`kind` other than `event`) already take the same path with one difference: a failure ends `failed` (no retry, no breaker, no failure window). The state of the replayed event's original record is the replay story's to define (T077).
- Health effects after the outcome is durable (breaker, `markHealthy`, `markFailing`) are best effort: a failing side store never turns a recorded attempt into a redelivery. Auto-disable by a failing attempt and the sweep belong to T071; this phase only starts the failure window.
- Lambda host: `handleRecord` parses the body with `deliveryMessageSchema` and rejects a body that is not a delivery (`InvalidDeliveryMessageError`); a lane failure rejects with `WebhookRedeliverError`. The queue's redrive policy (`maxReceiveCount = 5`) does the dead-lettering for the Lambda path; the SQS consumer of the worker sends a schema-invalid body to the dead-letter queue at once (`bodySchema`).
- A rendered body over about 380,000 bytes cannot be stored in DynamoDB (400 KB item limit): the routing refuses it with `PermanentError` (dead letter) instead of looping on a storage error. Bodies between 256 KiB and that limit are stored and end `failed (payload_too_large)` at delivery (AS-53).

## Decisions taken in Phase 7 to 10 (T069 to T082)

- Auto-disable: a failing attempt calls `WebhookLifecycleService.autoDisable` right after `markFailing` returned the window start (inclusive, `failingSince <= now - 3 d`); the sweep job `webhooks.disable-failing-endpoints` (every 15 minutes, `overlap: skip`) calls the same method for endpoints no attempt reaches. The conditional update, the history row (actor null) and the outbox events (`developerplatform.webhook_endpoint_disabled` and `..._changed` with `disabled`) are one `TransactionRunner.run`; the cache invalidation and the cancellation of pending deliveries (`DeliveryLog.cancelPending`, reason `endpoint_disabled`) follow the commit and are repeated by the sweep or done lazily by the next attempt if they fail. An error in the attempt path never fails the message (the sweep completes it).
- The history retention job is `webhooks.purge-history` (daily 03:17, single run); a row is deleted when `createdAt <= now - 400 d` (`deleteOlderThan` now inclusive, symmetric with the log's 30-day cut-off).
- Replay delivery record: a replay re-sends the event id of the original, so it gets its own log item keyed `<eventId>#replay#<deliveryId>` (`deliveryKey` in `domain/webhook-ports.ts`); pings have a fresh event id and need no suffix. Event detail always reads the original (an event id must match `evt_` plus 32 hex, so a crafted id cannot reach a replay item). The detail's `attempts` counts every attempt of the event id, replays included. The FIFO deduplication id of a replay or ping also carries the delivery id.
- Replay idempotency uses the platform store (`@Idempotent`, scope `shop:<shopId>:webhooks.replay`, 24 h, header `Idempotent-Replayed`); a malformed key is `400 validation_failed`; failures other than final ones release the key. A queue failure on replay or ping answers `503 service_unavailable` with `Retry-After: 1`; the `queued` record stays inert until its expiry.
- Ping rate limit subject is the endpoint id (`webhooks.ping.endpoint`, `subject` option of `@RateLimit`).
- Observability: one structured line per attempt (`action: webhook.attempt`, `requestId` = `webhook-attempt:<deliveryId>:<attempt>` because an attempt has no HTTP request, delivery, endpoint, event, kind, attempt, status, error, outcome, durationMs, host). `webhook_lane_age_seconds` is set when a worker claims a delivery (age since queued, or since its retry was due); `webhook_endpoints_breaker_open` is the count of endpoints this process saw open and not closed since; `webhook_dead_lettered_total{lane}` counts lane `delivery` for a body refused by the queue's schema and for the receive that reaches `DELIVERY_MAX_RECEIVES` (5) in the worker and the Lambda host, and lane `router` once per source event for a `PermanentError` raised by a consumer. Schema-invalid envelopes are dead-lettered by the consumer framework before a consumer runs and show only as its `dlq_total`; counting them under `lane=router` needs a hook in S53 (sibling follow-up below).
- `webhookProblemSchema` joins `CT/webhooks.ts` (problem document with `details` and `errors`).

### Sibling-spec follow-ups added in Phase 7 to 10

- **S53**: a dead-letter hook (or the consumer name and reason in a callback) on `ProjectionRunner.deadLetter` so a domain can count `webhook_dead_lettered_total{lane=router}` for envelopes the framework refuses before the consumer runs.
- **S28**: the disabled-endpoint event is still emitted as `developerplatform.webhook_endpoint_disabled` (name pattern), payload `{endpointId, shopId, host, failingSince}` with `failingSince` as an ISO instant.

## Gate repairs

- Test integrity: the gate refused the deletion of `developer-platform/webhooks.e2e-spec.ts` (it carried no scenario id and its subject `webhooks.ts` never existed). The signing and rotation file `webhook-secrets.e2e-spec.ts` (AS-16, AS-18 to AS-22; many more `it`/`expect` calls than the old file's 24) now lives at that path; its content is unchanged. The old five ideas map to: signed POST (AS-16), FIFO then job lane and replay (AS-40, AS-62), auto-disable fact (AS-55, AS-58), SSRF at creation (AS-03), rotation (AS-18, AS-19). References in `test-plan.md`, `plan.md`, `quickstart.md`, `tasks.md` follow the new name.
- Environment fault, not code: the 7 failures in `public-api-logs-usage.e2e-spec.ts` and `developer-platform-consumers.e2e-spec.ts` (all S42 scenarios, AS-60, AS-62, AS-63, AS-35) were `Unknown table expression identifier 'api_requests'`. The test ClickHouse database `marketplace_test` (port 8223) had no tables (L-011, same as S42 gaps). Fix: `node --env-file=.env.test -r ts-node/register -r tsconfig-paths/register scripts/clickhouse/migrate.ts` from `packages/backend` applied all 16 files. Both specs pass afterwards (27 and 9 tests). No product code or test was changed.

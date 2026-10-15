# Research: S43 — Webhook delivery to shops

Every unknown of the Technical Context, with the decision. Facts about the repo were read on 2026-10-15.

## State of the dependencies (what exists, what does not)

| Dependency | Found | Consequence |
|---|---|---|
| `@app/infrastructure/net` `safeRequest` | exists: `method, url, headers, body, timeoutMs, maxResponseBytes, allowedPorts, followRedirects:false, resolver?`; result has `status, snippet, durationMs`; typed `SafeRequestError.kind` | use as the only outbound path; S43 maps `kind` to attempt `error` and to `details.reason` |
| S54 `TransactionRunner`, `@Transactional`, `assertNoActiveTransaction` | exists | all writes; network sends guarded by `assertNoActiveTransaction` |
| S53 `defineEvent`, outbox append, `Projector` + `PermanentError`, inbox, idempotency store | exist; `DEVELOPER_PLATFORM_AGGREGATE` already defined | consumers follow `infra/consumers.ts` (S42) |
| Order events in `packages/contracts/src/orders/order-events.ts` | `shopIds` appears once (reserved); no `shopIds` on `order.cancelled`/`order.refunded` | S10 follow-up outstanding: fallback in Complexity Tracking |
| `catalog.product_*` snapshot schemas in `packages/contracts/src/catalog` | exist (`productSnapshotSchema`, deleted payload) | direct use |
| Payout events | only `payout.paid/failed` in `contracts/src/notifications/consumed-events.ts` (consumer schemas of S28) | S43 adds its own strict consumer schema in `contracts/src/developer-platform/webhooks.ts` that must stay compatible; sibling note to S15 |
| `ApiVersionService.transformResource` | **absent** (only `isSupported`, `getPinnedVersions`, …); transformer today is `domain/versioning.ts` `transformForVersion` in the same domain | S42 is in the same domain: add `transformResource` as a thin export of `transformForVersion`/`downgradeResource` (no copy of the table); sibling note to S42 |
| `CircuitBreaker` in `@app/common/resilience` | to be read at task time | breaker rules of S43 are a pure function (`domain/breaker.ts`); the Redis adapter keeps state; reuse the shared class for time-based half-open if its API fits, else implement the pure machine and note why |
| Idempotency store | `infrastructure/idempotency` (`Idempotent`, claim, fingerprint) | replay route; `422 idempotency_key_required` handled in a small guard |
| Rate-limit | `definePolicies('developer-platform', …)` in `rate-limit-policies.ts` | add three policies, all `failMode: 'closed'` |

## Decisions

### R-01 Layout and ports
- **Decision**: ports in `domain/webhook-ports.ts`, adapters in `infra/`, services in `application/`.
- **Rationale**: removes D-6; makes every dependency (clock, random, resolver, queue, log store) injectable for the "only fakes at the edge" test rule.
- **Alternatives**: keep `sequelize.query` in services (rejected: D-6, III).

### R-02 Endpoint status and transitions
- **Decision**: replace `enabled BOOLEAN` by `status TEXT` (`enabled|disabled`) + `disabledReason`; every change is `UPDATE … WHERE id=:id AND "shopId"=:shopId AND status=:from RETURNING *` in the same `TransactionRunner.run` that inserts the history row and appends the outbox event; zero rows → `409 endpoint_state_conflict`.
- **Rationale**: FR-006, AS-09. Expand/contract: add column, backfill from `enabled`, switch code, drop `enabled` in the contract migration.
- **Alternatives**: advisory locks (rejected: conditional update is simpler and testable with `Promise.all`).

### R-03 Endpoint limit and unique URL
- **Decision**: unique index on `("shopId", "urlNormalized")`; limit through `WebhookShopCounter(shopId, count)` incremented with `UPDATE … SET count=count+1 WHERE shopId=:s AND count<20` (insert-on-conflict for first use), decremented on delete, in the same transaction as the endpoint row.
- **Rationale**: invariant held by the store (III.6); no read of tenancy tables.
- **Alternatives**: `COUNT(*)` then insert (race); serialisable transaction (retries, harder to reason).

### R-04 Secrets
- **Decision**: 32 random bytes → `whsec_` + base64url (43 chars); sealed with `SecretBox.seal(secret, "webhook-endpoint:<id>")`; the ID is generated (uuid) before insert. Active secrets chosen at signing time from the injected clock: current always, previous only while `now < previousSecretExpiresAt`. The cache holds sealed values and the expiry only. Rotation `UPDATE … WHERE previousSecretSealed IS NULL OR previousSecretExpiresAt <= now`.
- **Rationale**: FR-013–FR-015, AS-19, AS-20, AS-22.

### R-05 Routing
- **Decision**: one consumer per source topic (`webhook-router-orders`, `-products`, `-payouts`, `-shop-deleted`); each validates the envelope with the contracts schema (invalid → `PermanentError` → DLQ), takes a receipt (`inbox`, key = source `eventId`) in the same step as queue acceptance, maps through `webhook-event-mapper` (pure), reads subscribers through the S52 cache with cross-instance invalidation (TTL ≤ 5 s upper bound, invalidated by endpoint writes), enqueues one FIFO message per endpoint with `groupId = endpointId` and `dedupeId = evt id`. If any enqueue fails the consumer throws before the receipt commits, so redelivery completes the rest; deterministic FIFO dedup IDs prevent duplicates (FIFO dedup window 5 min; the delivery record's unique `(endpointId, eventId)` is the durable guard).
- **Event ID**: `evt_` + first 32 hex chars of `sha256(sourceEventId ':' shopId)`; stock-low: `sha256('stock_low:' productId ':' utcDay)`.
- **Alternatives**: keep a `Projector` loop with per-event try/catch (rejected: no inbox).

### R-06 Delivery state and the "record + schedule in one step"
- **Decision**: delivery record in the log store (`DeliveryLog`): `PK endpointId`, `SK delivery#<eventId>` with state, attempt counter, `nextAttemptAt`, body; attempts `SK attempt#<startedAt>#<attemptId>`. Claim = conditional update `state IN (queued, retry_scheduled) AND attempt = :n` → `delivering`. Result write = one transactional write of attempt item + new delivery state (`DynamoDB TransactWriteItems`). A retry is a delayed S49 job (`webhooks.retry`, idempotency key `eventId:attempt`) enqueued after the state is written; if the enqueue fails the message is not acknowledged and the delivery stays `retry_scheduled` with `nextAttemptAt`, so the redelivered message re-enqueues. A log-store failure fails the message (AS-46).
- **In-doubt crash** (AS-43): a claimed attempt older than the visibility timeout is re-claimable and consumes its number.

### R-07 Breaker
- **Decision**: pure `breaker.ts` — `decide(state, now) → send | skip(until) | probe`, `onResult(state, ok, now)`; durations `min(30, 2^(failures-5))` minutes from the 5th failure; Redis adapter stores `{failures, openUntil, probeLease}` with a Lua/`SET NX PX` probe lease; every store error → `send` + `webhook_breaker_degraded_total`. The shared `CircuitBreaker` class from `@app/common/resilience` is reused only if it can carry per-endpoint state and the doubling schedule; otherwise the reason is recorded in `tasks.md` and the pure machine stays (S13 follow-up satisfied by not importing `payments`).

- **Decided at T020 (2026-10-15)**: the pure machine stays and the Redis adapter mirrors it; `CircuitBreaker` of `@app/common/resilience` is not wrapped. Reason, read from `libs/common/resilience/circuit-breaker.ts`: it is an in-process object per dependency (state in fields, not shareable between instances), opens on a rolling failure *rate* over a window with `minimumCalls`, uses one fixed `openDurationMs` (no doubling to 30 min), and admits `halfOpenCalls` trial calls that must *all* succeed. S43 needs consecutive-failure counting (open at the 5th), a doubling open time, exactly one probe, and state shared by every instance through Redis that may be lost at any time. `domain/breaker.ts` (`decideBreaker`, `onBreakerFailure`, `onBreakerSuccess`) is that rule as a pure function; `infra/redis-breaker.store.ts` keeps `{failures, openUntil}` plus a `SET NX PX` probe lease. No import from `payments`, so the S13 follow-up (no copy of the payments breaker) holds.

### R-08 SSRF
- **Decision**: save-time guard = `webhook-url.ts` (syntax: https, no user-info, port 443, no IP literal, no `localhost`, ≤ 2,048) then `checkSafeUrl` (resolution, all addresses public). Delivery = `safeRequest` per attempt. Mapping of failures: `details.reason` ∈ `not_https | credentials_not_allowed | port_not_allowed | ip_literal | blocked_address | unresolvable` (closed list of the spec; S54 kinds `invalid_url` map to the syntactic reason, `blocked_address` and `unresolvable` pass through); attempt `error` uses the S54 vocabulary (`blocked_address, timeout, tls_error, network_error, redirect_refused`; a `3xx` result is a failure with its status). Private-host allowance: config list, rejected at startup in production (AS-71).

### R-09 Replay and ping
- **Decision**: `202` after writing a `queued` delivery with `kind: replay|ping` and enqueuing on the endpoint's FIFO group; one attempt, no retry, no effect on `failingSince`/breaker/count. Idempotency via the shared store (fingerprint = endpointId + eventId, TTL 24 h). Replay re-sends the stored body bytes with a fresh `t`.

### R-10 Auto-disable
- **Decision**: failure window kept on the endpoint row: `failingSince` set `WHERE failingSince IS NULL`, cleared on `2xx`. Disable = conditional update `status='enabled' AND failingSince <= now-3d` + history + outbox event (`WebhookEndpointDisabled`) in one transaction; the sweep job `webhooks.disable-failing-endpoints` (S49 cron `*/15`, single run) calls the same method. Event name: the S53 envelope pattern forbids `_` in the first segment, so the emitted type stays `developerplatform.webhook_endpoint_disabled` (already consumed by S28); spec text `developer_platform.…` is documented as the logical name (see gaps.md).

### R-11 Pagination and cursors
- **Decision**: opaque base64url JSON `{createdAt, id}` (list) and `{startedAt, attemptId}` (attempts), validated by zod; tampering → `400 invalid_cursor`.

### R-12 Contracts and errors
- **Decision**: `packages/contracts/src/developer-platform/webhooks.ts` holds request/response schemas, the event-type catalogue and the error-code union; the controller validates with the same schemas (zod body pipe already in `api/zod-body.pipe.ts`).

### R-13 Retry classification and Retry-After
- **Decision**: as spec: every non-2xx is a failure; delays `[5,30,120,300,600,1440,1440,1440]` min × `0.8 + 0.4·random`, `max(delay, Retry-After)` capped at 24 h; attempts 1–3 in the lane 30 s apart (visibility-based requeue at 30 s).

### R-14 Barrel and hosting
- **Decision**: barrel exports `WebhooksModule`, `WebhooksWorkerModule`, `WebhooksProjectorModule`, `WebhooksLambdaModule` and DTO types. `PublicApiProjectorModule`-style app-level imports; `apps/lambdas` handler boots a Nest application context from `WebhooksLambdaModule`.

### R-15 Migrations
- **Decision**: new migration after `20261001300000-webhooks.js` with `SET lock_timeout`: add `status`, `urlNormalized`, history table, counter table; backfill; unique index created `CONCURRENTLY` (separate non-transactional migration step); drop FK to `Shop` and `enabled` in a following contract migration. Endpoints beyond the limits or with duplicate URLs are grandfathered: the unique index is partial (`WHERE "createdAt" >= cutoff`) or the duplicates are suffix-marked and listed in a report file under `specs/domains/S43-webhooks/` (decide in the task, no deletion).

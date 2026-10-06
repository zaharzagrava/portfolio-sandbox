# Questions and defaults: S43 — Webhook delivery to shops

Decisions taken unattended, sorted by impact. Review `[BREAKING]` and `[CONTRACT]` lines first. Policy: most production-grade option the notes and the constitution support.

## [BREAKING]

- [BREAKING] Permission on every webhook route (today `shop.manage` for writes, `shop.read` for list and attempts, so STAFF and VIEWER can read order data in logs) → `webhooks.manage` (OWNER, ADMIN) for all routes → S03 already defines it; bodies and logs contain order data (III.4, V.4).
- [BREAKING] Cross-tenant and unknown IDs (today `GET attempts` returns `[]`, replay returns `200 {outcome:"skipped"}`, delete of an unknown ID returns `204`) → `404 webhook_event_not_found` / `webhook_endpoint_not_found`, byte-identical for cross-shop and unknown → V.4 (hide existence), VII.3 IDOR.
- [BREAKING] Address guard failures (today `400`) → `422 endpoint_url_rejected` with `details.reason`; plain malformed input stays `400 validation_failed` → V.4 (`422` for semantic validation).
- [BREAKING] URL rules (today `http` allowed outside production by DTO, `require_tld: false`, any port the guard allows) → https only, port 443, no user-info, no IP literals, no `localhost` → SD-30 SSRF row, P0507; the private-host allowance stays as a non-production configuration seam and startup fails if set in production.
- [BREAKING] `PATCH` no longer takes `enabled` (today it re-enables and clears failure state, returns `204`); new `POST …/enable` and `POST …/disable`; `PATCH` returns `200` with the endpoint → V.5 (actions are sub-resources), III.7 (conditional transitions with a history row; illegal ones give `409`).
- [BREAKING] `GET` list is paginated (`{items, nextCursor}`) and returns a DTO with no secret-related fields besides `hasPreviousSecret` and `previousSecretExpiresAt` (today a bare array of raw rows incl. `disabledReason`, `failingSince`) → III.10, V.1.
- [BREAKING] `GET …/attempts` becomes `{items, nextCursor}` with filters and a stable cursor (today the newest 50 as a bare array, no cursor) → III.10; new `GET …/events/:eventId`.
- [BREAKING] Replay (today synchronous: sends the request inside the HTTP call, returns `{outcome}`, re-enters the retry and auto-disable logic) → `202` queued, goes through the endpoint's ordered lane, one attempt, no retry, no health effect, `Idempotency-Key` required, `409` for disabled endpoints → III.3 (no network in the request path), V.6, D24; replay failures must not auto-disable a shop's endpoint.
- [BREAKING] Ping (today `POST …/ping` fans a fake `product` resource out to every endpoint subscribed to `webhook.ping`) → `POST …/:id/ping` to one endpoint, even if not subscribed → "test this endpoint" is per endpoint.
- [BREAKING] Rotation (today a second rotation silently overwrites the previous secret, so a receiver that had not deployed the first rotation is locked out; fixed 24 h) → `409 rotation_in_progress` while a previous secret is valid, `expire-previous-secret` to end early, `overlapHours` 1–72 → P0418 "two active secrets"; never more than two.
- [BREAKING] Event catalogue (today `order.paid`, `order.cancelled`, `product.stock_low`, `webhook.ping`) → 11 types adding `order.refunded`, `product.created|updated|archived|deleted`, `payout.paid|failed` → S10/S05/S15 events exist and name S43 as a consumer; additive for receivers.
- [BREAKING] Payload (today `{id, object, type, created, api_version, data}` with `total`/`unit_price` taken from float-capable fields, `Number(price)` for products, buyer-free) → adds `resource_version`, integer minor units everywhere, `title` on lines, `shop_order_id`; cancel/refund carry no amounts → IX.8 (event copies), P0608 (sequence for ordering), privacy of other shops' sales.
- [BREAKING] Source events (today the router reads `ShopOrder` and `Product` with SQL, and `product.stock_low` is decided by reading the current quantity and a Redis marker) → the router uses only event payloads (S10 `shopIds`, S05 snapshot) and a deterministic per-day event ID → IX.4, IX.7 R3, D-12.
- [BREAKING] Alert on auto-disable (today `NotificationRouter.dispatch` plus a SQL read of `ShopMembership`) → outbox event `developer_platform.webhook_endpoint_disabled`, consumed by S28 → IV.1, IV.4, IX.4; S28 already requires it.
- [BREAKING] Endpoint rules new: ≤ 20 endpoints per shop, unique normalised URL per shop, `WebhookEndpoint → Shop` foreign key dropped → III.6 (invariants in the store), IX.4 (no cross-owner FK). Existing rows beyond the limits are grandfathered by a data migration report, not deleted.
- [BREAKING] Retry numbers made explicit and jittered (today 3 receives then 5, 30, 120, 300, 600, 1440, 1440, 1440 minutes, no jitter, exhausted deliveries silently `skipped`) → same steps with ±20 % jitter, `Retry-After` honoured, `exhausted` is a visible terminal state with 11 attempts → IV.6 (jitter), P0418.
- [BREAKING] Delivery deadline (today a socket idle timeout of 10 s, so a slow-drip response can run forever) → overall 10 s deadline → SD-30 "10 s timeout", IV.6.
- [BREAKING] Log reads exclude secrets, headers and signatures; items older than 30 days are never returned even if not yet purged → privacy; matches TTL.
- [BREAKING] The barrel stops exporting `WebhookDeliverer`, `WebhookRouterProjector`, `WebhookEndpointsService`, `WebhooksCoreModule` (the Lambda handler and apps import hosting modules) → X.4, D-8.
- [BREAKING] The e2e spec `webhooks.e2e-spec.ts` is rewritten (calls services directly, injects `ShopModel`, spies on its own queue) and split into the files of `test-plan.md` → VII.2, D-7.

## [CONTRACT]

- [CONTRACT] S10 → add additive `shopIds: ShopId[]` to `order.cancelled` and `order.refunded` (S10's spec has `shopIds` only on `order.reserved`) → without it S43 must keep the `ShopOrder` join (D-12). Fallback if refused: R1 `OrderQueryService.getOrderLines([orderId])` returning `shopId` per line.
- [CONTRACT] S42 → export a pure `ApiVersionService.transformResource(type, resource, targetVersion)` (S42 exports only version lookups today) → webhook bodies and REST bodies must render with one transformer (P0413); fallback: S43 owns a copy of the downgrade table (rejected: two registries drift).
- [CONTRACT] S54 → an SSRF-safe **POST** client (`safeRequest`) with overall deadline, pinned address, no redirects, injectable resolver, typed failures; S41 specifies `safeGet` only → the guard is one component (P0507).
- [CONTRACT] S53 → FIFO queue port with group ID and dedup ID, visibility timeout, DLQ with redrive and partial-batch response; shared idempotency store (also required by S42) used by replay → P0604, P0414.
- [CONTRACT] S28 → consumes `developer_platform.webhook_endpoint_disabled` v1 `{endpointId, shopId, host, failingSince}` exactly as S28 asked; it resolves owners itself → one event per failure window.
- [CONTRACT] S03 → `webhooks.manage` (OWNER, ADMIN) used for all routes; `tenancy.shop_deleted` consumed → already in S03's matrix and events.
- [CONTRACT] S15 → S43 becomes a consumer of `payout.paid` and `payout.failed` (S15 lists S28, S16, J01) → adds a consumer group only; no change for S15.
- [CONTRACT] S05 → S43 consumes `catalog.product_*` snapshots incl. `isSandbox`, `changedFields`, `productVersion`; no table read → P0608, R3.
- [CONTRACT] S08, S07, S09, S29 optional events (`integration_*`, `import_finished`, `offline_conflict_opened`, `gallery_changed`) → not in the catalogue; they can be added later without breaking receivers → keeps this release small.
- [CONTRACT] W04 → consumes the dashboard routes and schemas of "Provides"; shows the secret once; the UI never calls the receiver.
- [CONTRACT] S50 → three policies registered (`webhooks.manage.shop`, `webhooks.replay.shop`, `webhooks.ping.endpoint`), all fail closed.

## [LOCAL]

- [LOCAL] Retry classification → every non-2xx and every error is retried; redirects are failures → receiver misconfiguration is usually fixed inside 3 days; departs from the narrow IV.6 list on purpose.
- [LOCAL] Ordered lane keeps 3 attempts then leaves → SD-30; a retried event can arrive after newer ones; `created` + `resource_version` document it.
- [LOCAL] Breaker 5 failures, 1 min doubling to 30 min, one probe → SD-30 and 06/03; fail open if its store is down.
- [LOCAL] Auto-disable after 3 days continuous failure, plus a 15-minute sweep → SD-30; both paths are conditional updates, one event per window.
- [LOCAL] Replay and ping are one attempt, no retry, no health effect → operator-driven.
- [LOCAL] Secret is 256-bit `whsec_` + 43 base64url characters (today 192-bit) → modern default.
- [LOCAL] Suspended shops keep receiving; sandbox shops never do → S42 says "no sandbox webhooks".
- [LOCAL] Replay `Idempotency-Key` TTL 24 h → V.6.
- [LOCAL] Body cap 256 KiB; snippet 1 KiB; log TTL 30 d; history 400 d.
- [LOCAL] `stock_low` threshold fixed at 5, once per product per UTC day by `occurredAt` → deterministic event ID, no marker store needed for correctness.
- [LOCAL] Delivery state stored with the log (same store as attempts); breaker state in the fast store, never the source of truth.
- [LOCAL] No MFA needed on webhook routes (secrets are shown once but only to `webhooks.manage` members) → S01/S02 `sensitive` not applied; revisit if the product wants it.

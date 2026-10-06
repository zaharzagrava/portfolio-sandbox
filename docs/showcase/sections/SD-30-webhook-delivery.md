# SD-30 — Webhook Delivery Platform (for shops' systems)

Status: ☑ done (typechecked; specs written, not run) · Phase 5 · Depends on: SD-07, F-02 (SQS), F-05, SD-03 (Lambda worker)

## Marketplace adaptation
Shops subscribe endpoints to events (`order.paid`, `order.cancelled`, `stock.low`, `payout.sent`). One shop's dead server must never delay others.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Kafka events → **router** (match subscriptions, cached) → **SQS FIFO**, `MessageGroupId = endpointId` (per-endpoint isolation + ordering), DLQ | 10/09 #30, D18 |
| Delivery worker as **Lambda handler** (local: `lambda-local` runner): HTTPS POST with 10 s timeout, signature, record attempt | 10/09 #30, 10/04 #3 |
| **Signing**: `HMAC-SHA256(secret, timestamp.body)` header `Marketplace-Signature: t=..,v1=..`; **two active secrets** during rotation; receivers reject old timestamps | 04/03 §5 |
| Retries with exponential backoff up to 3 days (SQS delay ≤ 15 min, longer via SD-29), circuit breaker per endpoint, auto-disable after N days failing + email | 06/03 |
| **SSRF protection**: resolve DNS, block private/link-local/metadata ranges, re-check at each delivery (DNS rebinding), HTTPS only, no redirects | 05/01 §6 |
| At-least-once + `event.id` for receiver dedupe; thin vs fat payload; pinned API version per endpoint (SD-07 transformers) | 04/02 §8 |
| Delivery log (DynamoDB `WebhookAttempts`, TTL 30 days) + manual replay endpoint | D24 |

## Steps
- [x] `WebhookEndpoint`, `WebhookSubscription` models (Postgres, shop-scoped), secret generation (encrypted at rest).
- [x] Router consumer → SQS FIFO; delivery handler (`apps/lambdas/src/handlers/webhook-delivery.ts`) + signer (shared with receiver-side verification helper → unit-tested) + SSRF guard (unit-tested: shared by SD-35 crawler).
- [x] Attempts table, replay endpoint, auto-disable job.
- [x] e2e: `order.paid` → POST to a local test server with valid signature; endpoint 500 → retry scheduled; endpoint resolving to 10.0.0.5 → blocked.

## Scale
- Target: 5k deliveries/s, 500k endpoints.
- Hot path: entirely async; router stateless; SQS FIFO high-throughput mode (per-group ordering); Lambda concurrency capped per account, per-endpoint concurrency = 1 via groups.
- First bottleneck: slow endpoints holding workers → 10 s timeout + circuit breaker skips open endpoints (requeue with delay).
- Proof: k6-driven event flood + a mock receiver with 10% slow endpoints → healthy endpoints' delivery p99 < 2 s.

## Implementation notes (2026-10-01)
- **Schema:** migration `20261001300000-webhooks` adds `WebhookEndpoint`, with secrets sealed by SecretBox (AES-256-GCM) and a previous secret valid for 24 h after rotation. DynamoDB `WebhookAttempts` holds exact bodies (for replay) and per-attempt logs, with a 30-day TTL.
- **`net/ssrf-guard.ts`** (shared with SD-35/36):
  - https only, no credentials, port allowlist.
  - Resolves DNS once and every address must be public (private, loopback, link-local/IMDS, CGNAT, ULA, v4-mapped, multicast are blocked).
  - Returns the address to pin.
  - Unit spec; checked at endpoint creation and again on every delivery.
- **`http-sender.ts`:** the POST is pinned to the validated IP (`lookup` override, TLS still verifies the hostname). No redirects, 10 s timeout, 1 KB response snippet.
- **`signature.ts`:** `Marketplace-Signature: t=..,v1=..[,v1=..]` (HMAC over `t.body`, one `v1` per active secret) plus the receiver-side `verifyWebhook` with a 5-minute tolerance. Unit spec.
- **`WebhookRouterProjector`** (projector):
  - Covers `order.paid` (per-shop slice), `order.cancelled` (shops via ShopOrder) and `product.stock_low` (≤ 5, once per product per day).
  - Each event goes to the shop's subscribed endpoints (cached) as a fat payload in each endpoint's pinned API version (SD-07 transformers).
  - Sent to SQS FIFO `webhook-deliveries.fifo` with `MessageGroupId = endpointId` and dedup id = hash(event, endpoint). Stable `evt_` ids let receivers dedupe.
- **`WebhookDeliverer`** (worker consumer AND Lambda handler `apps/lambdas/src/handlers/webhook-delivery.ts`, which reports `batchItemFailures`):
  - Checks enabled → per-endpoint Redis circuit breaker (opens after 5 consecutive failures, 1→30 min) → SSRF re-check → sign → POST → log.
  - Retries: 2 more passes inside the FIFO (ordering kept), then the SD-29 job lane at 5 m, 30 m, 2 h, 5 h, 10 h, then daily. This is needed because FIFO queues have no per-message delay, and moving out of the group stops a dead endpoint blocking it for days.
  - After 3 days failing it auto-disables and sends a new SD-17 `webhooks.endpoint_disabled` email (new `developers` category).
  - Manual replay sends the byte-identical stored body.
- **Dashboard:** `POST|GET /api/shops/:shopId/developers/webhooks`, `PATCH /:id` (re-enable clears failure state), `POST /:id/rotate-secret`, `DELETE /:id`, `GET /:id/attempts`, `POST /:id/events/:eventId/replay`, `POST /ping`.
- **Spec** `webhooks/webhooks.e2e-spec.ts` (real local receiver): verified signature + version-shaped slice; FIFO → job-lane retries; replay (another shop gets `skipped`); SSRF refusals; dual-secret rotation.

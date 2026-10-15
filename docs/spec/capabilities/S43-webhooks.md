---
id: S43
title: Webhook delivery to shops: endpoints, signing with dual secrets, routing, per-endpoint ordering, retries, circuit breaker, auto-disable, replay
kind: capability
status: draft
generated_at: 3903109f
depends_on: [S54, S01, S03, S05, S10, S42, S49, S50, S52, S53]
concepts: [outbox-task-queue, projection-and-replay, rate-limit-policy, job-scheduler-lease, idempotency-key, tenant-shop-rbac, problem-json-errors, transaction-runner]
models: []
scope:
  - packages/backend/libs/domains/developer-platform/**
  - packages/contracts/src/developer-platform/**
---
# S43 - Webhook delivery to shops

## Purpose
A shop registers HTTPS endpoints, picks the event types each one receives, and the marketplace pushes a signed JSON message to the endpoint when one of those things happens to that shop. One shop's dead server never delays another, every request can be verified by the receiver, delivery is at least once and observable, and the platform's servers are never turned against its own network. See {{concept:tenant-shop-rbac}} for who may manage endpoints, {{concept:outbox-task-queue}} for how events leave the domain and {{concept:problem-json-errors}} for the error shape.

## Entry points
- Dashboard routes under `/shops/:shopId/developers` create, list, read, update, enable, disable and delete endpoints, rotate and expire secrets, list attempts and event details, replay an event and ping one endpoint. [code: packages/backend/libs/domains/developer-platform/api/webhooks.controller.ts#WebhooksController]
- A catalogue route of the same controller lists the event types a shop can subscribe to. [code: packages/backend/libs/domains/developer-platform/domain/webhook-events.ts#WEBHOOK_EVENT_CATALOGUE]
- Consumers of `order.*`, `catalog.product_*`, `payout.*` and `tenancy.shop_deleted` route source events to endpoints. [proof: S43 AS-23, S43 AS-30] [code: packages/backend/libs/domains/developer-platform/infra/webhook-consumers.ts#WebhookOrdersConsumer]
- The FIFO queue `webhook-deliveries.fifo` and its dead-letter queue, consumed by the worker and by the Lambda handler. [proof: S43 AS-35, S43 AS-45] [code: packages/backend/libs/domains/developer-platform/infra/webhook-workers.ts#WebhookWorkers]
- Jobs `webhooks.retry`, `webhooks.disable-failing-endpoints` (single run, every 15 minutes) and `webhooks.purge-history` (single run, daily). [proof: S43 AS-57, S43 AS-67] [code: packages/backend/libs/domains/developer-platform/infra/webhook-workers.ts#WebhookWorkers]

## Rules
- **S43.R-01** An endpoint address MUST parse and be at most 2,048 characters. It MUST use `https`, port 443, no user-info and a host name that is not `localhost`. Otherwise it MUST be refused with a reason from a closed list. [proof: S43 AS-02, S43 AS-03] [code: packages/backend/libs/domains/developer-platform/domain/webhook-url.ts#parseEndpointUrl]
- **S43.R-02** Two endpoints of one shop MUST NOT have the same normalised address (lower-case host, no default port, no fragment). [proof: S43 AS-12] [code: packages/backend/libs/domains/developer-platform/domain/webhook-url.ts#normalizeEndpointUrl]
- **S43.R-03** Create and update MUST accept 1 to 20 distinct event types of the catalogue, a supported API version and no unknown property. [proof: S43 AS-02, S43 AS-07] [code: packages/contracts/src/developer-platform/webhooks.ts#createWebhookEndpointRequestSchema]
- **S43.R-04** Every address MUST resolve only to public addresses at save time and on enable, and an address that is refused MUST change nothing. [proof: S43 AS-03, S43 AS-08] [code: packages/backend/libs/domains/developer-platform/infra/safe-address.guard.ts#SafeAddressGuard]
- **S43.R-05** A shop MUST have at most 20 endpoints, enforced by the store and not by check-then-write. [proof: S43 AS-11] [code: packages/backend/libs/domains/developer-platform/infra/sequelize-webhook-endpoint.repository.ts#SequelizeWebhookEndpointRepository]
- **S43.R-06** An endpoint MUST be `enabled` or `disabled`. Only the transitions of the lifecycle table MUST be allowed, each as a conditional update with a history row. Every other pair MUST answer `409 endpoint_state_conflict`. [proof: S43 AS-08, S43 AS-09] [code: packages/backend/libs/domains/developer-platform/domain/endpoint-status.ts#transitionEndpoint]
- **S43.R-07** Every route MUST need `webhooks.manage`; an endpoint of another shop MUST answer exactly as an unknown id. [proof: S43 AS-13] [code: packages/backend/libs/domains/developer-platform/api/webhooks.controller.ts#WebhooksController]
- **S43.R-08** Every request MUST carry `Marketplace-Signature` with `t` and one `v1` per active secret. Each `v1` MUST be an HMAC-SHA256 over `t.body` of the exact bytes sent. The receiver verifier MUST follow the published rules. [proof: S43 AS-16, S43 AS-17] [code: packages/backend/libs/domains/developer-platform/domain/signature.ts#signWebhook]
- **S43.R-09** At most two secrets MUST be active, the previous one only before its expiry instant, chosen from the injected clock when signing. [proof: S43 AS-19] [code: packages/backend/libs/domains/developer-platform/domain/signature.ts#activeSecrets]
- **S43.R-10** Secrets MUST have 256 bits, be shown once, be sealed at rest bound to the endpoint, and never appear in any store, event, metric or log. [proof: S43 AS-01, S43 AS-22] [code: packages/backend/libs/domains/developer-platform/application/webhook-endpoints.service.ts#generateWebhookSecret]
- **S43.R-11** Rotation MUST be refused while a previous secret has not expired, and the previous secret MUST be endable early. [proof: S43 AS-20, S43 AS-21] [code: packages/backend/libs/domains/developer-platform/application/webhook-endpoints.service.ts#WebhookEndpointsService]
- **S43.R-12** The catalogue MUST be exactly the 11 event types. [proof: S43 AS-14] [code: packages/backend/libs/domains/developer-platform/domain/webhook-events.ts#WEBHOOK_EVENT_CATALOGUE]
- **S43.R-13** An order event MUST carry only the receiving shop's lines and subtotal in integer minor units, no buyer identity; cancel and refund events MUST carry no amount. [proof: S43 AS-23, S43 AS-26] [code: packages/backend/libs/domains/developer-platform/domain/webhook-event-mapper.ts#sliceOrderForShop]
- **S43.R-14** Product and payout events MUST be mapped from the event snapshot only, sandbox events MUST be dropped, and `product.stock_low` MUST follow the quantity rule once per product per UTC day. [proof: S43 AS-27, S43 AS-28, S43 AS-29] [code: packages/backend/libs/domains/developer-platform/domain/stock-low.ts#decideStockLow]
- **S43.R-15** A source event MUST be routed once per shop whatever the number of deliveries, and one that fails its schema MUST be dead-lettered without effect. The source event MUST be acknowledged only after the lane accepted every message of it. [proof: S43 AS-30, S43 AS-31, S43 AS-33] [code: packages/backend/libs/domains/developer-platform/application/webhook-routing.service.ts#WebhookRoutingService]
- **S43.R-16** Each endpoint MUST have its own ordered lane with one request in flight, and a hanging endpoint MUST NOT delay another. [proof: S43 AS-36, S43 AS-37] [code: packages/backend/libs/domains/developer-platform/infra/sqs-delivery.queue.ts#SqsDeliveryQueue]
- **S43.R-17** An attempt MUST end within 10 seconds, read at most 1 KiB of the answer and never follow a redirect; only `2xx` MUST be a success. [proof: S43 AS-38, S43 AS-39] [code: packages/backend/libs/domains/developer-platform/infra/safe-outbound-http.adapter.ts#SafeOutboundHttpAdapter]
- **S43.R-18** A failed delivery MUST be retried. Three attempts MUST run in the lane. Eight retries MUST follow after 5 min, 30 min, 2 h, 5 h, 10 h, 24 h, 24 h and 24 h, each with a 20 % jitter. No retry MUST come earlier than `Retry-After`, and the delivery MUST be `exhausted` after the eleventh attempt. A retry beyond the lane MUST be a job that puts the delivery back into its ordered lane. [proof: S43 AS-40, S43 AS-41] [code: packages/backend/libs/domains/developer-platform/domain/retry-schedule.ts#nextRetry]
- **S43.R-19** A delivery already `delivered` MUST NOT be sent again, and one attempt MUST be claimed atomically. An attempt in doubt after a crash MUST consume its number, and a disabled or deleted endpoint MUST cancel its queued deliveries at the next attempt. [proof: S43 AS-43, S43 AS-44, S43 AS-50] [code: packages/backend/libs/domains/developer-platform/application/webhook-delivery.service.ts#WebhookDeliveryService]
- **S43.R-20** The breaker MUST open after 5 consecutive failures for 1 minute, double up to 30 minutes, admit one probe and fail open when its store is down. While it is open a delivery MUST be given back and rescheduled for the close time with its attempt number unchanged. [proof: S43 AS-47, S43 AS-48, S43 AS-49] [code: packages/backend/libs/domains/developer-platform/domain/breaker.ts#decideBreaker]
- **S43.R-21** A body over 256 KiB MUST NOT be sent and MUST end `failed (payload_too_large)` without retry. [proof: S43 AS-53]
- **S43.R-22** An endpoint failing for three days MUST be disabled with one alert event holding the host only, by a failing attempt or by the sweep job. A success MUST clear the window, an enable MUST clear the window and the breaker, and the disable, its history row and its event MUST be one transaction, written once however many callers race for it. [proof: S43 AS-55, S43 AS-56, S43 AS-57, S43 AS-58, S43 AS-59] [code: packages/backend/libs/domains/developer-platform/application/webhook-lifecycle.service.ts#WebhookLifecycleService]
- **S43.R-23** A replay MUST re-send the stored bytes in one attempt without effect on health, need an idempotency key and answer `202`; a ping MUST go to one endpoint, even one that does not subscribe to it, and at most 10 a minute. A replay and a ping MUST be refused for a disabled endpoint, and a replay for an unknown or expired event. [proof: S43 AS-62, S43 AS-63, S43 AS-64, S43 AS-65] [code: packages/backend/libs/domains/developer-platform/application/webhook-replay.service.ts#WebhookReplayService]
- **S43.R-24** The attempt log and stored bodies MUST be kept 30 days and never be returned afterwards; endpoint history MUST be kept 400 days and then deleted by a scheduled job. The attempt log MUST be read newest first with a cursor that a new attempt does not disturb. [proof: S43 AS-60, S43 AS-61, S43 AS-67] [code: packages/backend/libs/domains/developer-platform/infra/dynamo-delivery-log.store.ts#DynamoDeliveryLogStore]
- **S43.R-25** A deleted shop MUST lose its endpoints, history and log items in batches of at most 1,000 rows, once. [proof: S43 AS-66] [code: packages/backend/libs/domains/developer-platform/application/webhook-lifecycle.service.ts#WebhookLifecycleService]
- **S43.R-26** Startup MUST fail when the private-host allowance is set in production, the retry schedule does not increase, the jitter is outside 0 to 0.5 or a timeout is not positive. [proof: S43 AS-71] [code: packages/backend/libs/domains/developer-platform/domain/webhook-settings.ts#validateWebhookSettings]
- **S43.R-28** Every attempt MUST resolve the address again and connect to the address it checked; an address that is not public MUST be logged as a failed attempt and retried. [proof: S43 AS-51, S43 AS-52]
- **S43.R-27** Every error MUST be a problem document with a stable code, and every success body MUST parse with its contract schema; an unexpected failure MUST answer a generic `500` with no stack, SQL or component text. [proof: S43 AS-69] [code: packages/backend/libs/domains/developer-platform/domain/webhook-errors.ts#WebhookError]
- **S43.R-29** Every attempt MUST count in `webhook_delivery_attempts_total{outcome}` and `webhook_delivery_duration_seconds` and leave one structured line with the correlation, delivery, endpoint, event, attempt, status and host, and nothing of the address path or query, a secret, a signature or a body. The lane age, the open-breaker count, the routing lag, the breaker degradation, the auto-disable and the dead letters (by lane) MUST be written too. [proof: S43 AS-68] [code: packages/backend/libs/domains/developer-platform/application/webhook-metrics.ts#webhookMetrics]

## Behaviors
- **S43.B-01** Given an owner, when they create an endpoint, then the response shows the secret once and a later read never does. [proof: S43 AS-01]
- **S43.B-02** Given an order paid in two shops, when it is routed, then each shop's endpoint gets only its own lines. [proof: S43 AS-23]
- **S43.B-03** Given a receiver that answers `500`, when the event is delivered, then it is attempted three times in the lane, retried on the schedule and ends `exhausted` after eleven attempts. [proof: S43 AS-40, S43 AS-41]
- **S43.B-04** Given a rotation with a 24 hour overlap, when a request is signed before the expiry instant, then it carries two signatures, and from that instant one. [proof: S43 AS-19]
- **S43.B-05** Given a hanging endpoint, when other endpoints receive events, then their delivery is not delayed. [proof: S43 AS-37]
- **S43.B-06** Given an endpoint failing for three days, when the window ends, then it is disabled and one event with the host is written. [proof: S43 AS-55]
- **S43.B-07** Given a delivered event, when an owner replays it twice with the same key, then one replay is sent, with the stored bytes, and the second answer says it is a repeat. [proof: S43 AS-62, S43 AS-63]
- **S43.B-08** Given an endpoint that is not subscribed to `webhook.ping`, when an owner pings it, then only that endpoint receives a signed ping, once. [proof: S43 AS-65]

## Lifecycles
- Endpoint status: `enabled` becomes `disabled` by a manual disable or by the failure window; `disabled` becomes `enabled` by enable, which clears the failure window and the breaker. Every other pair is a conflict.
- Delivery state: `queued`, `delivering`, then `delivered`, `retry_scheduled` (back to `delivering`), `exhausted`, `cancelled` or `failed`. Replays and pings never reach `retry_scheduled`.
- Breaker: `closed`, `open` for a duration that doubles from 1 to 30 minutes, `half-open` with one probe.

## Owns
- Tables `WebhookEndpoint`, `WebhookEndpointHistory` and `WebhookShopCounter`; no foreign key to another owner's table.
- DynamoDB table `WebhookAttempts` (30 day TTL).
- Queue `webhook-deliveries.fifo` and its dead-letter queue.
- Events `developerplatform.webhook_endpoint_disabled` and `developerplatform.webhook_endpoint_changed`.
- Policies `webhooks.manage.shop`, `webhooks.replay.shop` and `webhooks.ping.endpoint`.

## Decisions
- Delivery state lives with the attempt log so that recording an attempt and scheduling the next one is a single write.
- The routing receipt is the shared inbox, taken only after every endpoint message is accepted, and event ids are deterministic so a redelivery adds nothing.
- Every retry is a failure of the same schedule: a mis-deployed receiver is usually fixed inside three days.
- The breaker store is disposable: when it fails the delivery goes out as if the breaker were closed.
- The alert carries the host only, so a secret in a query string never leaves the delivery path.

## Known gaps
- Load goals (95 percent within 5 seconds, 5,000 deliveries per second across 500,000 endpoints, 10 percent slow receivers) have no automated proof; see `specs/UNVERIFIED.md`.
- The fallback for `order.cancelled` and `order.refunded` without `shopIds` reads order lines through the orders service until S10 ships the field.
- The `webhook_dead_lettered_total{lane: router}` counter sees only what the consumers themselves refuse (the framework dead-letters schema-invalid envelopes before a consumer runs and counts them as `dlq_total`); `webhook_endpoints_breaker_open` is a per-process view of the endpoints seen open.

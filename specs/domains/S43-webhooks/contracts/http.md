# Contract: dashboard HTTP API (S43)

Prefix `/api/shops/{shopId}/developers`. Every route: session auth (`401` anonymous), `ShopScoped('webhooks.manage')` (OWNER, ADMIN; STAFF/VIEWER `403 permission_denied`; non-member `404`; closed shops `403 shop_suspended` / `409 shop_offboarding` on writes). Errors are `application/problem+json` `{type, title, status, detail, instance, requestId, code}`. Schemas live in `packages/contracts/src/developer-platform/webhooks.ts`.

| Method and path | Request | Success | Errors (`code`) |
|---|---|---|---|
| `POST webhooks` | `{url, events[], apiVersion?}` | `201 {id, url, events, apiVersion, status, secret, createdAt}` | 400 `validation_failed`; 409 `duplicate_endpoint_url`; 422 `endpoint_url_rejected` (`details.reason`), `endpoint_limit_reached`; 429 `rate_limited`; 503 |
| `GET webhooks?limit&cursor` | limit 1–100 (25) | `200 {items: WebhookEndpointDto[], nextCursor}` | 400 `validation_failed`, `invalid_cursor` |
| `GET webhooks/:id` | uuid | `200 WebhookEndpointDto` | 400; 404 `webhook_endpoint_not_found` |
| `PATCH webhooks/:id` | `{url?, events?, apiVersion?}` (≥ 1 field, no `enabled`) | `200 WebhookEndpointDto` | 400; 404; 409 `duplicate_endpoint_url`; 422 `endpoint_url_rejected` |
| `POST webhooks/:id/enable`, `/disable` | none | `200 WebhookEndpointDto` | 404; 409 `endpoint_state_conflict` `{details.status}`; enable also 422 `endpoint_url_rejected` |
| `POST webhooks/:id/rotate-secret` | `{overlapHours?: int 1–72}` | `201 {secret, previousSecretExpiresAt}` | 400; 404; 409 `rotation_in_progress` |
| `POST webhooks/:id/expire-previous-secret` | none | `200 WebhookEndpointDto` | 404; 409 `no_previous_secret` |
| `DELETE webhooks/:id` | | `204` | 404 (also on the second delete) |
| `GET webhooks/:id/attempts?eventId&ok&limit&cursor` | | `200 {items: AttemptDto[], nextCursor}` | 400; 404 |
| `GET webhooks/:id/events/:eventId` | | `200 {eventId, type, createdAt, state, attempts, body}` | 404 `webhook_event_not_found` |
| `POST webhooks/:id/events/:eventId/replay` | header `Idempotency-Key` | `202 {deliveryId, eventId, endpointId, state: "queued"}` (`Idempotent-Replayed: true` on repeat) | 404 (endpoint or event); 409 `endpoint_disabled`, `idempotency_in_flight`; 422 `idempotency_key_required`, `idempotency_key_reuse`; 429 |
| `POST webhooks/:id/ping` | none | `202 {deliveryId, eventId, endpointId, state: "queued"}` | 404; 409 `endpoint_disabled`; 429 |
| `GET webhook-event-types` | | `200 {items: [{type, description, resource, since}]}` (11, fixed order) | |

`WebhookEndpointDto = {id, url, events, apiVersion, status: "enabled"|"disabled", disabledReason: "manual"|"auto_failing"|null, failingSince, breaker: "closed"|"open", hasPreviousSecret, previousSecretExpiresAt, createdAt, updatedAt}`. No secret field except the create and rotate responses.

`AttemptDto = {attemptId, deliveryId, eventId, type, attempt, startedAt, durationMs, status?, ok, error?, responseSnippet?, replay}`; `error` ∈ S54 vocabulary (`blocked_address | timeout | tls_error | network_error | redirect_refused | …`) or `payload_too_large`.

Cross-shop and unknown IDs give byte-identical `404` bodies (the `instance` and `requestId` aside).

## Rate-limit policies (S50 registry, `developer-platform`, all `failMode: 'closed'`)

| Policy | Limit | Key | Applies to |
|---|---|---|---|
| `webhooks.manage.shop` | 120 / min | shop | mutating routes except replay and ping |
| `webhooks.replay.shop` | 30 / min | shop | replay |
| `webhooks.ping.endpoint` | 10 / min | endpoint | ping |

Clients read the structured `RateLimit` and `RateLimit-Policy` headers and `Retry-After` on `429`/`503`; the legacy `X-RateLimit-*` and `RateLimit-Limit|Remaining|Reset` headers do not exist.

## Changes against today (all `[BREAKING]` lines of `questions.md`)

Permission `shop.manage|shop.read` → `webhooks.manage`; `PATCH {enabled}` → `POST enable|disable`; list and attempts paginated; replay async `202`; ping per endpoint; `204`→`404` on unknown delete; `400`→`422` for guard failures. Consumer W04 adopts the schemas.

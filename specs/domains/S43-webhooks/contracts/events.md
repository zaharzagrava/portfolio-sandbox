# Contract: events consumed and emitted (S43)

Envelope (S53): `{eventId, type, version, occurredAt, aggregateId, payload}`. Invalid payload or wrong `version` → `PermanentError` → DLQ with reason; no receipt, no delivery, no block of the stream.

## Consumed

| Consumer group | Topic (key) | Types | Rule |
|---|---|---|---|
| `webhook-router-orders` | `orders.events` (`orderId`) | `order.paid` (needs `shopOrders`, `lines[].shopId`), `order.cancelled` and `order.refunded` (need `shopIds`) | slice per shop from `shopOrders`; cancel/refund carry no amounts; fallback R1 for `shopIds` only until S10 ships (see plan, Complexity Tracking) |
| `webhook-router-products` | `products.events` (`productId`, compacted) | `catalog.product_created|updated|archived|restored|deleted` | map to `product.created|updated|archived|updated|deleted`; `isSandbox` dropped; low-stock rule on the snapshot (`quantity ≤ 5`, `changedFields ∋ quantity`, one per UTC day by `occurredAt`); `catalog.product_changed` ignored |
| `webhook-router-payouts` | `payouts.events` | `payout.paid`, `payout.failed` (`payoutVersion`) | other payout types ignored |
| `webhook-shop-deleted` | `tenancy.events` | `tenancy.shop_deleted {shopId}` | purge endpoints, history, log items in batches ≤ 1,000 per transaction; idempotent |

All consumers: receipt per source `eventId` (inbox), deterministic outbound `id` (`evt_` + digest of source event and shop), no read of another domain's table, no per-process subscription cache.

## Emitted (outbox, same transaction as the change)

| Type | Version | Payload | Consumers |
|---|---|---|---|
| `developerplatform.webhook_endpoint_disabled` (spec name `developer_platform.webhook_endpoint_disabled`; the S53 pattern allows no `_` in the first segment, see gaps.md) | 1 | `{endpointId, shopId, host, failingSince}` | S28 |
| `developerplatform.webhook_endpoint_changed` (spec name `developer_platform.webhook_endpoint_changed`, same pattern limit) | 1 | `{endpointId, shopId, change: created|url_changed|events_changed|api_version_changed|enabled|disabled|secret_rotated|previous_secret_expired|deleted, actorId?}` | audit (optional), S28 (optional) |

Neither contains a secret, a URL, a path or a query. Topic `developer_platform.events`, aggregate id = endpoint id, retention `full-history`.

## Ownership registry rows to add (`packages/backend/db/ownership.ts`)

`WebhookEndpointHistory`, `WebhookShopCounter` → `domain:developer-platform`; `WebhookAttempts` (log store) → `domain:developer-platform`; receipts use the inbox (`infrastructure:inbox`).

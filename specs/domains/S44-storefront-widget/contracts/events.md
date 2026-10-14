# Contract: events, consumers, rate limits, configuration

## Produced

`developerplatform.widget_site_changed` v1 (the published name follows the S42 naming; spec.md writes it `developer_platform.…`), envelope `{eventId, type, version: 1, occurredAt, aggregateId}` (`aggregateId = siteId`), payload `{siteId, shopId, change, actorId?}`, `change ∈ created | origins_changed | products_changed | theme_changed | secret_rotated | previous_secret_expired | kill_switch_on | kill_switch_off | deleted`. Written with `outbox.append` in the same `TransactionRunner.run` as the change; none on a no-op; never a secret, key or origin list. Schema in `packages/contracts/src/developer-platform/widget.ts` (and `events.ts` registration). Optional consumers: audit, S28 (no required consumer).

## Consumed (module `WidgetProjectorModule`, deployed through `apps/projector`)

| Topic event | Payload (zod-validated) | Effect | Idempotency |
|---|---|---|---|
| `tenancy.shop_updated` v1 | `{shopId, name, slug, shopVersion}` | version-guarded update of `shopName`/`shopVersion` | version guard + inbox by event id |
| `tenancy.shop_status_changed` v1 | `{shopId, from, to, reason?, shopVersion}` | version-guarded update of `shopStatus`/`shopVersion`; invalidate site cache | same |
| `tenancy.shop_deleted` v1 | `{shopId}` | delete the shop's sites and history, one `deleted` event per site, invalidate caches | deleting nothing the second time |

Invalid payloads: `PermanentError` → DLQ, no effect (AS-45).

## Rate-limit policies (added to `developerPlatformRatePolicies`)

| Name | Limit | Key | Fail mode |
|---|---|---|---|
| `widget.config.ip` | 600/min | ip | open |
| `widget.identify.ip` | 30/min | ip | closed |
| `widget.identify.site` | 1,200/min | publishable key | closed |
| `widget.manage.shop` | 60/min | shop | closed |

## Configuration (validated at boot)

| Key | Rule |
|---|---|
| `widget_token_key` | required, ≥ 32 bytes; startup fails without it |
| `WIDGET_APP_BUNDLE_URL` | default `/widget/v1/app.js`; absolute values must be HTTPS |
| `WIDGET_CHECKOUT_URL` (config's `checkoutUrl`) | HTTPS |
| limits and TTLs | 10 sites, 10 origins, 12 products, 300 s hand-off, 900 s token, 60 s fresh / 600 s stale config, 30 s unknown-key memory, overlap default 24 h max 72 h (configuration, not contract) |

## Metrics and logs (AS-52)

Counters by outcome and reason label for config, identify, session, embed, kill switch, consumer results, single-use fallbacks. Logs carry site ID and reason only: no secret, token, key plaintext of the identity secret or customer e-mail.

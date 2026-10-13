# Contract: S36 events and streams

## Domain events (outbox → `marketing.events`)

Envelope (platform `defineEvent`): `{eventId, type, version: 1, occurredAt, aggregateId, aggregateVersion, payload}`; appended in the same transaction as the change (`OutboxService.append`). Schemas in `packages/contracts/src/marketing/ads.ts`; definitions in `application/events/ads-events.ts`; the barrel exports the definitions.

| Type | Key (`aggregateId`) | `aggregateVersion` | Payload |
|---|---|---|---|
| `marketing.campaign_created` | `campaignId` | `campaignVersion` (1) | `{campaignId, shopId, productId, category, cpcMinor, dailyBudgetMinor, status, statusReason, campaignVersion}` |
| `marketing.campaign_paused` | `campaignId` | `campaignVersion` | same |
| `marketing.campaign_resumed` | `campaignId` | `campaignVersion` | same |
| `marketing.campaign_ended` | `campaignId` | `campaignVersion` | same |
| `marketing.product_sponsorship_changed` | `productId` | `sponsorshipVersion` | `{productId, shopId, sponsored, sponsorshipVersion}` |

`product_sponsorship_changed` is published **only when the sponsored value changes** (create → `true` v1, pause → `false`, resume → `true`, end from `ACTIVE` → `false`; end from `PAUSED` publishes nothing); `sponsorshipVersion` strictly increases per product. S32 consumes it (its follow-up: until it is published no product is sponsored). Other consumers: none required.

## Consumed events (R3)

| Topic | Events | Consumer | Idempotency | Effect |
|---|---|---|---|---|
| `products.events` | `catalog.product_created\|updated\|archived\|restored\|deleted` | `ads-product-snapshot` (`AdsProjectorModule`) | `versionGuard` on `productVersion` | upsert `AdProductSnapshot`; archive → pause campaign (`product_unavailable`); restore → none (stays paused); delete → end campaign; stock/price/title → snapshot only |
| `tenancy.events` | `tenancy.shop_status_changed`, `tenancy.shop_offboarding_started`, `tenancy.shop_deleted` | `ads-shop-snapshot` | `versionGuard` on `shopVersion` | upsert `AdShopSnapshot`; deleted → end all the shop's campaigns (billing records stay) |

Invalid payloads are dead-lettered by the S53 framework (`dlq_total{consumer}`) and never block the consumer; a duplicate or older version has no effect.

## Click stream

`ads.clicks` — key `campaignId#<0..9>` (salt = `murmur3(click_id) mod 10`), value `adClickRecordSchema` (snake_case, as ClickHouse consumes it):

```json
{"click_id":"<impression uuid>","campaign_id":"<uuid>","shop_id":"<uuid>","product_id":"<uuid>",
 "received_at":"2026-10-13 10:15:30.123","ip_hash":"<32 hex>","viewer_hash":"<32 hex>",
 "valid":1,"invalid_reason":null}
```
`valid ∈ {0,1}`; `invalid_reason ∈ ip_burst | repeat_clicker | filter_unavailable | null` (`null` iff `valid = 1`); `received_at` is server time, UTC, millisecond precision. The producer is idempotent. Consumers: the aggregator (`ads-click-aggregator`) and the raw-log writer (`ads-click-log-writer`); no other capability may consume it.

`ads.click-aggregates` — written only in the aggregator's Kafka transaction (stable `transactionalId`), key `campaignId`, value `{campaign_id, minute, source_partition, first_offset, clicks, invalid}`; read only `read_committed` by `ads-aggregate-writer` (ClickHouse `ad_click_minute_v2`, dedupe token `<topic>:<partition>:<first>:<last>`).

`ads.clicks.dlq` — poison messages with header `reason` (`invalid_json`, `schema`, `valid_out_of_range`, `received_at_future`, `received_at_stale`), written in the aggregator's transaction.

## Ledger contract used (S14)

`LedgerService.postJournal({kind, reference, currency: 'EUR', lines}, tx)` and `getBalances({accountIds, currency}, tx?)`, `shopAccount(shopId)`, `LEDGER_ACCOUNTS.PLATFORM_FEES` from `@app/domains/payments`. `AD_CHARGE` reference `ad:<campaignId>:<YYYY-MM-DDTHH>`; `ADJUSTMENT` reference `ad-adj:<campaignId>:<YYYY-MM-DDTHH>:<sequence>` (S14's example `campaignId:hour` is refined: adjustments need a sequence). A charge: shop line `−amount`, `PLATFORM_FEES` `+amount`; an adjustment with `delta` inverts the sign for a refund. No insufficient-balance error exists for these kinds (the account may go negative). The posting transaction contains only ledger writes.

# Event contract: S11 — Flash sales

Outbox rows through `OutboxService.append` inside the transition's transaction (IX.6), topic `orders.events` (existing), key `saleId`, `defineEvent` in `application/events/flash-sale-events.ts`, payload schemas in `packages/contracts/src/orders/flash-sale-events.ts` (`flashSaleEventSchemas`). Envelope: `{ eventId, type, version: 1, occurredAt, aggregateId: saleId }`. `eventId` is deterministic per `(type, saleId)` (`flash_sale.oversold`: `+ sequence`), so a second delivery of a job appends nothing (the transition's conditional update affects 0 rows, so the append is never reached).

| Type | Emitted when | Payload |
|---|---|---|
| `flash_sale.loaded` | `SCHEDULED → LOADED` | `{ saleId, shopId, productId, units, buckets, startsAt, endsAt }` |
| `flash_sale.ended` | `LOADED → ENDED` | `{ saleId, shopId, productId }` |
| `flash_sale.reconciled` | `ENDED → RECONCILED` | `{ saleId, shopId, productId, units, unitsSold, unitsReturned, driftUnits }` |
| `flash_sale.cancelled` | `SCHEDULED|LOADED → CANCELLED` | `{ saleId, shopId, productId }` |
| `flash_sale.start_failed` | `SCHEDULED → START_FAILED` | `{ saleId, shopId, productId, reason }` |
| `flash_sale.sold_out` | first time all buckets read 0 (R-08) | `{ saleId, shopId, productId }` |
| `flash_sale.oversold` | verification found `reservedDurable > units` | `{ saleId, shopId, productId, excessUnits, cancelledOrderIds, unresolvedPaidUnits }` |

Consumers: none required (S28, S40, S36, J01 may subscribe). A refused outbox append aborts the transaction, so the status is unchanged and the job retries (AS-37). `flash_sale.sold_out` is written in its own transaction after the response; if that append fails the marker key is deleted so the next check retries.

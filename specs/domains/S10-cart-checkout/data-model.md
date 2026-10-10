# Data model: S10 — domain `orders`

Owner of every table below: `domain:orders` (`db/ownership.ts`). Amounts are integer minor units (`BIGINT` in the database, JS `number` with a safe-integer check at the repository edge). User, product, shop and payment identifiers are plain `UUID`/`TEXT` columns without foreign keys to other owners (IX.4). Migrations are expand → backfill → contract (III.11), each with `SET lock_timeout`, index creation `CONCURRENTLY` (so those migrations run with `transaction: false`).

## Relational tables

### `BisOrder` (aggregate root)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK (`uuidv7()`) | |
| `userId` | TEXT today → plain id, no FK, no `User` association | type change to `UUID` is a contract step (later release); history index keeps working on `TEXT` |
| `status` | TEXT, **new `CHECK`** in `PENDING, RESERVED, PAID, FULFILLING, SHIPPED, DELIVERED, CANCELLED, REFUNDED` | added `NOT VALID`, then `VALIDATE CONSTRAINT` |
| `total` | BIGINT | API/events call it `totalMinor`; column name stays (contract-only rename in the API) |
| `currency` | TEXT | no `EUR` default in code |
| `reservedUntil` | TIMESTAMPTZ NULL | set by the `PENDING → RESERVED` move |
| `version` | INTEGER NOT NULL DEFAULT 1 | +1 per move (`orderVersion` in events) |
| `idempotencyKey` | TEXT NULL | unique with `userId` (exists) |
| **`requestHash`** | TEXT NULL | new; SHA-256 of the canonical body; `NULL` for legacy orders |
| `cancelReason` | TEXT NULL | `out_of_stock | payment_failed | hold_expired | user_cancelled` |
| **`paymentRef`** | TEXT NULL | new; set by `markPaid` (for `order.paid` and the refund command) |
| `createdAt`, `updatedAt` | TIMESTAMPTZ | |

Indexes: unique `(userId, idempotencyKey)` (exists); history `(userId, createdAt DESC, id DESC) INCLUDE (status, total, currency) WHERE NOT (status = 'CANCELLED' AND "cancelReason" = 'out_of_stock')` replaces the current one (AS-59/60); partial `(reservedUntil) WHERE status = 'RESERVED'` for the sweeper; partial `(createdAt) WHERE status = 'PENDING'` for recovery.

Associations: **none** to `User`, `Payment`, `Product`. `BisOrder.hasMany(BisOrderItem)` and `hasMany(ShopOrder)` stay (same owner); the lazy `require` accessors and the `BisOrderItem ↔ BisOrder` mutual arrows are removed (D-17): items point to the order one way.

State machine (`domain/order-state.ts`, discriminated union + `assertNever`):

```
PENDING --reserve--> RESERVED --markPaid--> PAID --startFulfilment--> FULFILLING --ship--> SHIPPED --deliver--> DELIVERED
PENDING --cancel(out_of_stock)--> CANCELLED
RESERVED --cancel(payment_failed | hold_expired | user_cancelled)--> CANCELLED
PAID | FULFILLING --refund--> REFUNDED
terminal: CANCELLED, REFUNDED, DELIVERED
idempotent ("already applied"): markPaid on PAID+, cancel on CANCELLED, refund on REFUNDED
```

Every move: `UPDATE "BisOrder" SET status = :to, version = version + 1, … WHERE id = :id AND status = :from` asserting one row, one `OrderEvent` row, one outbox row, shop-order propagation, reservation propagation — one `TransactionRunner.run`.

### `BisOrderItem`

Existing columns (`priceAtPurchase` is the unit price, API `unitPriceMinor`; `flashSaleId` stays for S11) plus (expand): **`title`** TEXT (NULL until backfill, then `NOT NULL` contract step), **`discountMinor`** BIGINT NOT NULL DEFAULT 0, **`lineTotalMinor`** BIGINT (NULL until backfill = `priceAtPurchase × quantity`, then `NOT NULL`). `shopId` becomes `NOT NULL` after the report-only backfill (rows with `NULL` are reported, not guessed). `productId` plain UUID, **association and FK to `Product` dropped** (contract step drops the FK if present). Invariant checked in domain and by `CHECK (lineTotalMinor >= 0)`.

### `ShopOrder`

`shopId` `NOT NULL` (after backfill), `subtotal` (API: `subtotalMinor`), `status` in `PENDING | PAID | CANCELLED | REFUNDED` (`CHECK`), unique `(bisOrderId, shopId)`. Index for the seller list `(shopId, createdAt DESC, id DESC)`.

### `OrderEvent` (history, append-only)

Existing `fromStatus, toStatus, reason, createdAt` plus **`actor`** TEXT (`user:<id> | system:expiry | system:webhook | system:consumer | system:fulfilment:<service>`; `NULL` for legacy rows) and `amountMinor` BIGINT NULL (`partial_refund` rows). Index `(orderId, createdAt, id)` for the timeline.

### `StockReservation`

Columns: `bisOrderId`, `productId`, `quantity`, `status` (**new values `REQUESTED`, `RELEASE_PENDING`**, existing `HELD | CONVERTED | RELEASED`; `CHECK`), `expiresAt`, new **`source`** TEXT NOT NULL DEFAULT `'CATALOG'`, new **`sourceRef`** TEXT NULL (flash-sale id for S11), new **`releaseAttempts`** INTEGER DEFAULT 0, **`nextReleaseAt`** TIMESTAMPTZ NULL. Unique `(bisOrderId, productId)`. Partial index `(nextReleaseAt) WHERE status = 'RELEASE_PENDING'` for the release job.

Reservation lifecycle: `REQUESTED → HELD → CONVERTED` (paid) or `HELD → RELEASE_PENDING → RELEASED` (cancel); `REQUESTED → RELEASED` when the catalog rejected (nothing was held).

### `FlashSale` (S11 takes over)

Unchanged here; its model stays registered in `FlashSaleLegacyModule`, not in `OrdersModule`'s checkout path.

### Webhook inbox rows

Not an `orders` table: `ProcessedWebhookEvent` is owned by `infrastructure:idempotency`/inbox; reached only through `InboxService` (`claim`, `markStatus`, `purge`). The per-event processing context (type, orderId, amount, currency, paymentRef) lives in the `orders.process-webhook` job payload (≤ 2 KiB), not in a new table.

## Non-relational stores

| Store | Key | Content |
|---|---|---|
| DynamoDB `Carts` | `PK = CART#<id>`, `SK = ITEM#<productId>` | `productId, quantity, addedAt, expiresAt` (epoch seconds, also the TTL attribute) |
| DynamoDB `Carts` | `PK = CART#<id>`, `SK = META` | `lineCount` (conditional cap 50); no TTL logic beyond the lines' |
| Redis | `orders:checkout-lock:<userId>` | token, `PX` 15000 |
| Idempotency table (S54) | per principal + key | stored `202`/final problem, 24 h |

`<id>` is `user:<userId>` or `guest:<uuid>`; no route accepts it.

## Expand / backfill / contract

| Step | Migration / job | Content |
|---|---|---|
| Expand 1 | `…-orders-s10-expand-columns.js` | items `title, discountMinor, lineTotalMinor`; orders `requestHash, paymentRef`; history `actor, amountMinor`; reservations `source, sourceRef, releaseAttempts, nextReleaseAt`; status `CHECK … NOT VALID`; |
| Expand 2 | `…-orders-s10-expand-indexes.js` (`transaction: false`) | `CREATE INDEX CONCURRENTLY` for the six indexes above; unique `(bisOrderId, shopId)` on `ShopOrder` and `(bisOrderId, productId)` on `StockReservation` created `CONCURRENTLY` then attached as constraints |
| Validate | `…-orders-s10-validate.js` | `VALIDATE CONSTRAINT` of the `CHECK`s |
| Backfill | job `orders.backfill-item-titles` (resumable, batches of 200, `getProductsByIds`, `"(removed product)"` when gone, `lineTotalMinor = priceAtPurchase × quantity`; reports rows with `shopId IS NULL` in a gauge `orders_backfill_orphans`), retired when the gauge is 0 and no `title IS NULL` remains | |
| Contract (later release) | `…-orders-s10-contract.js` | `NOT NULL` on `title, lineTotalMinor, ShopOrder.shopId, BisOrderItem.shopId`; drop FKs `BisOrderItem.productId → Product`, `BisOrder.userId → User` if present. **Not part of this change's deploy**; listed so the registry/readme carry the order. |

`db/ownership.ts` needs no new table entry (no new table); the check script is re-run to prove the 12 findings fall to the S12 remainder.

## Zod schemas (packages/contracts/src/orders)

`cartSchema`, `setCartLineRequestSchema`, `checkoutRequestSchema` (`{expectedTotalMinor?: int ≥ 0}`, `.strict()`), `checkoutResponseSchema`, `orderSchema`, `orderListItemSchema`, `orderPageSchema`, `shopOrderPageSchema`, `webhookAckSchema`, `orderEventSchemas` (five payloads), `refundRequestedSchema`, `paymentEventSchemas` (three payloads of S13). See `contracts/`.

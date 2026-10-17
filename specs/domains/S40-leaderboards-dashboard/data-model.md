# Data model: S40

## Postgres (owner `seller-insights`; register all three in `packages/backend/db/ownership.ts`)

| Table | Columns | Notes |
|---|---|---|
| `SellerInsightsShop` | `shopId uuid PK`, `name text`, `slug text`, `shopVersion int`, `updatedAt` | version-guarded upsert (`WHERE excluded.shopVersion > shopVersion`); deleted on `tenancy.shop_deleted` |
| `SellerInsightsProduct` | `productId uuid PK`, `shopId uuid`, `category text`, `productVersion int`, `updatedAt` | same guard; `product_deleted` bumps version only; index on `shopId` for erasure |
| `LeaderboardSnapshot` (exists) | + `shopName text NULL`, `participants int NOT NULL`; unique `(periodKind, periodId, category, rank)` | category `''` = overall; top 100; rows deleted and renumbered on shop deletion |

Migration: expand only (add columns nullable, backfill `participants` from `COUNT(*)` per board, then set NOT NULL), `lock_timeout` set, no `Shop` join.

## Redis (all keys carry TTL = period end + 35 d; live keys short)

| Key | Type | Content |
|---|---|---|
| `lb:{period}:all`, `lb:{period}:cat:{category}` | zset | member shopId, score = ranking key (R-1) |
| `lb:rev:{period}`, `lb:last:{period}` | hash | per board field `board|shopId` → revenue / latest slot |
| `lb:applied:{period}` | set | applied order ids |
| `lb:sealed:{period}` | string | frozen marker |
| `live:{shop}:{second}` | hash | `checkouts, orders, units, revenue`, TTL 180 s |
| `live:seen:{eventId}:{kind}` | string | applied mark, written with the increments |
| `live:lease:{shop}` | string | ticker holder, TTL 3 s |

Category normalisation: lowercase, trim, 1–64 chars, no control characters, otherwise the line counts on the overall board only and logs `category_invalid`.

## ClickHouse

`shop_sale_facts(shop_id, order_id, product_id, title, buyer_id, units, line_total_minor, paid_at DateTime64, ingested_at)` ReplacingMergeTree(ingested_at) ORDER BY `(shop_id, order_id, product_id)`, partition by month of `paid_at`.

`shop_refund_facts(shop_id, order_id, amount_minor, refunded_at, ingested_at)` ReplacingMergeTree ORDER BY `(shop_id, order_id)`.

Drops: `seller_sales`, the `shop_sales` minute view. Buyer id is stored but never returned.

## State transitions

Period: open → closed (end passed) → frozen (snapshot stored, sealed). Frozen is terminal. Read-model rows: absent → vN → vN+1 (never down) → deleted by shop erasure.

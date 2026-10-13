# Data Model: S19 — Pickup near me

Owner of every table below: `domain:fulfilment` (`db/ownership.ts`). No foreign key leaves the pickup tables (AS-44). Ids are UUID (uuidv7 default).

## PickupPoint (exists; expand)

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| shopId | UUID NOT NULL | plain ID, FK to `Shop` dropped in the contract migration |
| name | TEXT NOT NULL | trimmed, 1–120 |
| address | TEXT NOT NULL | trimmed, 1–300 |
| location | geography(Point,4326) NOT NULL | immutable; GiST index exists |
| openingHours | JSONB NOT NULL DEFAULT '{}' | validated shape (FR-002) |
| active | BOOLEAN NOT NULL DEFAULT TRUE | |
| **version** | INTEGER NOT NULL DEFAULT 1 | new; +1 per effective change; becomes `pointVersion` |
| createdAt, updatedAt | TIMESTAMPTZ | clock-supplied |

Indexes: GiST on `location` (exists); new `("shopId","createdAt","id")` for the seller keyset list (replaces `PickupPoint_shop_idx`).
Transitions: `active` true ↔ false by `PATCH`; setting the current value is a no-op (no version, no event). Location and `shopId` never change.

## PickupStock (exists; expand)

| Column | Type | Notes |
|---|---|---|
| pickupPointId | UUID | PK part; FK to `PickupPoint` stays (same owner) |
| productId | UUID | PK part; FK to `Product` dropped (contract migration) |
| quantity | INTEGER NOT NULL | `CHECK (quantity >= 0)` exists; add `CHECK (quantity <= 1000000)` |
| version | INTEGER NOT NULL DEFAULT 1 | +1 per quantity change; becomes `stockVersion` |
| updatedAt | TIMESTAMPTZ | |

Index: `("productId") WHERE quantity > 0` exists. Rules: `stock-rules.ts` (set: absolute, no-op when equal, `expectedVersion` compare; adjust: `quantity + delta` within `0…1 000 000`).

## PickupProductCopy (new)

| Column | Type | Notes |
|---|---|---|
| productId | UUID PK | |
| shopId | UUID NOT NULL | |
| title, category | TEXT NOT NULL | |
| priceMinor | BIGINT NOT NULL | integer minor units |
| currency | CHAR(3) NOT NULL | |
| status | TEXT NOT NULL | `ACTIVE` \| `ARCHIVED` |
| isSandbox | BOOLEAN NOT NULL | |
| version | BIGINT NOT NULL | the catalog's `productVersion`; upsert only when greater (version guard) |
| updatedAt | TIMESTAMPTZ | |

Built from `catalog.product_*` and seeded at stock write from `getProductsByIds`; never written back; row removed on `catalog.product_deleted` / tombstone. Index `("shopId")`.

## PickupShopCopy (new)

| Column | Type | Notes |
|---|---|---|
| shopId | UUID PK | |
| status | TEXT NOT NULL | S03's status values, plus `DELETED` after `shop_deleted` |
| version | BIGINT NOT NULL | `shopVersion`; upsert only when greater |
| updatedAt | TIMESTAMPTZ | |

Built from `tenancy.shop_created|shop_status_changed|shop_deleted`.

## Idempotency record (not a pickup table)

Adjustment keys live in the S54 `IdempotencyKey` table (owner `infrastructure:idempotency`): key, request fingerprint, stored status/body, 24 h expiry.

## Availability document (Elasticsearch `pickup_availability`, one per (point, product))

`_id = "<pickupPointId>:<productId>"`. Fields: `productId`, `pickupPointId`, `shopId` (keyword); `title` (text, english analyzer, plus `title.raw` keyword for stable tie ordering), `category` (keyword); `priceMinor` (long), `currency` (keyword); `pointName`, `pointAddress` (keyword, not analysed, only returned); `quantity` (integer); `location` (geo_point); `pointActive`, `isSandbox` (boolean); `productStatus`, `shopStatus` (keyword); `stockVersion`, `pointVersion`, `productVersion`, `shopVersion` (long); `docVersion` (external version = their sum). Documents exist only while `isOfferVisible` is true (invisible → versioned delete), so every read path filters on `quantity > 0` and trusts presence. Settings: `refresh_interval: 2s`, `index.gc_deletes: 1h`.

## State and invariants

- Offer visible ⇔ `stock.quantity > 0 ∧ point.active ∧ shopCopy.status = ACTIVE ∧ productCopy.status ≠ ARCHIVED ∧ ¬productCopy.isSandbox` (pure function, FR-023).
- Consumers are idempotent by version guard: the copy tables by `version`, the index by external `docVersion`; the stock/point consumers write nothing to Postgres.
- Product deletion: copy row and all stock rows of the product removed; one `pickup.stock_changed {quantity: 0}` per removed row with `stockVersion = last + 1`.
- Shop deletion: every active point gets `active = false`, `version + 1`, one `pickup.point_changed`; stock kept.

## Events (outbox → `pickup.events`, key = aggregate id)

- `pickup.stock_changed` v1, aggregate `<pointId>:<productId>`: `{pickupPointId, productId, shopId, quantity, stockVersion, lat, lng}`; `carries: 'state'`.
- `pickup.point_changed` v1, aggregate `pointId`: `{pickupPointId, shopId, name, address, lat, lng, active, pointVersion}`; `carries: 'state'`.
Envelope version is `1`; the row version never goes into the envelope (A18).

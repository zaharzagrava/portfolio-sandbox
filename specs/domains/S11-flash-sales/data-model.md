# Data model: S11 — Flash sales (domain `orders`)

Owner of every table below: `orders` (same owner as S10). Pure rules live in `domain/`; SQL only in `infra/` repositories. Decisions behind each choice: [`research.md`](research.md).

## 1. PostgreSQL

### `FlashSale` (existing table, reshaped by expand/contract)

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK `uuidv7()` | |
| `shopId` | uuid NOT NULL (was NULL) | from the path at creation; backfill from `Product.shopId` is **not** done in SQL (D-12): legacy rows with `NULL` shop are moved to `CANCELLED(cancelled_by_shop)` in the migration when `SCHEDULED`, left as is when terminal |
| `productId` | uuid NOT NULL | plain id, no association |
| `priceMinor` | bigint NOT NULL CHECK `> 0` | expand: new column, copied from `price`; contract: `price` dropped |
| `units` | int NOT NULL CHECK `1..1_000_000` | |
| `buckets` | int NOT NULL default 16 CHECK `1..256` | |
| `perUserLimit` | int NOT NULL default 2 CHECK `1..20 AND <= units` | |
| `admissionRatePerSecond` | int NOT NULL default 2000 CHECK `1..10000` | new |
| `currency` | text NOT NULL (3 letters) | product currency at scheduling; new |
| `startsAt`, `endsAt` | timestamptz NOT NULL | CHECK `endsAt > startsAt AND endsAt - startsAt <= interval '24 hours'` |
| `status` | text NOT NULL default `SCHEDULED` | CHECK in `SCHEDULED, LOADED, ENDED, RECONCILED, CANCELLED, START_FAILED` (expand step allows the old set too; `LIVE` rows rewritten to `LOADED`) |
| `statusReason` | text NULL | CHECK in `insufficient_stock, window_missed, cancelled_by_shop, product_unavailable` or NULL (`product_unavailable` is added to the spec's three values: S05's `applyStockDelta` answers `unavailable` for an archived product at load, and `insufficient_stock` would be a wrong reason) |
| `version` | int NOT NULL default 0 | `+1` on each transition |
| `endedAt`, `reconciledAt` | timestamptz NULL | informational |
| `createdAt`, `updatedAt` | timestamptz | |

Indexes and constraints:

- `FlashSale_no_overlap` — `EXCLUDE USING gist ("productId" WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&) WHERE ("status" IN ('SCHEDULED','LOADED','ENDED'))` (needs `btree_gist`; exists since `20261001320000-experiments.js`). Created `NOT VALID`-free after the data check in the migration (overlapping legacy rows are cancelled first, see Migration).
- `FlashSale_shop_page_idx` — `("shopId", "startsAt" DESC, "id" DESC)` for the keyset list.
- `FlashSale_loaded_idx` — partial `("endsAt") WHERE status = 'LOADED'` for the directory loader and the verifier fan-out.
- `FlashSale_product_window_idx` — `("productId", "startsAt")` (kept).

### `FlashSaleHistory` (new, append-only)

`id uuid PK uuidv7()`, `saleId uuid NOT NULL`, `fromStatus text NULL`, `toStatus text NOT NULL`, `reason text NULL`, `actor text NOT NULL` (`system:job`, `user:<id>`), `at timestamptz NOT NULL`. Index `("saleId", "at")`. No update, no delete. Written in the transition's transaction.

### `StockReservation` (existing, S10-owned shape; S11's use)

Flash rows: `source = 'FLASH'`, `status` starts `HELD` (claim exists before the order), `sourceRef = claimId` (text), `flashSaleId` (uuid), `bucket` (legacy column, left NULL for new rows — the draws live in the claim; dropped in S10's contract migration, not here), `expiresAt = reservedUntil` of the order, `releaseAttempts`, `nextReleaseAt` as for catalog rows. Added by S11:

- `StockReservation_flash_sale_idx` — partial `("flashSaleId", "status") WHERE "source" = 'FLASH'` (sums per sale for verify/reconcile/stats).
- `StockReservation_flash_claim_uq` — unique `("sourceRef") WHERE "source" = 'FLASH'` (one durable row per claim; a replayed commit cannot create a second).
- CHECK `("source" <> 'FLASH' OR ("flashSaleId" IS NOT NULL AND "sourceRef" IS NOT NULL))`.
- The `source` CHECK already allows `FLASH`; `bucket` stays nullable.

### Migration (expand/contract, one release because the only reader of the old shape — the legacy route/jobs — is deleted in the same change)

1. `…-flash-sales-expand.js`: add columns (`priceMinor`, `admissionRatePerSecond`, `currency`, `statusReason`, `version`, `endedAt`, `reconciledAt`), copy `price → priceMinor`, backfill `currency` from `Product` through a one-off migration query (the migration is the only code allowed to read `Product` for this; it is a data fix, flagged with the ownership check's allow-comment convention used by other migrations), widen the status CHECK to old ∪ new, `UPDATE status = 'LOADED' WHERE status = 'LIVE'`, cancel legacy `SCHEDULED` rows without shop or overlapping another non-terminal sale of the same product (reason `cancelled_by_shop`, history row `system:migration`), create `FlashSaleHistory`, the three indexes, the claim unique index and the CHECK on `StockReservation`; then add the exclusion constraint.
2. `…-flash-sales-contract.js`: drop `price`, tighten the status CHECK to the new set only, set `shopId NOT NULL`.
   Run order: step 1, deploy code, step 2 in the same release train once `SELECT count(*) FROM jobs WHERE type = 'flash-sale.start'` is 0 (a check in the quickstart).
3. Down migrations are provided for step 1 only (step 2 is forward-only: the column `price` is recreated from `priceMinor` in its `down`).

## 2. Fast store (Redis) — key space `flash:`

All keys carry a TTL = `(endsAt − now) + 15 min + 1 h` × jitter `1 ± 0.1`, set at creation. Hash tags make each family live on its own slot; no script touches two families.

| Key | Type | Content | Written by |
|---|---|---|---|
| `flash:{<saleId>:<b>}:stock` | string (int) | units left in bucket `b` | load (`SET NX`), draw (`DECRBY` guarded), return (`INCRBY`), clamp (`DECRBY` guarded) |
| `flash:{<saleId>:<b>}:draws` | hash | `claimId → units taken from bucket b` | written in the same script as the draw; `HDEL` in the return script |
| `flash:{<saleId>:claim:<claimId>}` | hash | `state` (`CLAIMED`/`COMMITTED`/`SOLD`/`RETURNING`/`RETURNED`), `buyer`, `qty`, `buckets` (planned list), `createdAtMs`, `unitPriceMinor` | claim/commit/convert/release scripts |
| `flash:{<saleId>:quota:<buyerId>}` | hash | `total`, `<claimId> → qty` | quota script |
| `flash:{<saleId>:adm}` | hash | `tokens`, `updatedAtMs`, `stopped` (`1` after oversell) | admission script, verifier |
| `flash:{<saleId>:state}:sold-out-emitted` | string | `1` | `SET NX` |
| `flash:{<saleId>:claims}` | sorted set | `claimId` scored by `createdAtMs + claim window` for non-terminal claims | claim script adds, `COMMITTED`/`RETURNED` removes |
| `flash:{<saleId>:buyers}` | set | buyer ids (to delete the quota keys at reconcile) | quota script |

Claim state machine (pure in `domain/flash-claim-state.ts`, spec Key Entities): `CLAIMED → COMMITTED` (commit after the order transaction), `COMMITTED → SOLD` (convert), `CLAIMED|COMMITTED → RETURNING → RETURNED` (release). Everything else is an idempotent no-op or `not_held`: release of `SOLD` → `not_held`; convert of `RETURNING|RETURNED` → `not_held`; convert of `SOLD` → `already_converted`; release of `RETURNED` → `already_released`.

Sweeper query: `ZRANGEBYSCORE flash:{<saleId>:claims} -inf <now>` (≤ 200 per run) for every `LOADED` or `ENDED` sale; for each claim still `CLAIMED`: look up the durable row `StockReservation WHERE source = 'FLASH' AND sourceRef = :claimId`; found → `commit` it (keep the units out, FR-024); not found → release. `RETURNING` claims are resumed regardless of age.

## 3. Pure domain types (`domain/`)

| File | Contents |
|---|---|
| `flash-bucket-plan.ts` | `splitUnits(units, buckets): number[]` (sum = units, parts differ ≤ 1, larger parts first); `planDraw(contents: number[], q, startBucket): { kind: 'ok', draws: Array<{bucket, take}> } \| { kind: 'insufficient', available }` (all-or-nothing, never negative/more than available; the start bucket changes order only) |
| `flash-sale-state.ts` | `FlashSaleStatus`, `FlashCommand`, `transition(status, command, now, sale)`, `isOpen(sale, now)`, `publicState(sale, now, remaining)` |
| `flash-admission.ts` | `allowance({ rate, burst, tokens, elapsedMs }): { tokens: number }`, `admit(...)`, `retryAfterSeconds(random)` |
| `flash-drift.ts` | `classify(...)` and `clampPlan(contents, target)` |
| `flash-claim-state.ts` | claim state machine and `ReleaseMode = 'return' \| 'discard'` |
| `flash-errors.ts` | `FlashSaleBusyError` (429), `FlashSaleUnavailableError` (503), `FlashSaleLimitExceededError` (422), `FlashSaleNotFoundError` (404), `FlashSaleOverlapError` (409), `FlashSaleNotCancellableError` (409), each with a stable `code` and `retryAfterSeconds` where the spec says |
| `flash-ports.ts` | `FLASH_SALE_REPOSITORY`, `FLASH_FAST_STORE`, `FLASH_SALE_DIRECTORY`, `FLASH_RESERVATION` tokens and interfaces (D-6) |

## 4. Relations and ownership

`FlashSale.productId`, `.shopId` and `StockReservation.flashSaleId` are plain ids (no Sequelize association to `Product`/`Shop`). `FlashSale` ↔ `FlashSaleHistory` by `saleId`. Sale ↔ reservation by `flashSaleId` and `sourceRef`. Nothing here reads a foreign table.

## 5. State transitions (FR-007)

```
SCHEDULED ──load──▶ LOADED ──end──▶ ENDED ──reconcile──▶ RECONCILED
    │  ╲                │
    │   ╲─fail──▶ START_FAILED   (terminal)
    └─cancel─▶ CANCELLED ◀─cancel (only before startsAt)
```

Every other pair is illegal: `409 flash_sale_not_cancellable` on the cancel route, a logged no-op in jobs. `end` on `SCHEDULED` is `fail(window_missed)`.

# Service contract and ports: S11 — Flash sales (domain `orders`)

## Exported from `@app/domains/orders`

Nothing new. S11 **removes** `FlashSaleModel` and `FlashStockService` (TRANSITIONAL block of S10's `index.ts`, pinned by `orders-boundary.e2e-spec.ts`, which loses those two names) and `FlashSaleLegacyModule` from `OrdersModule.exports`. `OrdersModule` and `OrdersWorkerModule` are the only modules the apps import (X.4). `FlashReservationPort` is a *type* used inside the domain only (not exported).

## Ports (`domain/flash-ports.ts`, D-6)

```ts
interface FlashSaleRepository {            // adapters: infra/flash-sale.repository.ts
  create(sale: NewFlashSale): Promise<FlashSaleRecord>;                  // maps 23P01 to FlashSaleOverlapError
  find(saleId: string): Promise<FlashSaleRecord | null>;
  findForShop(shopId: string, saleId: string): Promise<FlashSaleRecord | null>;   // shop in the predicate (III.4)
  pageForShop(shopId, { status?, limit, after }): Promise<FlashSaleRecord[]>;
  loadedAndLive(now: Date): Promise<FlashSaleRecord[]>;                  // directory loader
  currentOrNextForProducts(productIds: string[], now: Date): Promise<FlashSaleRecord[]>;
  move(saleId, from, to, patch: { reason?: StatusReason }, actor: string, now: Date): Promise<FlashSaleRecord | null>;  // conditional update + history row
  reservationSums(saleId: string): Promise<{ held: number; converted: number; heldRows: number; releasePendingRows: number }>;
  newestUnpaidOrdersBeyond(saleId: string, keepUnits: number): Promise<Array<{ orderId: string; units: number }>>;
  reservationByClaim(claimId: string): Promise<{ orderId: string; status: ReservationStatus } | null>;
}

interface FlashFastStore {                 // adapter: infra/flash-fast-store.redis.ts (Lua in infra/flash-scripts.ts)
  fillBuckets(sale: StoreSale, parts: number[]): Promise<void>;                       // SET NX, never overwrites
  admit(sale: StoreSale, nowMs: number): Promise<{ admitted: boolean }>;
  claim(sale: StoreSale, claim: ClaimRequest): Promise<ClaimResult>;                  // quota + draws + claim record; gives back on shortage
  commit(saleId: string, claimId: string): Promise<'committed' | 'already_committed' | 'not_held'>;
  release(saleId: string, claimId: string, mode: 'return' | 'discard'): Promise<'released' | 'already_released' | 'not_held'>;
  convert(saleId: string, claimId: string): Promise<'converted' | 'already_converted' | 'not_held'>;
  remaining(saleId: string, buckets: number): Promise<number[]>;
  clamp(saleId: string, buckets: number, target: number): Promise<number>;            // lowers, never raises
  stopSelling(saleId: string): Promise<void>;
  expiredClaims(saleId: string, nowMs: number, limit: number): Promise<string[]>;
  dropSale(saleId: string, buckets: number): Promise<void>;
  markSoldOut(saleId: string): Promise<boolean>;                                      // SET NX
}

interface FlashSaleDirectory {             // adapter: infra/flash-sale.directory.ts (S52 getOrLoad)
  openSalesFor(productIds: string[], now: Date): Promise<Map<string, OpenSale>>;      // window evaluated here with `now`
}
```

Every `FlashFastStore` call is wrapped by the adapter in `withTimeout(…, orders_flash_call_timeout_ms)` and maps a timeout/connection error to `FlashSaleUnavailableError`; none retries inside a buyer request. A claim script that returns `out_of_stock`/`limit_exceeded`/`stopped` is a value, not an error.

## `FlashReservationPort` (the BEFORE_ORDER seam used by S10's `CheckoutService`)

```ts
interface FlashReservationPort {
  /** Sales open for these products at `now` (cached directory; no Redis). */
  openSales(productIds: string[], now: Date): Promise<Map<string, OpenSale>>;
  /** Per-buyer limit then sale admission, per distinct sale; throws FlashSaleBusyError | RateLimitedError | FlashSaleUnavailableError. */
  admit(buyerId: string, sales: OpenSale[]): Promise<void>;
  /** All-or-nothing across the drop lines of one checkout; on any refusal everything taken is given back. */
  reserve(buyerId: string, key: string, lines: FlashLine[]): Promise<FlashReserveResult>;
  /** Marks the claims committed after the order transaction; returns false for a claim already returned. */
  commit(holds: FlashHold[]): Promise<void>;
  release(holds: FlashHold[]): Promise<void>;     // idempotent; used for pre-commit failure and the margin rule
  /** For reservation rows (post-order): idempotent per row. */
  releaseReservation(row: FlashReservationRow): Promise<'released' | 'already_released' | 'not_held'>;
  convertReservation(row: FlashReservationRow): Promise<'converted' | 'already_converted' | 'not_held'>;
}
type FlashReserveResult =
  | { kind: 'held'; holds: Array<{ productId; quantity; unitPriceMinor; sourceRef: string; flashSaleId: string }> }
  | { kind: 'rejected'; productId: string; code: 'out_of_stock' | 'limit_exceeded'; flashSaleId: string; limit?: number };
```

`claimId` is deterministic: `uuidv5(<saleId>|<buyerId>|<Idempotency-Key>|<productId>, FLASH_NS)` so a replay of the same checkout re-finds its claim instead of taking a second one (AS-05).

### How S10 calls it (the five edits)

1. `CheckoutService.run` — after reading cart lines and products, `openSales(productIds, now)`; if none, the path is **unchanged**. Otherwise: `admit` (before the catalog/shop reads for those lines is the spec rule; in code it runs first thing after the cart read, as cart read is the cheapest and no catalog work has happened), then the catalog/shop validation of the *regular* lines and of the drop products (existence/status still checked through the catalog read the checkout already does), `reserve`, then `priceCart` with drop lines priced at the hold's `unitPriceMinor` and **excluded from the discount port**; the `expectedTotalMinor` check; if less than `orders_flash_order_margin_seconds` of the 60 s claim window remains → `release` and `CheckoutUnavailableError`; Tx 1 `createPending` with flash rows inserted `HELD` (`source`, `sourceRef`, `flashSaleId`) and no catalog operation for them; `commit(holds)`; the catalog step for the remaining lines (`OrderReservationService`, only `REQUESTED` `CATALOG` rows); any failure after `reserve` calls `release(holds)` once (compensation is the release procedure; a failure of the release itself leaves the claim to the sweeper).
2. `OrderReservationService` — `stockLines` reads only `REQUESTED` rows of source `CATALOG`; an order with no catalog lines goes `PENDING → RESERVED` without a source call.
3. `ReservationReleaseService` — splits `RELEASE_PENDING` rows by source: `CATALOG` rows as today; `FLASH` rows one by one through `releaseReservation` (`released | already_released` → `markReleased`; `not_held` → `markReleased` too, nothing to return; store down → `scheduleRetry`, the same backoff), so AS-30–AS-32 reuse S10's retry job and gauge.
4. `OrderLifecycleService` convert (line 226) — after the transaction that moves the order to `PAID` and rows `HELD → CONVERTED`, call `convertReservation` for each flash row (post-commit, outside the transaction); `not_held` is logged and counted; the order's late-payment rule (S10) is unchanged — S10 already refunds a payment for a cancelled order.
5. `ReservationRepository` — `forOrder` returns `source`, `sourceRef`, `flashSaleId`; `createPending` accepts rows with `source`/`status`; new `sumsForSale`, `byClaim`, `newestUnpaidBeyond`.

## Application services (`application/`, one per use case)

| Service | Responsibility |
|---|---|
| `FlashSaleService` | create, list, read, cancel; calls `ProductQueryService.getProductsByIds([id], { shopId })`; creates the sale and enqueues `load`/`end` in one `runner.run` |
| `FlashLifecycleService` | `load`, `end`, `reconcile`, `verify`, `sweepClaims`, `checkSoldOut`; transitions with history and outbox in one transaction; stock only through `ProductStockService.applyStockDelta` |
| `FlashReservationSource` | implements `FlashReservationPort` |
| `FlashPublicService` | public view and batch (S52 `getOrLoad`) |
| `FlashSaleJobs` (`infra/` job handlers, in `OrdersWorkerModule`) | thin: parse payload (zod), call one lifecycle method |

## Jobs (S49)

| Type | Payload contract | When | Attempts |
|---|---|---|---|
| `flash-sale.load` | `{ saleId: uuid }` | `runAt = startsAt − 60 s`, enqueued with the sale | 8, backoff + full jitter |
| `flash-sale.end` | `{ saleId }` | `runAt = endsAt` | 5 |
| `flash-sale.reconcile` | `{ saleId }` | `runAt = endsAt + 15 min + 60 s`, enqueued by `end`; reschedules itself every 60 s while holds exist | 20 |
| `flash-sale.verify` | `{}` | schedule `*/30 s`, single-run | — |
| `flash-sale.sweep-claims` | `{}` | schedule `*/10 s`, single-run | — |
| `flash-sale.start` | `{ saleId }` | alias to `load` for one release (drain) | — |

A malformed payload or unknown `saleId` throws `NonRetryableJobError` (dead letter, no side effect). `JobsService.cancel` is used to cancel the `load`/`end` jobs of a cancelled sale; callers adapt to its discriminated result; `InvalidScheduleError` is caught explicitly when registering the schedules.

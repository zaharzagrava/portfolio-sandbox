import type { ReservationStatus } from './ports';
import type { ReleaseMode } from './flash-claim-state';
import type { FlashSaleStatus, StatusReason } from './flash-sale-state';

/**
 * Ports of the flash-sale feature (S11 contracts/services.md, D-6): `application/` depends on these interfaces and
 * the pure rules of `domain/`; adapters live in `infra/`.
 */

// ---------------------------------------------------------------- records

/** Fields of a sale chosen by the seller; `id`, status and version are set by the repository. */
export interface NewFlashSale {
  id?: string;
  shopId: string;
  productId: string;
  priceMinor: number;
  currency: string;
  units: number;
  buckets: number;
  perUserLimit: number;
  admissionRatePerSecond: number;
  startsAt: Date;
  endsAt: Date;
}

export interface FlashSaleRecord {
  id: string;
  shopId: string;
  productId: string;
  priceMinor: number;
  currency: string;
  units: number;
  buckets: number;
  perUserLimit: number;
  admissionRatePerSecond: number;
  startsAt: Date;
  endsAt: Date;
  status: FlashSaleStatus;
  statusReason: StatusReason | null;
  version: number;
  endedAt: Date | null;
  reconciledAt: Date | null;
  createdAt: Date;
}

/** What the fast store needs to know about a sale (no relational data). */
export interface StoreSale {
  saleId: string;
  buckets: number;
  units: number;
  perUserLimit: number;
  admissionRatePerSecond: number;
  startsAt: Date;
  endsAt: Date;
}

/** A sale that is open to buyers right now, as the directory answers it. */
export interface OpenSale extends StoreSale {
  shopId: string;
  productId: string;
  priceMinor: number;
  currency: string;
}

export interface ClaimRequest {
  claimId: string;
  buyerId: string;
  quantity: number;
  unitPriceMinor: number;
  /** Bucket to try first; changes the order of draws only. */
  startBucket: number;
  nowMs: number;
  /** Claim window; the sweeper looks at the claim after `nowMs + claimWindowMs`. */
  claimWindowMs: number;
}

export type ClaimResult =
  | {
      kind: 'held';
      draws: Array<{ bucket: number; take: number }>;
      /** The buckets looked (nearly) empty after this draw: the caller checks for "sold out". */
      lastUnits: boolean;
    }
  | { kind: 'already_claimed'; draws: Array<{ bucket: number; take: number }> }
  | { kind: 'out_of_stock' }
  | { kind: 'limit_exceeded'; limit: number }
  | { kind: 'stopped' };

/** One drop line of a checkout. */
export interface FlashLine {
  sale: OpenSale;
  productId: string;
  quantity: number;
}

/** A claim taken for one line, to be committed or released. */
export interface FlashHold {
  saleId: string;
  claimId: string;
  productId: string;
  quantity: number;
  unitPriceMinor: number;
}

/** A durable flash reservation row (`StockReservation` with `source = 'FLASH'`). */
export interface FlashReservationRow {
  id: string;
  orderId: string;
  productId: string;
  quantity: number;
  status: ReservationStatus;
  /** The claim id. */
  sourceRef: string;
  flashSaleId: string;
}

export type FlashReserveResult =
  | {
      kind: 'held';
      holds: Array<{
        productId: string;
        quantity: number;
        unitPriceMinor: number;
        sourceRef: string;
        flashSaleId: string;
      }>;
    }
  | {
      kind: 'rejected';
      productId: string;
      code: 'out_of_stock' | 'limit_exceeded';
      flashSaleId: string;
      limit?: number;
    };

export interface ReservationSums {
  held: number;
  converted: number;
  heldRows: number;
  releasePendingRows: number;
}

// ---------------------------------------------------------------- ports

export interface FlashSaleRepository {
  /** Maps SQLSTATE 23P01 to `FlashSaleOverlapError`. */
  create(sale: NewFlashSale): Promise<FlashSaleRecord>;
  find(saleId: string): Promise<FlashSaleRecord | null>;
  /** The shop is in the predicate (III.4): another shop's sale is `null`. */
  findForShop(shopId: string, saleId: string): Promise<FlashSaleRecord | null>;
  pageForShop(
    shopId: string,
    query: {
      status?: FlashSaleStatus;
      limit: number;
      after: { startsAt: Date; id: string } | null;
    },
  ): Promise<FlashSaleRecord[]>;
  /** Directory loader. */
  loadedAndLive(now: Date): Promise<FlashSaleRecord[]>;
  currentOrNextForProducts(
    productIds: string[],
    now: Date,
  ): Promise<FlashSaleRecord[]>;
  /** Conditional update (`WHERE status = from`) plus a history row; `null` when the sale was not in `from`. */
  move(
    saleId: string,
    from: FlashSaleStatus,
    to: FlashSaleStatus,
    patch: { reason?: StatusReason },
    actor: string,
    now: Date,
  ): Promise<FlashSaleRecord | null>;
  reservationSums(saleId: string): Promise<ReservationSums>;
  /** Newest unpaid (`HELD`) flash orders whose units bring the sale back to `keepUnits`, with their claim ids. */
  newestUnpaidOrdersBeyond(
    saleId: string,
    keepUnits: number,
  ): Promise<Array<{ orderId: string; units: number; claimId: string }>>;
  /** Whether the sale ever reached `LOADED` (a sale cancelled before loading never took stock). */
  everLoaded(saleId: string): Promise<boolean>;
  reservationByClaim(
    claimId: string,
  ): Promise<{ orderId: string; status: ReservationStatus } | null>;
}

export interface FlashFastStore {
  /** `SET NX`, never overwrites. */
  fillBuckets(sale: StoreSale, parts: number[]): Promise<void>;
  admit(sale: StoreSale, nowMs: number): Promise<{ admitted: boolean }>;
  /** Quota + draws + claim record; gives back on shortage. */
  claim(sale: StoreSale, claim: ClaimRequest): Promise<ClaimResult>;
  commit(
    saleId: string,
    claimId: string,
  ): Promise<'committed' | 'already_committed' | 'not_held'>;
  release(
    saleId: string,
    claimId: string,
    mode: ReleaseMode,
  ): Promise<'released' | 'already_released' | 'not_held'>;
  convert(
    saleId: string,
    claimId: string,
  ): Promise<'converted' | 'already_converted' | 'not_held'>;
  remaining(saleId: string, buckets: number): Promise<number[]>;
  /** Lowers, never raises; returns the new total. */
  clamp(saleId: string, buckets: number, target: number): Promise<number>;
  /** `true` the first time (the sale was selling), `false` when it was already stopped. */
  stopSelling(saleId: string): Promise<boolean>;
  expiredClaims(
    saleId: string,
    nowMs: number,
    limit: number,
  ): Promise<string[]>;
  dropSale(saleId: string, buckets: number): Promise<void>;
  /** `SET NX`: true the first time. */
  markSoldOut(saleId: string): Promise<boolean>;
  /** Removes the marker again when the event could not be appended, so the next check retries (R-08). */
  clearSoldOut(saleId: string): Promise<void>;
}

export interface FlashSaleDirectory {
  /** The window is evaluated here with `now`. Keyed by product id. */
  openSalesFor(productIds: string[], now: Date): Promise<Map<string, OpenSale>>;
  /** Whether any sale is open at `now` (the cached list, no statement while warm). */
  anyOpen(now: Date): Promise<boolean>;
  /** Forgets the cached list; called after a sale changes state so the next read is current (best effort). */
  refresh(): Promise<void>;
}

/** The BEFORE_ORDER seam used by S10's `CheckoutService`; a type used inside the domain only. */
export interface FlashReservationPort {
  openSales(productIds: string[], now: Date): Promise<Map<string, OpenSale>>;
  /** Whether any drop is open right now; checkout then leaves the idempotency lookup to the order write (no early read). */
  anyOpen(now: Date): Promise<boolean>;
  /** Per-buyer limit then sale admission, per distinct sale; throws FlashSaleBusyError | RateLimitedError | FlashSaleUnavailableError. */
  admit(buyerId: string, sales: OpenSale[]): Promise<void>;
  /** All-or-nothing across the drop lines of one checkout; on any refusal everything taken is given back. */
  reserve(
    buyerId: string,
    key: string,
    lines: FlashLine[],
  ): Promise<FlashReserveResult>;
  /** Marks the claims committed after the order transaction; `false` when a claim was already returned (not held). */
  commit(holds: FlashHold[]): Promise<boolean>;
  /** Idempotent; used for pre-commit failure and the order-write margin rule. */
  release(holds: FlashHold[]): Promise<void>;
  releaseReservation(
    row: FlashReservationRow,
  ): Promise<'released' | 'already_released' | 'not_held'>;
  convertReservation(
    row: FlashReservationRow,
  ): Promise<'converted' | 'already_converted' | 'not_held'>;
}

/** Random numbers in [0, 1) for the start bucket and `Retry-After`; the test kit seeds it. */
export type FlashRandom = () => number;

/**
 * A named step boundary inside multi-step flows (claim → order, load, reconcile). Production binds a no-op; the test
 * kit binds a double that throws at a chosen name to prove the flow survives a crash there (S11 test-plan, Gate 9).
 */
export interface CrashPoint {
  hit(name: string): void | Promise<void>;
}

/**
 * What a crash point throws: the process "died" here, so no compensation may run (a real crash runs no `catch`). Code
 * that compensates on failure rethrows this one untouched; the claim sweeper and recovery jobs are what the specs prove.
 */
export class SimulatedCrash extends Error {
  constructor(point: string) {
    super(`crash at ${point}`);
    this.name = 'SimulatedCrash';
  }
}

export const FLASH_RANDOM = Symbol('FLASH_RANDOM');
export const FLASH_CRASH_POINT = Symbol('FLASH_CRASH_POINT');
export const FLASH_SALE_REPOSITORY = Symbol('FLASH_SALE_REPOSITORY');
export const FLASH_FAST_STORE = Symbol('FLASH_FAST_STORE');
export const FLASH_SALE_DIRECTORY = Symbol('FLASH_SALE_DIRECTORY');
export const FLASH_RESERVATION = Symbol('FLASH_RESERVATION');

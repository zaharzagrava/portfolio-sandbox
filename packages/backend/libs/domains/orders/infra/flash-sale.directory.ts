import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CacheService, cacheKey } from '@app/infrastructure/cache';
import {
  FLASH_SALE_REPOSITORY,
  type FlashSaleDirectory,
  type FlashSaleRepository,
  type OpenSale,
} from '../domain/flash-ports';
import { isOpen } from '../domain/flash-sale-state';
import { flashReservationsCounter } from '../domain/order-metrics';
import { CLOCK, type Clock } from '@app/common/core/clock';

const KEY = cacheKey('flash-directory', 1, 'loaded');
/** Fresh for 2 s; a stale answer is served while one caller refreshes (S52 single-flight + stale-while-revalidate). */
const TTL_MS = 2_000;

/** What the cache stores for a loaded sale: ISO dates, validated when read back (A9). */
const entrySchema = z.object({
  saleId: z.string().uuid(),
  shopId: z.string().uuid(),
  productId: z.string().uuid(),
  priceMinor: z.number().int().positive(),
  currency: z.string().length(3),
  units: z.number().int().positive(),
  buckets: z.number().int().positive(),
  perUserLimit: z.number().int().positive(),
  admissionRatePerSecond: z.number().int().positive(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});
type Entry = z.infer<typeof entrySchema>;

/**
 * The sales that are loaded (a few rows), cached for 2 s through `CacheService.getOrLoad`; the sale window is
 * evaluated here with the caller's `now`, never by the cache (research R-02). A drop attempt therefore costs no
 * relational statement while the cache is warm.
 */
@Injectable()
export class CachedFlashSaleDirectory implements FlashSaleDirectory {
  constructor(
    @Inject(FLASH_SALE_REPOSITORY) private readonly sales: FlashSaleRepository,
    private readonly cache: CacheService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async loaded(): Promise<Entry[]> {
    const raw = await this.cache.getOrLoad<Entry[]>(
      KEY,
      async () => {
        const rows = await this.sales.loadedAndLive(this.clock.now());
        return rows.map((r) => ({
          saleId: r.id,
          shopId: r.shopId,
          productId: r.productId,
          priceMinor: r.priceMinor,
          currency: r.currency,
          units: r.units,
          buckets: r.buckets,
          perUserLimit: r.perUserLimit,
          admissionRatePerSecond: r.admissionRatePerSecond,
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt.toISOString(),
        }));
      },
      { ttlMs: TTL_MS, swrMs: TTL_MS, jitter: 0.1, l1: 'never' },
    );
    return z.array(entrySchema).parse(raw ?? []);
  }

  async openSalesFor(
    productIds: string[],
    now: Date,
  ): Promise<Map<string, OpenSale>> {
    const wanted = new Set(productIds);
    const out = new Map<string, OpenSale>();
    if (wanted.size === 0) return out;
    for (const e of await this.loaded()) {
      if (!wanted.has(e.productId)) continue;
      const sale = {
        ...e,
        startsAt: new Date(e.startsAt),
        endsAt: new Date(e.endsAt),
      };
      if (isOpen({ ...sale, status: 'LOADED' }, now))
        out.set(e.productId, sale);
      // a loaded sale of a product in the cart that is outside its window: the buyer pays the regular price
      else flashReservationsCounter.add(1, { result: 'not_open' });
    }
    return out;
  }

  async anyOpen(now: Date): Promise<boolean> {
    return (await this.loaded()).some((e) =>
      isOpen(
        {
          startsAt: new Date(e.startsAt),
          endsAt: new Date(e.endsAt),
          status: 'LOADED',
        },
        now,
      ),
    );
  }

  /** Test-kit seam and lifecycle hook: forget the cached list so the next read sees the current sales. */
  async refresh(): Promise<void> {
    await this.cache.invalidate([KEY]);
  }
}

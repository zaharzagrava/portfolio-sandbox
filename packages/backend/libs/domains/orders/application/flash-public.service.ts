import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { FlashSalePublic } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { CacheService, cacheKey } from '@app/infrastructure/cache';
import {
  FlashSaleNotFoundError,
  FlashSaleUnavailableError,
} from '../domain/flash-errors';
import {
  FLASH_FAST_STORE,
  FLASH_SALE_REPOSITORY,
  type FlashFastStore,
  type FlashSaleRecord,
  type FlashSaleRepository,
} from '../domain/flash-ports';
import { FLASH_SALE_STATUSES, publicState } from '../domain/flash-sale-state';

/** What the cache holds for a sale: the public fields and one reading of the buckets, nothing else. */
const snapshotSchema = z.object({
  saleId: z.string().uuid(),
  productId: z.string().uuid(),
  priceMinor: z.number().int().positive(),
  currency: z.string().length(3),
  perUserLimit: z.number().int().positive(),
  units: z.number().int().positive(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  status: z.enum(FLASH_SALE_STATUSES),
  /** Units counted in the buckets when loaded; `null` when the sale has no buckets, `'error'` when the store failed. */
  remaining: z.union([z.number().int(), z.null(), z.literal('error')]),
});
type Snapshot = z.infer<typeof snapshotSchema>;

const saleKey = (saleId: string) => cacheKey('flash-public', 1, 'sale', saleId);
const productKey = (productId: string) =>
  cacheKey('flash-public', 1, 'product', productId);

/**
 * The anonymous view of a sale (S11 FR-030…FR-032, R-08): the sale and one reading of its buckets are cached for about
 * a second through `CacheService.getOrLoad` (jitter, single-flight, stale-while-revalidate), so a stampede of pollers
 * costs one bucket read and one statement per second. The state is computed per request from the injected clock.
 * When the store fails the answer degrades to `remainingApprox: null, degraded: true` instead of an error.
 */
@Injectable()
export class FlashPublicService {
  private readonly logger = new Logger(FlashPublicService.name);

  constructor(
    @Inject(FLASH_SALE_REPOSITORY) private readonly sales: FlashSaleRepository,
    @Inject(FLASH_FAST_STORE) private readonly store: FlashFastStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly cache: CacheService,
    private readonly config: ApiConfigService,
  ) {}

  private options() {
    const ttlMs = this.config.get('orders_flash_public_cache_ms');
    return {
      ttlMs,
      swrMs: ttlMs,
      negativeTtlMs: ttlMs,
      jitter: 0.1,
      l1: 'never' as const,
    };
  }

  private async snapshot(sale: FlashSaleRecord): Promise<Snapshot> {
    let remaining: Snapshot['remaining'] = null;
    if (sale.status === 'LOADED') {
      try {
        const contents = await this.store.remaining(sale.id, sale.buckets);
        remaining = contents.reduce((s, c) => s + Math.max(0, c), 0);
      } catch (error) {
        if (!(error instanceof FlashSaleUnavailableError))
          this.logger.warn(`bucket read failed: ${(error as Error).name}`);
        remaining = 'error';
      }
    }
    return {
      saleId: sale.id,
      productId: sale.productId,
      priceMinor: sale.priceMinor,
      currency: sale.currency,
      perUserLimit: sale.perUserLimit,
      units: sale.units,
      startsAt: sale.startsAt.toISOString(),
      endsAt: sale.endsAt.toISOString(),
      status: sale.status,
      remaining,
    };
  }

  async get(saleId: string): Promise<FlashSalePublic> {
    const raw = await this.cache.getOrLoad<Snapshot>(
      saleKey(saleId),
      async () => {
        const sale = await this.sales.find(saleId);
        return sale ? this.snapshot(sale) : null;
      },
      this.options(),
    );
    const view = raw ? this.view(snapshotSchema.parse(raw)) : null;
    if (!view) throw new FlashSaleNotFoundError();
    return view;
  }

  /** At most one view per product: the sale running or loaded, else the next one within 24 h. */
  async byProducts(productIds: string[]): Promise<FlashSalePublic[]> {
    const unique = [...new Set(productIds)];
    const results = await this.cache.getOrLoadMany<Snapshot>(
      unique.map(productKey),
      async (missing) => {
        const ids = missing.map(
          (k) => unique.find((id) => productKey(id) === k) as string,
        );
        const found = await this.sales.currentOrNextForProducts(
          ids,
          this.clock.now(),
        );
        const byProduct = new Map(found.map((s) => [s.productId, s]));
        const out = new Map<string, Snapshot | null>();
        for (const id of ids) {
          const sale = byProduct.get(id);
          out.set(productKey(id), sale ? await this.snapshot(sale) : null);
        }
        return out;
      },
      this.options(),
    );
    return results
      .map((raw) => (raw ? this.view(snapshotSchema.parse(raw)) : null))
      .filter((v): v is FlashSalePublic => v !== null);
  }

  private view(s: Snapshot): FlashSalePublic | null {
    const now = this.clock.now();
    const window = {
      startsAt: new Date(s.startsAt),
      endsAt: new Date(s.endsAt),
      status: s.status,
    };
    const state = publicState(
      window,
      now,
      typeof s.remaining === 'number' ? s.remaining : null,
    );
    if (state === null) return null;
    const base = {
      saleId: s.saleId,
      productId: s.productId,
      priceMinor: s.priceMinor,
      currency: s.currency,
      perUserLimit: s.perUserLimit,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      state,
      serverTime: now.toISOString(),
    };
    if (state === 'UPCOMING') return { ...base, remainingApprox: null };
    if (state === 'ENDED') return { ...base, remainingApprox: 0 };
    if (s.remaining === 'error' || s.remaining === null)
      return { ...base, remainingApprox: null, degraded: true };
    return {
      ...base,
      remainingApprox: Math.max(0, Math.min(s.units, s.remaining)),
    };
  }
}

import { Injectable } from '@nestjs/common';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { allocateEvenly } from '@app/common/money/allocate';

/** Decrement only if enough units remain - atomic per bucket. Returns remaining or -1. */
const DECR_IF_ENOUGH = `
local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
if current < tonumber(ARGV[1]) then return -1 end
return redis.call('DECRBY', KEYS[1], ARGV[1])
`;

/** Per-user purchase cap for the sale; rolls back if over the limit. */
const INCR_WITH_LIMIT = `
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
if count > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return -1
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return count
`;

export interface ActiveFlashSale {
  saleId: string;
  productId: string;
  price: number;
  buckets: number;
  perUserLimit: number;
  endsAt: string;
}

/**
 * Flash-sale stock (lesson 10/07 #19): during a drop the units live in Redis,
 * split across N bucket keys with DIFFERENT hash tags so they land on
 * different cluster slots/shards - one hot "stock" key would serialize every
 * buyer on one Redis core. A reservation picks a random bucket and falls
 * through to the next ones only when it's empty. Postgres is reconciled after
 * the sale (units were moved out of `Product.quantity` when it started).
 */
@Injectable()
export class FlashStockService {
  constructor(private readonly redis: RedisService) {}

  private bucketKey(saleId: string, bucket: number) {
    return `flash:{${saleId}:${bucket}}:stock`;
  }

  private activeKey(productId: string) {
    return `flash:active:${productId}`;
  }

  async load(sale: ActiveFlashSale & { units: number }): Promise<void> {
    const parts = allocateEvenly(sale.units, sale.buckets);
    const ttlMs = Math.max(
      60_000,
      Date.parse(sale.endsAt) - Date.now() + 3_600_000,
    );
    await Promise.all(
      parts.map((units, b) =>
        this.redis.client.set(
          this.bucketKey(sale.saleId, b),
          units,
          'PX',
          ttlMs,
        ),
      ),
    );
    const { units: _units, ...marker } = sale;
    await this.redis.client.set(
      this.activeKey(sale.productId),
      JSON.stringify(marker),
      'PX',
      Math.max(1, Date.parse(sale.endsAt) - Date.now()),
    );
  }

  async activeFor(productIds: string[]): Promise<Map<string, ActiveFlashSale>> {
    if (productIds.length === 0) return new Map();
    const raw = await this.redis.client.mget(
      ...productIds.map((id) => this.activeKey(id)),
    );
    const active = new Map<string, ActiveFlashSale>();
    raw.forEach(
      (value, i) => value && active.set(productIds[i], JSON.parse(value)),
    );
    return active;
  }

  async deactivate(productId: string): Promise<void> {
    await this.redis.client.del(this.activeKey(productId));
  }

  /** Returns the bucket the units came from, or null when sold out. */
  async reserve(
    saleId: string,
    buckets: number,
    quantity: number,
  ): Promise<number | null> {
    const start = Math.floor(Math.random() * buckets);
    for (let i = 0; i < buckets; i++) {
      const bucket = (start + i) % buckets;
      const left = (await this.redis.client.eval(
        DECR_IF_ENOUGH,
        1,
        this.bucketKey(saleId, bucket),
        quantity,
      )) as number;
      if (left >= 0) return bucket;
    }
    return null;
  }

  async release(
    saleId: string,
    bucket: number,
    quantity: number,
  ): Promise<void> {
    await this.redis.client.incrby(this.bucketKey(saleId, bucket), quantity);
  }

  async claimUserQuota(
    saleId: string,
    userId: string,
    quantity: number,
    limit: number,
  ): Promise<boolean> {
    const ok = await this.redis.client.eval(
      INCR_WITH_LIMIT,
      1,
      `flash:{${saleId}}:user:${userId}`,
      quantity,
      limit,
      7 * 86_400_000,
    );
    return ok !== -1;
  }

  async releaseUserQuota(
    saleId: string,
    userId: string,
    quantity: number,
  ): Promise<void> {
    await this.redis.client.decrby(
      `flash:{${saleId}}:user:${userId}`,
      quantity,
    );
  }

  /** Sum of all buckets - approximate "only N left" for product pages (exact check happens on reserve). */
  async remaining(saleId: string, buckets: number): Promise<number> {
    const values = await Promise.all(
      Array.from({ length: buckets }, (_, b) =>
        this.redis.client.get(this.bucketKey(saleId, b)),
      ),
    );
    return values.reduce((sum, v) => sum + Math.max(0, Number(v ?? 0)), 0);
  }
}

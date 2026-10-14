import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { planDraw, type BucketDraw } from '../domain/flash-bucket-plan';
import { clampPlan } from '../domain/flash-drift';
import type { ReleaseMode } from '../domain/flash-claim-state';
import { FlashSaleUnavailableError } from '../domain/flash-errors';
import type {
  ClaimRequest,
  ClaimResult,
  FlashFastStore,
  StoreSale,
} from '../domain/flash-ports';
import { withTimeout } from '../domain/with-timeout';
import {
  ADMIT,
  BUCKET_CLAMP,
  BUCKET_DRAW,
  BUCKET_RETURN,
  CLAIM_COMMIT,
  CLAIM_CONVERT,
  CLAIM_OPEN,
  CLAIM_RELEASE_BEGIN,
  CLAIM_RELEASE_END,
  CLAIM_SET_PLAN,
  QUOTA_RELEASE,
  QUOTA_TAKE,
  SET_ADD,
  ZSET_ADD,
  flashKeys,
} from './flash-scripts';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
/** A draw that finds the bucket short is planned again this many times before the buyer is told "sold out". */
const MAX_PLANS = 3;

const shaOf = (script: string) =>
  createHash('sha1').update(script).digest('hex');

/**
 * The fast store on Redis (S11 data-model §2). Every command runs under `orders_flash_call_timeout_ms` and any failure
 * (timeout, connection, refused command) becomes `FlashSaleUnavailableError`: fail closed, no retry inside a buyer
 * request. A script that answers "sold out", "over the limit" or "stopped" returns a value, not an error.
 */
@Injectable()
export class RedisFlashFastStore implements FlashFastStore {
  private readonly shas = new Map<string, string>();

  constructor(
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------ plumbing

  private guard<T>(call: () => Promise<T>): Promise<T> {
    const unavailable = () => new FlashSaleUnavailableError();
    let pending: Promise<T>;
    try {
      pending = call();
    } catch {
      return Promise.reject(unavailable());
    }
    return withTimeout(
      pending.catch((error: unknown) => {
        if (error instanceof FlashSaleUnavailableError) throw error;
        throw unavailable();
      }),
      this.config.get('orders_flash_call_timeout_ms'),
      unavailable,
    );
  }

  private script<T>(
    source: string,
    keys: string[],
    args: Array<string | number> = [],
  ): Promise<T> {
    return this.guard(async () => {
      let sha = this.shas.get(source);
      if (!sha) {
        sha = shaOf(source);
        this.shas.set(source, sha);
      }
      try {
        return (await this.redis.client.evalsha(
          sha,
          keys.length,
          ...keys,
          ...args,
        )) as T;
      } catch (error) {
        if (!String((error as Error).message).includes('NOSCRIPT')) throw error;
        return (await this.redis.client.eval(
          source,
          keys.length,
          ...keys,
          ...args,
        )) as T;
      }
    });
  }

  /** Lifetime of every key of a sale: until the end of the window, the hold window and an hour, ±jitter (no avalanche). */
  private ttlMs(sale: Pick<StoreSale, 'endsAt'>): number {
    const base =
      Math.max(0, sale.endsAt.getTime() - this.clock.nowMs()) +
      15 * MINUTE_MS +
      HOUR_MS;
    const jitter = this.config.get('orders_flash_key_ttl_jitter');
    return Math.ceil(base * (1 + (Math.random() * 2 - 1) * jitter));
  }

  // ------------------------------------------------------------ buckets

  async fillBuckets(sale: StoreSale, parts: number[]): Promise<void> {
    const ttl = this.ttlMs(sale);
    await Promise.all(
      parts.map((units, b) =>
        this.guard(() =>
          this.redis.client.set(
            flashKeys.stock(sale.saleId, b),
            units,
            'PX',
            ttl,
            'NX',
          ),
        ),
      ),
    );
  }

  async remaining(saleId: string, buckets: number): Promise<number[]> {
    const values = await Promise.all(
      Array.from({ length: buckets }, (_, b) =>
        this.guard(() => this.redis.client.get(flashKeys.stock(saleId, b))),
      ),
    );
    return values.map((v) => (v === null ? 0 : Number(v)));
  }

  async clamp(
    saleId: string,
    buckets: number,
    target: number,
  ): Promise<number> {
    const contents = await this.remaining(saleId, buckets);
    const next = clampPlan(contents, target);
    const after = await Promise.all(
      next.map((value, b) =>
        value < contents[b]
          ? this.script<number>(
              BUCKET_CLAMP,
              [flashKeys.stock(saleId, b)],
              [value],
            )
          : Promise.resolve(contents[b]),
      ),
    );
    return after.reduce((s, c) => s + Math.max(0, c), 0);
  }

  // ------------------------------------------------------------ admission

  async admit(sale: StoreSale, nowMs: number): Promise<{ admitted: boolean }> {
    const admitted = await this.script<number>(
      ADMIT,
      [flashKeys.admission(sale.saleId)],
      [sale.admissionRatePerSecond, nowMs, this.ttlMs(sale)],
    );
    return { admitted: admitted === 1 };
  }

  async stopSelling(saleId: string): Promise<boolean> {
    const added = await this.guard(() =>
      this.redis.client.hsetnx(flashKeys.admission(saleId), 'stopped', '1'),
    );
    return added === 1;
  }

  // ------------------------------------------------------------ claims

  async claim(sale: StoreSale, req: ClaimRequest): Promise<ClaimResult> {
    const { saleId } = sale;
    const [stopped, contents] = await Promise.all([
      this.guard(() =>
        this.redis.client.hget(flashKeys.admission(saleId), 'stopped'),
      ),
      this.remaining(saleId, sale.buckets),
    ]);
    if (stopped === '1') return { kind: 'stopped' };

    let plan = planDraw(contents, req.quantity, req.startBucket);
    // Nothing is written for a refusal that the counters already show: a sold-out drop costs one round trip.
    if (plan.kind === 'insufficient') {
      const replay = await this.existingClaim(saleId, req.claimId);
      if (!replay) return { kind: 'out_of_stock' };
    }

    const ttl = this.ttlMs(sale);
    const claimKey = flashKeys.claim(saleId, req.claimId);
    const draws0 = plan.kind === 'ok' ? plan.draws : [];
    const [state, savedPlan] = await this.script<[string, string]>(
      CLAIM_OPEN,
      [claimKey],
      [
        req.buyerId,
        req.quantity,
        req.unitPriceMinor,
        req.nowMs,
        ttl,
        JSON.stringify(draws0),
      ],
    );
    if (state === 'RETURNING') {
      await this.release(saleId, req.claimId, 'return');
      return this.claim(sale, req);
    }
    let draws: BucketDraw[] = JSON.parse(savedPlan) as BucketDraw[];
    if (state === 'COMMITTED' || state === 'SOLD')
      return { kind: 'already_claimed', draws };

    // The sweeper finds the claim through this set; the buyer set lets the reconcile delete the quota keys.
    const quotaKey = flashKeys.quota(saleId, req.buyerId);
    const [, , quota] = await Promise.all([
      this.script(
        ZSET_ADD,
        [flashKeys.claims(saleId)],
        [req.nowMs + req.claimWindowMs, req.claimId, ttl],
      ),
      this.script(SET_ADD, [flashKeys.buyers(saleId)], [req.buyerId, ttl]),
      this.script<number>(
        QUOTA_TAKE,
        [quotaKey],
        [req.claimId, req.quantity, sale.perUserLimit, ttl],
      ),
    ]);
    if (quota === 0) {
      await this.release(saleId, req.claimId, 'return');
      return { kind: 'limit_exceeded', limit: sale.perUserLimit };
    }

    for (let attempt = 0; ; attempt++) {
      if (draws.length === 0) {
        // A resumed claim without a plan, or a plan that was given back: plan from what the buckets hold now.
        const now = await this.remaining(saleId, sale.buckets);
        plan = planDraw(now, req.quantity, req.startBucket);
        if (plan.kind === 'insufficient') {
          await this.release(saleId, req.claimId, 'return');
          return { kind: 'out_of_stock' };
        }
        draws = plan.draws;
        const saved = await this.script<number>(
          CLAIM_SET_PLAN,
          [claimKey],
          [JSON.stringify(draws)],
        );
        if (saved === 0) throw new FlashSaleUnavailableError();
      }
      const results = await Promise.all(
        draws.map((d) =>
          this.script<number>(
            BUCKET_DRAW,
            [
              flashKeys.stock(saleId, d.bucket),
              flashKeys.draws(saleId, d.bucket),
            ],
            [req.claimId, d.take, ttl],
          ),
        ),
      );
      if (results.every((r) => r >= 0 || r === -2))
        return results.some((r) => r >= 0)
          ? {
              kind: 'held',
              draws,
              lastUnits:
                contents.reduce((s, c) => s + Math.max(0, c), 0) -
                  req.quantity <=
                0,
            }
          : { kind: 'already_claimed', draws };

      // A bucket was emptied between the read and the draw: give back what was taken and plan again.
      await Promise.all(
        draws.map((d) =>
          this.script(
            BUCKET_RETURN,
            [
              flashKeys.stock(saleId, d.bucket),
              flashKeys.draws(saleId, d.bucket),
            ],
            [req.claimId, 'return', HOUR_MS],
          ),
        ),
      );
      if (attempt + 1 >= MAX_PLANS) {
        await this.release(saleId, req.claimId, 'return');
        return { kind: 'out_of_stock' };
      }
      draws = [];
    }
  }

  private async existingClaim(
    saleId: string,
    claimId: string,
  ): Promise<boolean> {
    const state = await this.guard(() =>
      this.redis.client.hget(flashKeys.claim(saleId, claimId), 'state'),
    );
    return state !== null;
  }

  private async dropFromClaims(saleId: string, claimId: string): Promise<void> {
    await this.guard(() =>
      this.redis.client.zrem(flashKeys.claims(saleId), claimId),
    );
  }

  async commit(
    saleId: string,
    claimId: string,
  ): Promise<'committed' | 'already_committed' | 'not_held'> {
    const answer = await this.script<
      'committed' | 'already_committed' | 'not_held'
    >(CLAIM_COMMIT, [flashKeys.claim(saleId, claimId)]);
    await this.dropFromClaims(saleId, claimId);
    return answer;
  }

  async convert(
    saleId: string,
    claimId: string,
  ): Promise<'converted' | 'already_converted' | 'not_held'> {
    const answer = await this.script<
      'converted' | 'already_converted' | 'not_held'
    >(CLAIM_CONVERT, [flashKeys.claim(saleId, claimId)]);
    await this.dropFromClaims(saleId, claimId);
    return answer;
  }

  async release(
    saleId: string,
    claimId: string,
    mode: ReleaseMode,
  ): Promise<'released' | 'already_released' | 'not_held'> {
    const claimKey = flashKeys.claim(saleId, claimId);
    const begun = await this.script<string[]>(
      CLAIM_RELEASE_BEGIN,
      [claimKey],
      [mode],
    );
    if (begun[0] !== 'begun') {
      await this.dropFromClaims(saleId, claimId);
      return begun[0] as 'already_released' | 'not_held';
    }
    const [, planJson, buyer, firstMode] = begun;
    const draws = JSON.parse(planJson) as BucketDraw[];
    // Visible to the sweeper at once, so a release that crashes below is resumed.
    await this.script(
      ZSET_ADD,
      [flashKeys.claims(saleId)],
      [0, claimId, HOUR_MS],
    );
    const returned = await Promise.all([
      ...draws.map((d) =>
        this.script<number>(
          BUCKET_RETURN,
          [
            flashKeys.stock(saleId, d.bucket),
            flashKeys.draws(saleId, d.bucket),
          ],
          [claimId, firstMode, HOUR_MS],
        ),
      ),
      this.script<number>(
        QUOTA_RELEASE,
        [flashKeys.quota(saleId, buyer)],
        [claimId],
      ),
    ]);
    await this.script(CLAIM_RELEASE_END, [claimKey]);
    await this.dropFromClaims(saleId, claimId);
    return returned.some((n) => n > 0) ? 'released' : 'already_released';
  }

  async expiredClaims(
    saleId: string,
    nowMs: number,
    limit: number,
  ): Promise<string[]> {
    return this.guard(() =>
      this.redis.client.zrangebyscore(
        flashKeys.claims(saleId),
        '-inf',
        nowMs,
        'LIMIT',
        0,
        limit,
      ),
    );
  }

  // ------------------------------------------------------------ end of a sale

  async dropSale(saleId: string, buckets: number): Promise<void> {
    const client = this.redis.client;
    const keys = [
      flashKeys.admission(saleId),
      flashKeys.claims(saleId),
      flashKeys.soldOut(saleId),
      ...Array.from({ length: buckets }, (_, b) => [
        flashKeys.stock(saleId, b),
        flashKeys.draws(saleId, b),
      ]).flat(),
    ];
    const buyers = await this.guard(() =>
      client.smembers(flashKeys.buyers(saleId)),
    );
    keys.push(
      flashKeys.buyers(saleId),
      ...buyers.map((u) => flashKeys.quota(saleId, u)),
    );
    // Claim records carry their own TTL, but a finished sale leaves nothing behind.
    let cursor = '0';
    do {
      const [next, found] = await this.guard(() =>
        client.scan(
          cursor,
          'MATCH',
          flashKeys.claimPattern(saleId),
          'COUNT',
          500,
        ),
      );
      cursor = next;
      keys.push(...found);
    } while (cursor !== '0');
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500);
      await Promise.all(batch.map((k) => this.guard(() => client.unlink(k))));
    }
  }

  async markSoldOut(saleId: string): Promise<boolean> {
    const reply = await this.guard(() =>
      this.redis.client.set(
        flashKeys.soldOut(saleId),
        '1',
        'PX',
        2 * HOUR_MS,
        'NX',
      ),
    );
    return reply === 'OK';
  }

  /** The `sold-out` marker is removed again when its event could not be appended (R-08). */
  async clearSoldOut(saleId: string): Promise<void> {
    await this.guard(() => this.redis.client.del(flashKeys.soldOut(saleId)));
  }
}

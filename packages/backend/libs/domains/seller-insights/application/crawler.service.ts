import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { createHash } from 'node:crypto';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { Environment } from '@app/common/types';
import {
  checkSafeUrl,
  safeGet,
  SafeRequestError,
} from '@app/infrastructure/net';
import { ProductQueryService, type ProductDto } from '@app/domains/catalog';
import { MembershipQueryService } from '@app/domains/tenancy';
import { CompetitorPriceDropped } from './events/seller-insights-events';
import { Frontier } from '../infra/frontier';
import { normalizeUrl } from '../domain/url';
import { isAllowed, parseRobots, RobotsRules } from '../domain/robots';
import { simhash, simhashDistance, visibleText } from '../domain/simhash';
import { extractPrice } from '../domain/extract-price';

export const USER_AGENT =
  'MarketplacePriceBot/1.0 (+https://marketplace.dev/bot)';
const BASE_INTERVAL_H = 6;
const MAX_INTERVAL_H = 48;
const MIN_DELAY_MS = 1_000;
const UNCHANGED_BITS = 3;
/** Most ids the product and membership R1 reads take per call. */
const READ_BATCH = 500;

interface Target {
  id: string;
  url: string;
  host: string;
  lastPriceMinor: string | null;
  simhash: string | null;
  unchangedStreak: number;
}

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);
  readonly frontier: Frontier;

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly redis: RedisService,
    private readonly storage: ObjectStorage,
    private readonly clickhouse: ClickHouseService,
    private readonly outbox: OutboxService,
    private readonly transactions: TransactionRunner,
    private readonly config: ApiConfigService,
    private readonly products: ProductQueryService,
    private readonly members: MembershipQueryService,
  ) {
    this.frontier = new Frontier(redis);
  }

  get ssrf() {
    if (this.config.get('node_env') === Environment.production) return {};
    const hosts = (this.config.get('webhooks_allow_private_hosts') ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    return { allowHttpHosts: hosts, allowPrivateHosts: hosts };
  }

  async watch(shopId: string, productId: string, rawUrl: string) {
    let url: string;
    try {
      url = normalizeUrl(rawUrl);
      await checkSafeUrl(url, this.ssrf);
    } catch (error) {
      throw new BadRequestException(
        error instanceof SafeRequestError ? error.message : 'invalid URL',
      );
    }
    const host = new URL(url).host;
    return this.transactions.run(async (transaction) => {
      const [target] = await this.sequelize.query<{ id: string }>(
        `INSERT INTO "CrawlTarget" (url, host) VALUES (:url, :host) ON CONFLICT (url) DO UPDATE SET "nextCheckAt" = LEAST("CrawlTarget"."nextCheckAt", now()) RETURNING id`,
        { type: QueryTypes.SELECT, replacements: { url, host }, transaction },
      );
      const owned = await this.products.getProductsByIds([productId], {
        shopId,
      });
      if (owned.size === 0)
        throw new BadRequestException('Product not found in this shop');
      await this.sequelize.query(
        `INSERT INTO "CompetitorWatch" ("shopId", "productId", "targetId") VALUES (:shopId, :productId, :targetId) ON CONFLICT DO NOTHING`,
        {
          replacements: { shopId, productId, targetId: target.id },
          transaction,
        },
      );
      return { targetId: target.id, url };
    });
  }

  /** Scheduler (every minute): due targets → frontier, each at most once per cycle no matter how many shops watch it. */
  async scheduleDue(limit = 5_000): Promise<number> {
    const due = await this.sequelize.query<{ id: string; host: string }>(
      `SELECT id, host FROM "CrawlTarget" WHERE "nextCheckAt" <= now() ORDER BY "nextCheckAt" LIMIT :limit`,
      {
        type: QueryTypes.SELECT,
        replacements: { limit },
      },
    );
    let queued = 0;
    for (const t of due) {
      if (
        !(await this.redis.client.set(
          `crawl:queued:${t.id}`,
          '1',
          'EX',
          3_600,
          'NX',
        ))
      )
        continue;
      await this.frontier.push(t.host, t.id);
      queued++;
    }
    return queued;
  }

  /** One fetcher iteration; returns false when nothing is ready (caller sleeps). */
  async crawlNext(): Promise<boolean> {
    const next = await this.frontier.take();
    if (!next) return false;
    let delayMs = MIN_DELAY_MS;
    try {
      delayMs = await this.crawl(next.url);
    } catch (error) {
      this.logger.warn(`crawl ${next.url} failed: ${(error as Error).message}`);
    } finally {
      await this.frontier.release(next.host, delayMs);
      await this.redis.client.del(`crawl:queued:${next.url}`);
    }
    return true;
  }

  /** Fetch + process one target. Returns the politeness delay for its host. */
  async crawl(targetId: string): Promise<number> {
    const [target] = await this.sequelize.query<Target>(
      `SELECT id, url, host, "lastPriceMinor", simhash, "unchangedStreak" FROM "CrawlTarget" WHERE id = :targetId`,
      {
        type: QueryTypes.SELECT,
        replacements: { targetId },
      },
    );
    if (!target) return MIN_DELAY_MS;
    const robots = await this.robots(target.url);
    const delayMs = Math.max(MIN_DELAY_MS, (robots.crawlDelaySec ?? 0) * 1000);
    const url = new URL(target.url);
    if (!isAllowed(robots, url.pathname + url.search))
      return this.finish(
        target,
        'disallowed-by-robots',
        target.unchangedStreak,
        delayMs,
        MAX_INTERVAL_H,
      );

    const res = await safeGet(target.url, {
      userAgent: USER_AGENT,
      maxRedirects: 3,
      sameHostRedirectsOnly: false,
      ...this.ssrf,
    });
    if (res.status === 429 || res.status === 503)
      return this.finish(
        target,
        `http-${res.status}`,
        target.unchangedStreak,
        delayMs * 10,
        BASE_INTERVAL_H,
      ); // back off this host
    if (res.status >= 400)
      return this.finish(
        target,
        `http-${res.status}`,
        target.unchangedStreak + 1,
        delayMs,
        BASE_INTERVAL_H * 2,
      );

    // Extraction is cheap and ALWAYS runs: a price change is a one-token edit that SimHash alone would call "unchanged".
    const price = extractPrice(res.body);
    const fingerprint = simhash(visibleText(res.body));
    const samePrice =
      price !== null &&
      target.lastPriceMinor !== null &&
      price.amountMinor === Number(target.lastPriceMinor);
    if (
      samePrice &&
      target.simhash &&
      simhashDistance(fingerprint, target.simhash) <= UNCHANGED_BITS
    ) {
      // Same price, near-identical page: skip storage/history, back off exponentially (6 h → 12 h → 24 h → 48 h).
      return this.finish(
        target,
        'unchanged',
        target.unchangedStreak + 1,
        delayMs,
        Math.min(
          BASE_INTERVAL_H * 2 ** (target.unchangedStreak + 1),
          MAX_INTERVAL_H,
        ),
        fingerprint,
      );
    }

    const day = new Date().toISOString().slice(0, 10);
    await this.storage.put(
      `crawl/${day}/${target.host}/${target.id}-${Date.now()}.html`,
      Buffer.from(res.body),
      'text/html',
    ); // 7-day lifecycle rule (O-03)
    if (!price)
      return this.finish(
        target,
        'no-price',
        0,
        delayMs,
        BASE_INTERVAL_H,
        fingerprint,
      );

    await this.clickhouse.getClient().insert({
      table: 'competitor_prices',
      format: 'JSONEachRow',
      values: [
        {
          target_id: target.id,
          ts: new Date().toISOString().replace('Z', ''),
          price_minor: price.amountMinor,
          currency: price.currency,
        },
      ],
    });
    await this.sequelize.query(
      `UPDATE "CrawlTarget" SET "lastPriceMinor" = :price, currency = :currency WHERE id = :id`,
      {
        replacements: {
          price: price.amountMinor,
          currency: price.currency,
          id: target.id,
        },
      },
    );
    const previous =
      target.lastPriceMinor === null ? null : Number(target.lastPriceMinor);
    if (previous === null || price.amountMinor < previous)
      await this.alertUndercut(target, price.amountMinor, price.currency);
    return this.finish(target, 'ok', 0, delayMs, BASE_INTERVAL_H, fingerprint);
  }

  /** Alert only shops this price actually undercuts, once per (watch, price). */
  private async alertUndercut(
    target: Target,
    priceMinor: number,
    currency: string,
  ) {
    const watches = await this.sequelize.query<{
      watchId: string;
      shopId: string;
      productId: string;
    }>(
      `SELECT w.id AS "watchId", w."shopId", w."productId"
       FROM "CompetitorWatch" w
       WHERE w."targetId" = :targetId`,
      { type: QueryTypes.SELECT, replacements: { targetId: target.id } },
    );
    // Products and owners belong to catalog and tenancy: read them through their R1 services, in batches of 500.
    const products = new Map<string, ProductDto>();
    const owners = new Map<string, Array<{ userId: string }>>();
    const productIds = [...new Set(watches.map((w) => w.productId))];
    const shopIds = [...new Set(watches.map((w) => w.shopId))];
    for (let i = 0; i < productIds.length; i += READ_BATCH)
      for (const [id, p] of await this.products.getProductsByIds(
        productIds.slice(i, i + READ_BATCH),
      ))
        products.set(id, p);
    for (let i = 0; i < shopIds.length; i += READ_BATCH)
      for (const [id, members] of await this.members.getMembersByShopIds(
        shopIds.slice(i, i + READ_BATCH),
        ['OWNER'],
      ))
        owners.set(id, members);
    const watchers = watches.flatMap((w) => {
      const product = products.get(w.productId);
      if (!product || product.priceMinor <= priceMinor) return [];
      return (owners.get(w.shopId) ?? []).map((m) => ({
        ...w,
        title: product.title,
        price: product.priceMinor,
        ownerId: m.userId,
      }));
    });
    // What happened, once per watch; telling the owner is somebody else's business.
    await this.outbox.appendStandalone(
      watchers.map((w) =>
        CompetitorPriceDropped.create(w.watchId, 0, {
          watchId: w.watchId,
          shopId: w.shopId,
          productId: w.productId,
          productTitle: w.title,
          host: target.host,
          competitorPriceMinor: priceMinor,
          yourPriceMinor: Number(w.price),
          currency,
          ownerId: w.ownerId,
        }),
      ),
    );
  }

  private async finish(
    target: Target,
    status: string,
    streak: number,
    delayMs: number,
    nextHours: number,
    fingerprint?: string,
  ): Promise<number> {
    await this.sequelize.query(
      `UPDATE "CrawlTarget" SET "lastStatus" = :status, "unchangedStreak" = :streak, simhash = coalesce(:fingerprint, simhash),
              "lastCheckedAt" = now(), "nextCheckAt" = now() + make_interval(hours => :hours) WHERE id = :id`,
      {
        replacements: {
          status,
          streak,
          fingerprint: fingerprint ?? null,
          hours: nextHours,
          id: target.id,
        },
      },
    );
    return delayMs;
  }

  /** robots.txt per host, cached 24 h (and 1 h for "no robots.txt"); unreachable robots → treat as allowed with a slow default. */
  private async robots(url: string): Promise<RobotsRules> {
    const origin = new URL(url).origin;
    const key = `crawl:robots:${origin}`;
    const cached = await this.redis.client.get(key);
    if (cached) return JSON.parse(cached) as RobotsRules;
    let rules: RobotsRules = { allow: [], disallow: [], crawlDelaySec: null };
    let ttl = 3_600;
    try {
      const res = await safeGet(`${origin}/robots.txt`, {
        userAgent: USER_AGENT,
        maxBytes: 512 * 1024,
        maxRedirects: 3,
        sameHostRedirectsOnly: false,
        ...this.ssrf,
      });
      if (res.status === 200) {
        rules = parseRobots(res.body, USER_AGENT);
        ttl = 86_400;
      } else if (res.status >= 500)
        rules = { allow: [], disallow: ['/'], crawlDelaySec: null }; // RFC 9309: server error → assume complete disallow for now
    } catch {
      rules.crawlDelaySec = 10;
    }
    await this.redis.client.set(key, JSON.stringify(rules), 'EX', ttl);
    return rules;
  }

  urlKey(url: string) {
    return createHash('sha256').update(url).digest('hex');
  }
}

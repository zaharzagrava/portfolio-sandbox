import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { RedisBloomFilter } from '@app/infrastructure/cache/bloom-filter';
import { ApiConfigService } from '@app/common/config';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { defineEvent } from '@app/infrastructure/events/define-event';
import { CUSTOM_ALIAS, scramble, toBase62 } from '../domain/codes';
import { IdLease } from '../infra/id-lease';

export const LinkClicked = defineEvent(
  'link.clicked',
  'links',
  1,
  z.object({
    clickId: z.string(),
    code: z.string(),
    ts: z.string(),
    country: z.string().default(''),
    referer: z.string().default(''),
    viaEdge: z.boolean().default(false),
  }),
);

export interface ShortLink {
  code: string;
  destination: string;
  ownerId: string;
  createdAt: string;
  expiresAtEpoch?: number;
}

const TABLE = 'Links';
const linkCacheKey = (code: string) => `link:v1:${code}`;

/**
 * Share & affiliate links (lesson 10/05 #8):
 *  - create: id lease → Feistel → base62 (or a custom alias via conditional put),
 *    destinations restricted to marketplace hosts (no open redirect),
 *  - resolve: Bloom filter ("definitely not a code" → 404 without any lookup) →
 *    cache-aside with negative caching → DynamoDB; 302 so every click counts and
 *    destinations stay editable,
 *  - clicks: fire-and-forget Kafka event → ClickHouse; never in the redirect latency.
 */
@Injectable()
export class ShareLinkService {
  private readonly ids: IdLease;
  private readonly bloom: RedisBloomFilter;
  private readonly secret: string;
  private readonly allowedHosts: Set<string>;

  constructor(
    private readonly dynamo: DynamoService,
    private readonly redis: RedisService,
    private readonly cache: CacheService,
    private readonly producer: KafkaProducerService,
    private readonly clickhouse: ClickHouseService,
    private readonly config: ApiConfigService,
  ) {
    this.ids = new IdLease(redis, 'share-links:id-seq');
    this.bloom = new RedisBloomFilter(
      redis,
      'share-links:bloom',
      100_000_000,
      0.01,
    );
    this.secret = config.get('share_link_secret') || config.get('jwt_secret');
    this.allowedHosts = new Set([
      new URL(config.get('front_host')).host,
      'www.' + new URL(config.get('front_host')).host,
    ]);
  }

  get publicBase(): string {
    return (
      this.config.get('share_link_base_url') ||
      `${this.config.get('backend_host')}/api/l`
    );
  }

  async create(
    ownerId: string,
    destination: string,
    alias?: string,
    ttlDays?: number,
  ): Promise<ShortLink & { shortUrl: string }> {
    const url = this.validateDestination(destination);
    const code =
      alias ?? toBase62(scramble(await this.ids.nextId(), this.secret));
    if (alias && !CUSTOM_ALIAS.test(alias))
      throw new UnprocessableEntityException(
        'Alias: 4-32 letters, digits or dashes',
      );

    const link: ShortLink = {
      code,
      destination: url.toString(),
      ownerId,
      createdAt: new Date().toISOString(),
      ...(ttlDays && {
        expiresAtEpoch: Math.floor(Date.now() / 1000) + ttlDays * 86_400,
      }),
    };
    try {
      await this.dynamo.doc.send(
        new PutCommand({
          TableName: this.dynamo.table(TABLE),
          Item: link,
          ConditionExpression: 'attribute_not_exists(code)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException)
        throw new ConflictException('Alias is taken');
      throw error;
    }
    await this.bloom.add([code]);
    await this.cache.invalidate([linkCacheKey(code)]); // drop a cached "not found" for a just-claimed alias
    return { ...link, shortUrl: `${this.publicBase}/${code}` };
  }

  async resolve(code: string): Promise<ShortLink | null> {
    if (!/^[A-Za-z0-9-]{4,32}$/.test(code)) return null;
    if (!(await this.bloom.mightContain(code).catch(() => true))) return null; // enumeration scans stop here
    const link = await this.cache.getOrLoad<ShortLink>(
      linkCacheKey(code),
      async () =>
        ((
          await this.dynamo.doc.send(
            new GetCommand({
              TableName: this.dynamo.table(TABLE),
              Key: { code },
            }),
          )
        ).Item as ShortLink) ?? null,
      { ttlMs: 3_600_000, swrMs: 86_400_000, negativeTtlMs: 60_000, l1: 'hot' },
    );
    if (
      !link ||
      (link.expiresAtEpoch && link.expiresAtEpoch < Date.now() / 1000)
    )
      return null;
    return link;
  }

  /** Click event off the redirect path (the HTTP response doesn't wait for Kafka). */
  recordClick(
    code: string,
    meta: { country?: string; referer?: string; viaEdge?: boolean },
  ): void {
    const event = LinkClicked.create(code, 0, {
      clickId: uuidv7(),
      code,
      ts: new Date().toISOString(),
      country: meta.country ?? '',
      referer: (meta.referer ?? '').slice(0, 300),
      viaEdge: meta.viaEdge ?? false,
    });
    void this.producer
      .send({ topic: LinkClicked.topic, key: code, value: event })
      .catch(() => undefined);
  }

  async mine(ownerId: string): Promise<ShortLink[]> {
    const res = await this.dynamo.doc.send(
      new QueryCommand({
        TableName: this.dynamo.table(TABLE),
        IndexName: 'byOwner',
        KeyConditionExpression: 'ownerId = :o',
        ExpressionAttributeValues: { ':o': ownerId },
        ScanIndexForward: false,
        Limit: 100,
      }),
    );
    return (res.Items ?? []) as ShortLink[];
  }

  async stats(code: string, ownerId: string) {
    const link = await this.resolve(code);
    if (!link || link.ownerId !== ownerId)
      throw new NotFoundException('Link not found');
    return this.clickhouse.query<{ minute: string; clicks: string }>(
      `SELECT minute, sum(clicks) AS clicks FROM link_clicks_minute WHERE code = {code:String} AND minute >= now() - INTERVAL 7 DAY GROUP BY minute ORDER BY minute`,
      { code },
    );
  }

  /** Destination must be ours: a shortener that redirects anywhere is a phishing tool (open redirect, lesson 05/01 §6). */
  private validateDestination(destination: string): URL {
    let url: URL;
    try {
      url = new URL(destination);
    } catch {
      throw new UnprocessableEntityException(
        'Destination must be an absolute URL',
      );
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new UnprocessableEntityException('Only http(s) destinations');
    if (!this.allowedHosts.has(url.host))
      throw new UnprocessableEntityException(
        'Links may only point to marketplace pages',
      );
    url.searchParams.delete('ref');
    return url;
  }
}

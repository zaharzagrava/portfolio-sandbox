import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import * as jwt from 'jsonwebtoken';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { Blocks, localeChain, Seo } from '../domain/blocks';
import { StoryPublished } from './events/story-events';

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'stories.publish': { storyId: string; scheduledAt: string };
  }
}

declareJobType({
  name: 'stories.publish',
  contract: z.object({ storyId: z.string(), scheduledAt: z.string() }),
});

export interface PublicStory {
  id: string;
  shopId: string;
  slug: string;
  version: number;
  locale: string;
  title: string;
  blocks: unknown[];
  seo: Record<string, unknown>;
  alternates: { locale: string; href: string }[];
  publishedAt: string;
}

const readKey = (shopSlug: string, slug: string) =>
  `story:{${shopSlug}}:${slug}`;

@Injectable()
export class StoriesService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
    private readonly events: OutboxService,
    private readonly config: ApiConfigService,
  ) {}

  async create(shopId: string, slug: string, defaultLocale = 'en') {
    const [story] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "Story" ("shopId", slug, "defaultLocale") VALUES (:shopId, :slug, :defaultLocale) RETURNING id, slug, status`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId, slug, defaultLocale },
      },
    );
    return story;
  }

  async saveDraft(
    shopId: string,
    storyId: string,
    locale: string,
    input: { title: string; blocks: unknown; seo?: unknown },
  ) {
    await this.own(shopId, storyId);
    const blocks = Blocks.safeParse(input.blocks);
    if (!blocks.success)
      throw new BadRequestException({
        message: 'Invalid blocks',
        issues: blocks.error.issues.slice(0, 10),
      });
    const seo = Seo.parse(input.seo ?? {});
    await this.sequelize.query(
      `INSERT INTO "StoryDraft" ("storyId", locale, title, blocks, seo) VALUES (:storyId, :locale, :title, CAST(:blocks AS jsonb), CAST(:seo AS jsonb))
       ON CONFLICT ("storyId", locale) DO UPDATE SET title = EXCLUDED.title, blocks = EXCLUDED.blocks, seo = EXCLUDED.seo, "updatedAt" = now()`,
      {
        replacements: {
          storyId,
          locale,
          title: input.title,
          blocks: JSON.stringify(blocks.data),
          seo: JSON.stringify(seo),
        },
      },
    );
    return { storyId, locale, blocks: blocks.data };
  }

  /** Now, or at reveal time (SD-29 job; rescheduling makes the old job a no-op via the scheduledAt check). */
  async publish(shopId: string, storyId: string, at?: Date) {
    await this.own(shopId, storyId);
    if (at && at.getTime() > Date.now()) {
      await this.sequelize.query(
        `UPDATE "Story" SET status = 'SCHEDULED', "scheduledAt" = :at WHERE id = :storyId`,
        { replacements: { at, storyId } },
      );
      await this.jobs.enqueue(
        'stories.publish',
        { storyId, scheduledAt: at.toISOString() },
        {
          runAt: at,
          idempotencyKey: `story-publish:${storyId}:${at.toISOString()}`,
        },
      );
      return { status: 'SCHEDULED', scheduledAt: at };
    }
    return this.publishNow(storyId);
  }

  async publishScheduled({
    storyId,
    scheduledAt,
  }: {
    storyId: string;
    scheduledAt: string;
  }) {
    const [story] = await this.sequelize.query<{
      status: string;
      scheduledAt: Date | null;
    }>(`SELECT status, "scheduledAt" FROM "Story" WHERE id = :storyId`, {
      type: QueryTypes.SELECT,
      replacements: { storyId },
    });
    if (
      story?.status !== 'SCHEDULED' ||
      !story.scheduledAt ||
      new Date(story.scheduledAt).toISOString() !== scheduledAt
    )
      return null; // rescheduled / cancelled
    return this.publishNow(storyId);
  }

  /** Freeze drafts → version N, flip the pointer, refresh the read model, and announce it (outbox → cache purge). */
  async publishNow(storyId: string) {
    const published = await this.transactions.run(async (transaction) => {
      const [story] = await this.sequelize.query<{
        id: string;
        shopId: string;
        slug: string;
        version: number;
      }>(
        `SELECT s.id, s."shopId", s.slug, coalesce((SELECT max(version) FROM "StoryVersion" v WHERE v."storyId" = s.id), 0) + 1 AS version FROM "Story" s WHERE s.id = :storyId FOR UPDATE`,
        { type: QueryTypes.SELECT, replacements: { storyId }, transaction },
      );
      const locales = await this.sequelize.query<{ locale: string }>(
        `INSERT INTO "StoryVersion" ("storyId", version, locale, title, blocks, seo) SELECT "storyId", :version, locale, title, blocks, seo FROM "StoryDraft" WHERE "storyId" = :storyId RETURNING locale`,
        {
          type: QueryTypes.SELECT,
          replacements: { storyId, version: story.version },
          transaction,
        },
      );
      if (locales.length === 0)
        throw new BadRequestException('Nothing to publish: save a draft first');
      await this.sequelize.query(
        `UPDATE "Story" SET status = 'PUBLISHED', "publishedVersion" = :version, "publishedAt" = now(), "scheduledAt" = NULL WHERE id = :storyId`,
        {
          replacements: { version: story.version, storyId },
          transaction,
        },
      );
      await this.events.append(
        StoryPublished.create(storyId, story.version, {
          storyId,
          shopId: story.shopId,
          slug: story.slug,
          version: story.version,
          locales: locales.map((l) => l.locale),
        }),
        transaction,
      );
      return { ...story, locales: locales.map((l) => l.locale) };
    });
    const [shop] = await this.sequelize.query<{ slug: string }>(
      `SELECT slug FROM "Shop" WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: published.shopId } },
    );
    await this.redis.client.del(readKey(shop.slug, published.slug));
    return {
      status: 'PUBLISHED',
      version: published.version,
      locales: published.locales,
    };
  }

  /**
   * Public read path (origin behind the CDN): Redis hash per story holding every
   * locale of the PUBLISHED version; DB only on a miss. ≈ 1% of views reach
   * the origin at all (s-maxage + stale-while-revalidate).
   */
  async publicStory(
    shopSlug: string,
    slug: string,
    requestedLocale: string,
  ): Promise<PublicStory> {
    let all = await this.redis.client.hgetall(readKey(shopSlug, slug));
    if (!all || Object.keys(all).length === 0) {
      const rows = await this.sequelize.query<{
        id: string;
        shopId: string;
        version: number;
        locale: string;
        title: string;
        blocks: unknown[];
        seo: object;
        publishedAt: Date;
        defaultLocale: string;
      }>(
        `SELECT s.id, s."shopId", v.version, v.locale, v.title, v.blocks, v.seo, s."publishedAt", s."defaultLocale"
         FROM "Story" s JOIN "Shop" sh ON sh.id = s."shopId" JOIN "StoryVersion" v ON v."storyId" = s.id AND v.version = s."publishedVersion"
         WHERE sh.slug = :shopSlug AND s.slug = :slug AND s.status = 'PUBLISHED'`,
        { type: QueryTypes.SELECT, replacements: { shopSlug, slug } },
      );
      if (rows.length === 0) throw new NotFoundException('Story not found');
      all = Object.fromEntries([
        ['__default', rows[0].defaultLocale],
        ...rows.map((r) => [r.locale, JSON.stringify(r)]),
      ]);
      await this.redis.client
        .multi()
        .hset(readKey(shopSlug, slug), all)
        .expire(readKey(shopSlug, slug), 3600)
        .exec();
    }
    const locales = Object.keys(all).filter((k) => k !== '__default');
    const locale = localeChain(requestedLocale, locales, all.__default);
    if (!locale) throw new NotFoundException('Story not found');
    const row = JSON.parse(all[locale]) as {
      id: string;
      shopId: string;
      version: number;
      title: string;
      blocks: unknown[];
      seo: Record<string, unknown>;
      publishedAt: string;
    };
    const front = this.config.get('front_host');
    return {
      id: row.id,
      shopId: row.shopId,
      slug,
      version: row.version,
      locale,
      title: row.title,
      blocks: row.blocks,
      seo: row.seo,
      alternates: locales.map((l) => ({
        locale: l,
        href: `${front}/${l}/brands/${shopSlug}/stories/${slug}`,
      })),
      publishedAt: new Date(row.publishedAt).toISOString(),
    };
  }

  /** Signed 30-minute preview link for staff (draft content, never cached). */
  async previewToken(shopId: string, storyId: string, locale: string) {
    await this.own(shopId, storyId);
    return {
      token: jwt.sign(
        { typ: 'story-preview', s: storyId, l: locale },
        this.config.get('jwt_secret'),
        { expiresIn: 1800 },
      ),
    };
  }

  async preview(token: string) {
    let claims: { typ: string; s: string; l: string };
    try {
      claims = jwt.verify(
        token,
        this.config.get('jwt_secret'),
      ) as typeof claims;
    } catch {
      throw new NotFoundException();
    }
    if (claims.typ !== 'story-preview') throw new NotFoundException();
    const [draft] = await this.sequelize.query(
      `SELECT title, blocks, seo, "updatedAt" FROM "StoryDraft" WHERE "storyId" = :s AND locale = :l`,
      { type: QueryTypes.SELECT, replacements: claims },
    );
    if (!draft) throw new NotFoundException();
    return draft;
  }

  /** Published story URLs in id order, in pages of `pageSize` - streamed by the sitemap controller. */
  async *publishedUrls(
    page: number,
    pageSize: number,
  ): AsyncGenerator<{
    shopSlug: string;
    slug: string;
    locales: string[];
    publishedAt: Date;
  }> {
    const [start] = await this.sequelize.query<{ id: string }>(
      `SELECT id FROM "Story" WHERE status = 'PUBLISHED' ORDER BY id OFFSET :offset LIMIT 1`,
      {
        type: QueryTypes.SELECT,
        replacements: { offset: page * pageSize },
      },
    );
    if (!start) return;
    let after = start.id;
    let first = true;
    let emitted = 0;
    while (emitted < pageSize) {
      const rows = await this.sequelize.query<{
        id: string;
        shopSlug: string;
        slug: string;
        locales: string[];
        publishedAt: Date;
      }>(
        `SELECT s.id, sh.slug AS "shopSlug", s.slug, s."publishedAt",
                (SELECT array_agg(locale) FROM "StoryVersion" v WHERE v."storyId" = s.id AND v.version = s."publishedVersion") AS locales
         FROM "Story" s JOIN "Shop" sh ON sh.id = s."shopId"
         WHERE s.status = 'PUBLISHED' AND s.id ${first ? '>=' : '>'} :after ORDER BY s.id LIMIT :limit`,
        {
          type: QueryTypes.SELECT,
          replacements: { after, limit: Math.min(1_000, pageSize - emitted) },
        },
      );
      if (rows.length === 0) return;
      for (const r of rows) yield r;
      emitted += rows.length;
      after = rows[rows.length - 1].id;
      first = false;
    }
  }

  async publishedCount(): Promise<number> {
    const [row] = await this.sequelize.query<{ n: string }>(
      `SELECT count(*) AS n FROM "Story" WHERE status = 'PUBLISHED'`,
      { type: QueryTypes.SELECT },
    );
    return Number(row.n);
  }

  private async own(shopId: string, storyId: string) {
    const [story] = await this.sequelize.query(
      `SELECT 1 FROM "Story" WHERE id = :storyId AND "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { storyId, shopId } },
    );
    if (!story) throw new NotFoundException('Story not found');
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import type { SitemapReader, SitemapRow } from '../domain/ports';
import type { StoryConfig } from '../domain/limits';
import { STORY_CONFIG } from '../application/story-config.token';
import { one, rows } from './sql';

interface Row extends Omit<SitemapRow, 'position'> {
  position: string;
}

/**
 * The sitemap's reads (S27 FR-051, FR-052): keyset by the story's stable `sitemapPosition`, never an offset or a full
 * count. A story is listed when it is `PUBLISHED` and its shop copy is visible; the shop identity comes from `StoryShop`.
 * Sitemap reads span shops by nature, so these statements carry no single shop. Each runs under a statement timeout
 * (a slow batch is a failure of the store, not a slow crawl).
 */
@Injectable()
export class SequelizeSitemapReader implements SitemapReader {
  constructor(
    @InjectConnection() private readonly db: Sequelize,
    private readonly runner: TransactionRunner,
    @Inject(STORY_CONFIG) private readonly config: StoryConfig,
  ) {}

  private timed<T>(work: () => Promise<T>): Promise<T> {
    return this.runner.run(work, {
      statementTimeoutMs: this.config.readTimeoutMs,
    });
  }

  highestPosition(): Promise<number | null> {
    return this.timed(async () => {
      const row = await one<{ p: string | null }>(
        this.db,
        `SELECT max("sitemapPosition") AS p FROM "Story" WHERE "sitemapPosition" IS NOT NULL`,
      );
      return row?.p == null ? null : Number(row.p);
    });
  }

  readBatch(input: {
    from: number;
    to: number;
    afterPosition: number;
    limit: number;
  }): Promise<SitemapRow[]> {
    return this.timed(async () => {
      const found = await rows<Row>(
        this.db,
        `SELECT s."sitemapPosition" AS "position", sh."slug" AS "shopSlug", s."slug", s."defaultLocale", s."publishedAt",
                (SELECT array_agg(v."locale" ORDER BY v."locale" COLLATE "C") FROM "StoryVersion" v
                  WHERE v."storyId" = s."id" AND v."shopId" = s."shopId" AND v."version" = s."publishedVersion") AS "locales"
           FROM "Story" s
           JOIN "StoryShop" sh ON sh."shopId" = s."shopId" AND sh."slug" IS NOT NULL AND sh."status" IN ('ACTIVE', 'DELETING')
          WHERE s."status" = 'PUBLISHED'
            AND s."sitemapPosition" >= $from AND s."sitemapPosition" <= $to AND s."sitemapPosition" > $afterPosition
          ORDER BY s."sitemapPosition" LIMIT $limit`,
        input,
      );
      return found.map((r) => ({ ...r, position: Number(r.position) }));
    });
  }
}

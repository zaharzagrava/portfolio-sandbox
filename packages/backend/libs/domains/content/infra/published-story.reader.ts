import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import { TransactionRunner } from '@app/infrastructure/context';
import type { Block, Seo } from '../domain/blocks';
import type { StoryConfig } from '../domain/limits';
import { STORY_CONFIG } from '../application/story-config.token';
import type { PublishedSnapshot, PublishedStoryReader } from '../domain/ports';
import { rows } from './sql';

interface Row {
  id: string;
  shopId: string;
  shopSlug: string;
  slug: string;
  defaultLocale: string;
  version: number;
  publishedAt: Date;
  locale: string;
  title: string;
  blocks: Block[];
  seo: Seo;
}

/**
 * The durable side of the public read (S27 FR-024, FR-025): the published version of one story with every locale. The
 * shop is found and checked through the copy `StoryShop` (never the tenancy tables); a story is visible when it is
 * `PUBLISHED` and the shop is `ACTIVE` (a `DELETING` shop keeps its live stories until `shop_deleted`, S03).
 */
@Injectable()
export class SequelizePublishedStoryReader implements PublishedStoryReader {
  constructor(
    @InjectConnection() private readonly db: Sequelize,
    private readonly runner: TransactionRunner,
    @Inject(STORY_CONFIG) private readonly config: StoryConfig,
  ) {}

  async load(
    shopSlug: string,
    slug: string,
  ): Promise<PublishedSnapshot | null> {
    const found = await this.runner.run(
      () =>
        rows<Row>(
          this.db,
          `SELECT s."id", s."shopId", sh."slug" AS "shopSlug", s."slug", s."defaultLocale",
                  s."publishedVersion" AS "version", s."publishedAt", v."locale", v."title", v."blocks", v."seo"
             FROM "StoryShop" sh
             JOIN "Story" s ON s."shopId" = sh."shopId" AND s."slug" = $slug AND s."status" = 'PUBLISHED'
             JOIN "StoryVersion" v ON v."storyId" = s."id" AND v."shopId" = s."shopId" AND v."version" = s."publishedVersion"
            WHERE sh."slug" = $shopSlug AND sh."status" IN ('ACTIVE', 'DELETING')
            ORDER BY v."locale" COLLATE "C"`,
          { shopSlug, slug },
        ),
      { statementTimeoutMs: this.config.readTimeoutMs },
    );
    if (found.length === 0) return null;
    const first = found[0];
    return {
      storyId: first.id,
      shopId: first.shopId,
      shopSlug: first.shopSlug,
      slug: first.slug,
      version: first.version,
      defaultLocale: first.defaultLocale,
      publishedAt: new Date(first.publishedAt).toISOString(),
      locales: Object.fromEntries(
        found.map((r) => [
          r.locale,
          { title: r.title, blocks: r.blocks, seo: r.seo },
        ]),
      ),
    };
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  StoryAdminDto,
  StoryVersionDto,
  StoryVersionListItemDto,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { decodeVersionCursor, encodeVersionCursor } from '../domain/cursor';
import {
  invalidTransition,
  storyNotFound,
  validationFailed,
  versionNotFound,
} from '../domain/errors';
import {
  DRAFT_REPOSITORY,
  READ_MODEL,
  STORY_REPOSITORY,
  TRANSITION_REPOSITORY,
  VERSION_REPOSITORY,
  type DraftRepository,
  type ReadModel,
  type StoryRepository,
  type TransitionRepository,
  type VersionRepository,
} from '../domain/ports';
import { nextStatus } from '../domain/story-status';
import { StoryArchived } from './events/story-events';
import { toAdminDto } from './mappers';
import { ShopIdentity } from './shop-identity.service';
import { logOutcome } from './story-log';
import { StoryWriteLimit } from './story-limits';

/** Take-down, version history and rollback (S27 FR-018, AS-80 to AS-85). */
@Injectable()
export class LifecycleService {
  private readonly logger = new Logger('StoryLifecycle');

  constructor(
    @Inject(STORY_REPOSITORY) private readonly stories: StoryRepository,
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(TRANSITION_REPOSITORY)
    private readonly transitions: TransitionRepository,
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly identity: ShopIdentity,
    private readonly writes: StoryWriteLimit,
  ) {}

  async archive(
    shopId: string,
    storyId: string,
    actorId: string,
  ): Promise<{ status: 'ARCHIVED' }> {
    await this.writes.take(shopId);
    const shop = await this.identity.resolve(shopId);
    const now = this.clock.now();
    const slug = await this.runner.run(async () => {
      const locked = await this.stories.lock(shopId, storyId);
      if (!locked) throw storyNotFound();
      if (nextStatus(locked.status, 'archive') === null)
        throw invalidTransition(locked.status);
      if (!(await this.stories.markArchived({ shopId, storyId, now })))
        throw invalidTransition(locked.status);
      await this.transitions.record({
        shopId,
        storyId,
        from: locked.status,
        to: 'ARCHIVED',
        action: 'archive',
        actor: actorId,
        now,
      });
      const version = locked.publishedVersion ?? 0;
      await this.outbox.append(
        StoryArchived.create(storyId, version, {
          storyId,
          shopId,
          shopSlug: shop.slug,
          slug: locked.slug,
          version,
        }),
      );
      return locked.slug;
    });
    try {
      await this.readModel.del(shop.slug, slug);
    } catch (error) {
      this.logger.warn(
        `origin cache not cleared after archive: ${(error as Error).name}`,
      );
    }
    logOutcome(this.logger, 'story.archive', {
      outcome: 'archived',
      storyId,
      shopId,
    });
    return { status: 'ARCHIVED' };
  }

  async listVersions(
    shopId: string,
    storyId: string,
    query: { limit: number; cursor?: string },
  ): Promise<{ items: StoryVersionListItemDto[]; nextCursor: string | null }> {
    if (!(await this.stories.find(shopId, storyId))) throw storyNotFound();
    let before: number | undefined;
    if (query.cursor !== undefined) {
      before = decodeVersionCursor(query.cursor) ?? undefined;
      if (before === undefined)
        throw validationFailed([{ field: 'cursor', code: 'invalid' }]);
    }
    const page = await this.versions.list(shopId, storyId, {
      limit: query.limit + 1,
      before,
    });
    const items = page.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map((v) => ({
        version: v.version,
        locales: v.locales,
        publishedAt: new Date(v.publishedAt).toISOString(),
        publishedBy: v.publishedBy,
      })),
      nextCursor:
        page.length > query.limit && last
          ? encodeVersionCursor(last.version)
          : null,
    };
  }

  async version(
    shopId: string,
    storyId: string,
    version: number,
  ): Promise<StoryVersionDto> {
    if (!(await this.stories.find(shopId, storyId))) throw storyNotFound();
    const rows = await this.versions.rows(shopId, storyId, version);
    if (rows.length === 0) throw versionNotFound();
    return {
      version,
      publishedAt: new Date(rows[0].publishedAt).toISOString(),
      publishedBy: rows[0].publishedBy,
      locales: rows.map((r) => ({
        locale: r.locale,
        title: r.title,
        blocks: r.blocks,
        seo: r.seo,
      })),
    };
  }

  /** The drafts become exactly the version's locales; the live version, status and schedule are untouched (AS-85). */
  async restore(
    shopId: string,
    storyId: string,
    version: number,
  ): Promise<StoryAdminDto> {
    await this.writes.take(shopId);
    const now = this.clock.now();
    await this.runner.run(async () => {
      const locked = await this.stories.lock(shopId, storyId);
      if (!locked) throw storyNotFound();
      const rows = await this.versions.rows(shopId, storyId, version);
      if (rows.length === 0) throw versionNotFound();
      await this.drafts.replaceAll({
        shopId,
        storyId,
        rows: rows.map((r) => ({
          locale: r.locale,
          title: r.title,
          blocks: r.blocks,
          seo: r.seo,
        })),
        now,
      });
    });
    const story = await this.stories.find(shopId, storyId);
    if (!story) throw storyNotFound();
    return toAdminDto(story, await this.drafts.list(shopId, storyId));
  }
}

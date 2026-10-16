import { Inject, Injectable, Logger } from '@nestjs/common';
import type { StoryPublishResultDto } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { TransactionRunner } from '@app/infrastructure/context';
import type { Block } from '../domain/blocks';
import {
  StoryError,
  defaultLocaleMissing,
  dependencyUnavailable,
  noDrafts,
  nothingToPublish,
  storyNotFound,
  unknownProductReference,
  versionConflict,
} from '../domain/errors';
import {
  DRAFT_REPOSITORY,
  PRODUCT_REFERENCE_CHECKER,
  READ_MODEL,
  STORY_REPOSITORY,
  TRANSITION_REPOSITORY,
  VERSION_REPOSITORY,
  type DraftRecord,
  type DraftRepository,
  type ProductReferenceChecker,
  type ReadModel,
  type StoryRecord,
  type StoryRepository,
  type TransitionRepository,
  type VersionRepository,
} from '../domain/ports';
import { StoryPublished } from './events/story-events';
import { ShopIdentity } from './shop-identity.service';
import { logOutcome } from './story-log';
import { storyMetrics } from './story-metrics';
import { StoryWriteLimit } from './story-limits';

/** A permanent failure at fire time that is not a `StoryError`: the shop cannot publish any more. */
export class ShopNotActiveError extends Error {
  readonly storyCode = 'shop_not_active';
  constructor() {
    super('shop is not active');
    this.name = 'ShopNotActiveError';
  }
}

export interface ExecuteOptions {
  shopId: string;
  storyId: string;
  /** The user publishing; a scheduled run publishes as the user who scheduled. */
  actorId: string | null;
  /** The version the caller saw; absent for a scheduled run (its guard is the schedule). */
  expectedVersion?: number;
  /** A scheduled run: publish only when the story is still scheduled at exactly this time and it is due. */
  fire?: { scheduledAt: Date };
}

export type ExecuteResult =
  { kind: 'published'; dto: StoryPublishResultDto } | { kind: 'skipped' };

/** The product references changed between the check and the lock: check again. */
class StaleReferenceCheck extends Error {}

/** Key order of an object never matters to "is this the same content" (jsonb reorders keys). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const contentOf = (
  rows: { locale: string; title: string; blocks: Block[]; seo: unknown }[],
) =>
  canonicalJson(
    Object.fromEntries(
      rows.map((r) => [
        r.locale,
        { title: r.title, blocks: r.blocks, seo: r.seo },
      ]),
    ),
  );

const productIdsOf = (drafts: DraftRecord[]): string[] => [
  ...new Set(
    drafts.flatMap((d) =>
      d.blocks.flatMap((b) => (b.type === 'product' ? [b.productId] : [])),
    ),
  ),
];

/**
 * Publish (S27 FR-010 to FR-012): freezes every locale draft into the next gapless version, in one transaction with the
 * pointer, the history row and `story.published`. The product references are checked through S05 before the
 * transaction (no network call inside one); everything else is decided under the row lock of the story, so concurrent
 * publishes, archives and scheduled runs serialise and exactly one wins.
 */
@Injectable()
export class PublishService {
  private readonly logger = new Logger('StoryPublish');

  constructor(
    @Inject(STORY_REPOSITORY) private readonly stories: StoryRepository,
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(TRANSITION_REPOSITORY)
    private readonly transitions: TransitionRepository,
    @Inject(PRODUCT_REFERENCE_CHECKER)
    private readonly products: ProductReferenceChecker,
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly identity: ShopIdentity,
    private readonly writes: StoryWriteLimit,
  ) {}

  /** Publish now (the route without `at`). */
  async publish(
    shopId: string,
    storyId: string,
    actorId: string,
    expectedVersion: number,
  ): Promise<StoryPublishResultDto> {
    await this.writes.take(shopId);
    const result = await this.execute({
      shopId,
      storyId,
      actorId,
      expectedVersion,
    });
    if (result.kind !== 'published') throw storyNotFound();
    return result.dto;
  }

  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    try {
      const result = await this.run(options);
      if (result.kind === 'published') {
        storyMetrics.publish.add(1, { result: 'published' });
        logOutcome(this.logger, 'story.publish', {
          outcome: 'published',
          storyId: options.storyId,
          shopId: options.shopId,
          version: result.dto.version ?? undefined,
        });
      }
      return result;
    } catch (error) {
      const outcome = this.outcome(error);
      if (!options.fire) storyMetrics.publish.add(1, { result: outcome });
      logOutcome(this.logger, options.fire ? 'story.fire' : 'story.publish', {
        outcome,
        storyId: options.storyId,
        shopId: options.shopId,
        code: error instanceof StoryError ? error.storyCode : undefined,
      });
      throw error;
    }
  }

  private outcome(error: unknown): string {
    if (error instanceof StoryError)
      return error.storyCode === 'version_conflict' ? 'conflict' : 'refused';
    return 'failed';
  }

  private async run(options: ExecuteOptions): Promise<ExecuteResult> {
    const { shopId, storyId } = options;
    for (let round = 0; round < 3; round++) {
      const story = await this.stories.find(shopId, storyId);
      if (!story) throw storyNotFound();
      if (options.fire && !this.fireable(story, options.fire.scheduledAt))
        return { kind: 'skipped' };
      if (
        options.expectedVersion !== undefined &&
        (story.publishedVersion ?? 0) !== options.expectedVersion
      )
        throw versionConflict(story.publishedVersion ?? 0);

      const drafts = await this.drafts.list(shopId, storyId);
      this.assertPublishable(story, drafts);
      const shop = await this.identity.resolve(shopId);
      if (options.fire && shop.status !== 'ACTIVE')
        throw new ShopNotActiveError();
      const checked = productIdsOf(drafts);
      await this.assertProducts(shopId, checked);

      try {
        return await this.commit(options, shop.slug, new Set(checked));
      } catch (error) {
        if (error instanceof StaleReferenceCheck) continue;
        throw error;
      }
    }
    throw dependencyUnavailable();
  }

  /** A scheduled run needs the same schedule it was made for, and the time to have come. */
  private fireable(story: StoryRecord, scheduledAt: Date): boolean {
    return (
      story.scheduledAt !== null &&
      story.scheduledAt.getTime() === scheduledAt.getTime() &&
      this.clock.now().getTime() >= story.scheduledAt.getTime()
    );
  }

  private assertPublishable(story: StoryRecord, drafts: DraftRecord[]): void {
    if (drafts.length === 0) throw noDrafts();
    if (!drafts.some((d) => d.locale === story.defaultLocale))
      throw defaultLocaleMissing();
  }

  private async assertProducts(shopId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    let missing: string[];
    try {
      missing = await this.products.missing(shopId, ids);
    } catch {
      throw dependencyUnavailable();
    }
    if (missing.length > 0) throw unknownProductReference(missing);
  }

  private async commit(
    options: ExecuteOptions,
    shopSlug: string,
    checked: Set<string>,
  ): Promise<ExecuteResult> {
    const { shopId, storyId } = options;
    const done = await this.runner.run(
      async (): Promise<{
        result: ExecuteResult;
        slug: string;
      }> => {
        const now = this.clock.now();
        const locked = await this.stories.lock(shopId, storyId);
        if (!locked) throw storyNotFound();
        if (options.fire && !this.fireable(locked, options.fire.scheduledAt))
          return { result: { kind: 'skipped' }, slug: locked.slug };
        if (
          options.expectedVersion !== undefined &&
          (locked.publishedVersion ?? 0) !== options.expectedVersion
        )
          throw versionConflict(locked.publishedVersion ?? 0);

        const drafts = await this.drafts.list(shopId, storyId);
        this.assertPublishable(locked, drafts);
        if (productIdsOf(drafts).some((id) => !checked.has(id)))
          throw new StaleReferenceCheck();

        if (locked.status === 'PUBLISHED' && locked.publishedVersion !== null) {
          const live = await this.versions.rows(
            shopId,
            storyId,
            locked.publishedVersion,
          );
          if (contentOf(live) === contentOf(drafts)) throw nothingToPublish();
        }

        const version = (await this.versions.latest(shopId, storyId)) + 1;
        const actor = options.fire ? locked.scheduledBy : options.actorId;
        const locales = await this.versions.insertFromDrafts({
          shopId,
          storyId,
          version,
          now,
          publishedBy: actor,
        });
        const moved = await this.stories.markPublished({
          shopId,
          storyId,
          from: locked.status,
          fromVersion: locked.publishedVersion,
          version,
          now,
        });
        if (!moved) throw versionConflict(locked.publishedVersion ?? 0);
        await this.transitions.record({
          shopId,
          storyId,
          from: locked.status,
          to: 'PUBLISHED',
          action: options.fire ? 'fire' : 'publish',
          actor,
          now,
        });
        await this.outbox.append(
          StoryPublished.create(storyId, version, {
            storyId,
            shopId,
            shopSlug,
            slug: locked.slug,
            version,
            locales,
          }),
        );
        return {
          result: {
            kind: 'published',
            dto: {
              status: 'PUBLISHED',
              version,
              locales,
              publishedAt: now.toISOString(),
              scheduledAt: null,
            },
          },
          slug: locked.slug,
        };
      },
    );
    if (done.result.kind === 'published')
      await this.clearOrigin(shopSlug, done.slug);
    return done.result;
  }

  /** Right after the commit; a cache that cannot be reached never fails the request (the consumer clears it again). */
  private async clearOrigin(shopSlug: string, slug: string): Promise<void> {
    try {
      await this.readModel.del(shopSlug, slug);
    } catch (error) {
      this.logger.warn(
        `origin cache not cleared after publish: ${(error as Error).name}`,
      );
    }
  }
}

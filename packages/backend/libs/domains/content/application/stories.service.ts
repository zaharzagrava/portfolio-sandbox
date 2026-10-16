import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  StoryAdminDto,
  StoryListItemDto,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { decodeStoryCursor, encodeStoryCursor } from '../domain/cursor';
import {
  slugTaken,
  storyLimitReached,
  storyNotFound,
  validationFailed,
} from '../domain/errors';
import type { StoryConfig } from '../domain/limits';
import {
  DRAFT_REPOSITORY,
  STORY_REPOSITORY,
  TRANSITION_REPOSITORY,
  type DraftRepository,
  type StoryRepository,
  type TransitionRepository,
} from '../domain/ports';
import { parseCreateStory } from '../domain/story-input';
import type { StoryStatus } from '../domain/story-status';
import { toAdminDto, toListItem } from './mappers';
import { STORY_CONFIG } from './story-config.token';
import { StoryWriteLimit } from './story-limits';

/** Stories: create, list and read (S27 FR-001, FR-006). */
@Injectable()
export class StoriesService {
  constructor(
    @Inject(STORY_REPOSITORY) private readonly stories: StoryRepository,
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(TRANSITION_REPOSITORY)
    private readonly transitions: TransitionRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORY_CONFIG) private readonly config: StoryConfig,
    private readonly runner: TransactionRunner,
    private readonly writes: StoryWriteLimit,
  ) {}

  async create(
    shopId: string,
    actorId: string,
    body: unknown,
  ): Promise<StoryAdminDto> {
    const input = parseCreateStory(body);
    if (!input.ok) throw validationFailed(input.issues);
    await this.writes.take(shopId);
    const now = this.clock.now();
    const id = uuidv7();
    const outcome = await this.runner.run(async () => {
      const result = await this.stories.insert({
        id,
        shopId,
        slug: input.value.slug,
        defaultLocale: input.value.defaultLocale,
        now,
        limit: this.config.maxStoriesPerShop,
      });
      if (result === 'created')
        await this.transitions.record({
          shopId,
          storyId: id,
          from: null,
          to: 'DRAFT',
          action: 'create',
          actor: actorId,
          now,
        });
      return result;
    });
    if (outcome === 'slug_taken') throw slugTaken();
    if (outcome === 'limit_reached')
      throw storyLimitReached(this.config.maxStoriesPerShop);
    const story = await this.stories.find(shopId, id);
    if (!story) throw storyNotFound();
    return toAdminDto(story);
  }

  async list(
    shopId: string,
    query: { status?: StoryStatus; limit: number; cursor?: string },
  ): Promise<{ items: StoryListItemDto[]; nextCursor: string | null }> {
    let after;
    if (query.cursor !== undefined) {
      after = decodeStoryCursor(query.cursor) ?? undefined;
      if (!after)
        throw validationFailed([{ field: 'cursor', code: 'invalid' }]);
    }
    const page = await this.stories.list(shopId, {
      status: query.status,
      limit: query.limit + 1,
      after,
    });
    const items = page.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items: items.map(toListItem),
      nextCursor:
        page.length > query.limit && last
          ? encodeStoryCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async detail(shopId: string, storyId: string): Promise<StoryAdminDto> {
    const story = await this.stories.find(shopId, storyId);
    if (!story) throw storyNotFound();
    return toAdminDto(story, await this.drafts.list(shopId, storyId));
  }
}

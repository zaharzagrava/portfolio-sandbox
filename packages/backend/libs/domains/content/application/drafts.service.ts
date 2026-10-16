import { Inject, Injectable } from '@nestjs/common';
import type { StoryDraftDto } from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { parseBlocks, parseSeo } from '../domain/blocks';
import {
  defaultLocaleRequired,
  draftNotFound,
  invalidBlocks,
  invalidTitle,
  localeLimitReached,
  payloadTooLarge,
  revisionConflict,
  storyNotFound,
  validationFailed,
} from '../domain/errors';
import { LIMITS, type StoryConfig } from '../domain/limits';
import {
  DRAFT_REPOSITORY,
  STORY_REPOSITORY,
  type DraftRepository,
  type StoryRepository,
} from '../domain/ports';
import { parseDraftInput } from '../domain/story-input';
import { toDraftDto } from './mappers';
import { STORY_CONFIG } from './story-config.token';
import { StoryWriteLimit } from './story-limits';

/** Locale drafts: optimistic concurrency by revision, sanitised blocks, per-draft limits (S27 FR-002 to FR-005). */
@Injectable()
export class DraftsService {
  constructor(
    @Inject(STORY_REPOSITORY) private readonly stories: StoryRepository,
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORY_CONFIG) private readonly config: StoryConfig,
    private readonly runner: TransactionRunner,
    private readonly writes: StoryWriteLimit,
  ) {}

  async save(
    shopId: string,
    storyId: string,
    locale: string,
    body: unknown,
  ): Promise<StoryDraftDto> {
    const input = parseDraftInput(body);
    if (!input.ok) throw validationFailed(input.issues);
    await this.writes.take(shopId);

    const { title, expectedRevision } = input.value;
    if (title.length < 1 || title.length > LIMITS.maxTitleLength)
      throw invalidTitle();
    const blocks = parseBlocks(input.value.blocks, this.config.maxBlocks);
    if (!blocks.ok) throw invalidBlocks(blocks.issues);
    const seo = parseSeo(input.value.seo);
    if (!seo.ok)
      throw invalidBlocks(
        seo.issues.map((i) => ({ path: `seo.${i.path}`, code: i.code })),
      );
    if (
      Buffer.byteLength(
        JSON.stringify({ title, blocks: blocks.value, seo: seo.value }),
      ) > this.config.maxDraftBytes
    )
      throw payloadTooLarge();

    const now = this.clock.now();
    const saved = await this.runner.run(async () => {
      // the story row is the lock of its drafts' locale count, so 20 concurrent new locales cannot all fit
      const story =
        expectedRevision === 0
          ? await this.stories.lock(shopId, storyId)
          : await this.stories.find(shopId, storyId);
      if (!story) throw storyNotFound();
      const fields = {
        shopId,
        storyId,
        locale,
        title,
        blocks: blocks.value,
        seo: seo.value,
        now,
      };
      if (expectedRevision === 0) {
        const existing = await this.drafts.find(shopId, storyId, locale);
        if (existing) throw revisionConflict(existing.revision);
        if (
          (await this.drafts.count(shopId, storyId)) >= this.config.maxLocales
        )
          throw localeLimitReached(this.config.maxLocales);
        const created = await this.drafts.insert(fields);
        if (created) return created;
      } else {
        const updated = await this.drafts.update({
          ...fields,
          expectedRevision,
        });
        if (updated) return updated;
      }
      const current = await this.drafts.find(shopId, storyId, locale);
      throw revisionConflict(current?.revision ?? 0);
    });
    return toDraftDto(saved);
  }

  async remove(
    shopId: string,
    storyId: string,
    locale: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.writes.take(shopId);
    await this.runner.run(async () => {
      const story = await this.stories.lock(shopId, storyId);
      if (!story) throw storyNotFound();
      if (locale === story.defaultLocale) throw defaultLocaleRequired();
      const draft = await this.drafts.find(shopId, storyId, locale);
      if (!draft) throw draftNotFound();
      const deleted = await this.drafts.delete({
        shopId,
        storyId,
        locale,
        expectedRevision,
      });
      if (!deleted) throw revisionConflict(draft.revision);
    });
  }
}

import type {
  PublicStoryDto,
  StoryAdminDto,
  StoryDraftDto,
  StoryListItemDto,
} from '@marketplace-sandbox/contracts';
import type { DraftRecord, StoryRecord } from '../domain/ports';

const iso = (value: Date | string): string => new Date(value).toISOString();

export const toDraftDto = (draft: DraftRecord): StoryDraftDto => ({
  locale: draft.locale,
  revision: draft.revision,
  title: draft.title,
  blocks: draft.blocks,
  seo: draft.seo,
  updatedAt: iso(draft.updatedAt),
});

export const toListItem = (story: StoryRecord): StoryListItemDto => ({
  id: story.id,
  shopId: story.shopId,
  slug: story.slug,
  defaultLocale: story.defaultLocale,
  status: story.status,
  publishedVersion: story.publishedVersion,
  scheduledAt: story.scheduledAt ? iso(story.scheduledAt) : null,
  scheduleFailure: story.scheduleFailure,
  createdAt: iso(story.createdAt),
});

export const toAdminDto = (
  story: StoryRecord,
  drafts?: DraftRecord[],
): StoryAdminDto => ({
  ...toListItem(story),
  ...(drafts ? { drafts: drafts.map(toDraftDto) } : {}),
});

export type { PublicStoryDto };

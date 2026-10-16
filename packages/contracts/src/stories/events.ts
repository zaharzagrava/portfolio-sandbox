import { z } from 'zod';

/** Topic `stories.events` payloads (specs/domains/S27-brand-stories/data-model.md). */
export const storyEventSchemas = {
  'story.published': z.object({
    storyId: z.string().uuid(),
    shopId: z.string().uuid(),
    shopSlug: z.string(),
    slug: z.string(),
    version: z.number().int(),
    locales: z.array(z.string()),
  }),
  'story.archived': z.object({
    storyId: z.string().uuid(),
    shopId: z.string().uuid(),
    shopSlug: z.string(),
    slug: z.string(),
    version: z.number().int(),
  }),
  'story.schedule_failed': z.object({
    storyId: z.string().uuid(),
    shopId: z.string().uuid(),
    scheduledAt: z.string(),
    code: z.string(),
  }),
} as const;

export const storyPublishedPayloadSchema = storyEventSchemas['story.published'];
export const storyArchivedPayloadSchema = storyEventSchemas['story.archived'];
export const storyScheduleFailedPayloadSchema =
  storyEventSchemas['story.schedule_failed'];

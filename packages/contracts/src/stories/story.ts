import { z } from 'zod';
import { storyBlockSchema, storySeoSchema } from './blocks.ts';

export const STORY_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const storyStatusSchema = z.enum(STORY_STATUSES);

const uuid = z.string().uuid();

export const storyScheduleFailureSchema = z.object({
  at: z.string(),
  code: z.string(),
});

/** A locale draft as staff read and write it. */
export const storyDraftSchema = z
  .object({
    locale: z.string(),
    revision: z.number().int().min(1),
    title: z.string(),
    blocks: z.array(storyBlockSchema),
    seo: storySeoSchema,
    updatedAt: z.string(),
  })
  .strict();
export type StoryDraftDto = z.infer<typeof storyDraftSchema>;

const storyFields = {
  id: uuid,
  shopId: uuid,
  slug: z.string(),
  defaultLocale: z.string(),
  status: storyStatusSchema,
  publishedVersion: z.number().int().nullable(),
  scheduledAt: z.string().nullable(),
  scheduleFailure: storyScheduleFailureSchema.nullable(),
  createdAt: z.string(),
};

/** Create answer and staff detail (the detail adds `drafts`). */
export const storyAdminSchema = z
  .object({ ...storyFields, drafts: z.array(storyDraftSchema).optional() })
  .strict();
export type StoryAdminDto = z.infer<typeof storyAdminSchema>;

export const storyListItemSchema = z.object({ ...storyFields }).strict();
export type StoryListItemDto = z.infer<typeof storyListItemSchema>;

export const storyPublishResultSchema = z
  .object({
    status: storyStatusSchema,
    version: z.number().int().nullable(),
    locales: z.array(z.string()),
    publishedAt: z.string().nullable(),
    scheduledAt: z.string().nullable(),
  })
  .strict();
export type StoryPublishResultDto = z.infer<typeof storyPublishResultSchema>;

export const storyArchiveResultSchema = z
  .object({ status: storyStatusSchema })
  .strict();

const LOCALE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** Request bodies. */
export const createStoryRequestSchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/),
    defaultLocale: z.string().regex(LOCALE).optional(),
  })
  .strict();

export const saveDraftRequestSchema = z
  .object({
    title: z.string(),
    blocks: z.array(z.unknown()),
    seo: z.record(z.string(), z.unknown()).optional(),
    expectedRevision: z.number().int().min(0),
  })
  .strict();

export const storyPublishRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const previewTokenRequestSchema = z
  .object({ locale: z.string().regex(LOCALE) })
  .strict();

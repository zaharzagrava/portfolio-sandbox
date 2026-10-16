import { z } from 'zod';
import { storyBlockSchema, storySeoSchema } from './blocks.ts';

export const storyVersionListItemSchema = z
  .object({
    version: z.number().int().min(1),
    locales: z.array(z.string()),
    publishedAt: z.string(),
    publishedBy: z.string().nullable(),
  })
  .strict();

export type StoryVersionListItemDto = z.infer<
  typeof storyVersionListItemSchema
>;

export const storyVersionSchema = z
  .object({
    version: z.number().int().min(1),
    publishedAt: z.string(),
    publishedBy: z.string().nullable(),
    locales: z.array(
      z.object({
        locale: z.string(),
        title: z.string(),
        blocks: z.array(storyBlockSchema),
        seo: storySeoSchema,
      }),
    ),
  })
  .strict();

export type StoryVersionDto = z.infer<typeof storyVersionSchema>;

import { z } from 'zod';
import { storyBlockSchema, storySeoSchema } from './blocks.ts';

/** The public story, also the shape of a preview (`preview: true`, `version: null`, `alternates: []`). */
export const publicStorySchema = z
  .object({
    id: z.string().uuid(),
    shopId: z.string().uuid(),
    slug: z.string(),
    version: z.number().int().nullable(),
    locale: z.string(),
    title: z.string(),
    blocks: z.array(storyBlockSchema),
    seo: storySeoSchema,
    canonical: z.string(),
    alternates: z.array(z.object({ locale: z.string(), href: z.string() })),
    publishedAt: z.string().nullable(),
    preview: z.boolean(),
  })
  .strict();
export type PublicStoryDto = z.infer<typeof publicStorySchema>;

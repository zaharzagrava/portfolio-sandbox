import { z } from 'zod';

/** Typed content blocks as stored and served (S27 FR-004). Validation rules that need parsing (hosts) live in the backend. */
export const storyBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    level: z.union([z.literal(2), z.literal(3)]),
    text: z.string(),
  }),
  z.object({ type: z.literal('richText'), html: z.string() }),
  z.object({
    type: z.literal('image'),
    url: z.string(),
    alt: z.string(),
    width: z.number().int(),
    height: z.number().int(),
  }),
  z.object({ type: z.literal('product'), productId: z.string() }),
  z.object({
    type: z.literal('quote'),
    text: z.string(),
    cite: z.string().optional(),
  }),
  z.object({ type: z.literal('video'), url: z.string() }),
]);
export type StoryBlockDto = z.infer<typeof storyBlockSchema>;

export const storySeoSchema = z.object({
  description: z.string().optional(),
  ogImage: z.string().optional(),
});

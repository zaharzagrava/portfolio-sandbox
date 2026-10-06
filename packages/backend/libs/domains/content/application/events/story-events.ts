import { z } from 'zod';
import { defineEvent } from '@app/infrastructure/events/define-event';

export const StoryPublished = defineEvent('story.published', 'stories', 1, z.object({
  storyId: z.string(),
  shopId: z.string(),
  slug: z.string(),
  version: z.number().int(),
  locales: z.array(z.string()),
}));

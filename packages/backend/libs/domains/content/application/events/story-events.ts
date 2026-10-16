import { storyEventSchemas } from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * S27 events (contracts/interfaces.md): topic `stories.events` (aggregate `stories`), key `storyId`. The payload shapes
 * are `storyEventSchemas` from `packages/contracts`. Events carry changes, so the topic keeps full history.
 */
export const StoryPublished = defineEvent(
  'story.published',
  'stories',
  1,
  storyEventSchemas['story.published'],
);

export const StoryArchived = defineEvent(
  'story.archived',
  'stories',
  1,
  storyEventSchemas['story.archived'],
);

export const StoryScheduleFailed = defineEvent(
  'story.schedule_failed',
  'stories',
  1,
  storyEventSchemas['story.schedule_failed'],
);

export const STORIES_AGGREGATE: TopicRegistration = {
  aggregateType: 'stories',
  retention: 'full-history',
};

import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/stories.jobs.ts) so an app that only enqueues loads the declarations without the
// worker code (S49 follow-up: `declareJobType` next to the `JobPayloads` augmentation).
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    /** A scheduled reveal; `scheduledAt` is the ISO time the schedule was made for (a stale job does nothing). */
    'stories.publish': { storyId: string; scheduledAt: string };
    /** Every minute: publishes any due schedule whose job was lost. */
    'stories.publish-due-sweep': Record<string, never>;
  }
}

declareJobType({
  name: 'stories.publish',
  contract: z.object({ storyId: z.string().uuid(), scheduledAt: z.string() }),
});
declareJobType({
  name: 'stories.publish-due-sweep',
  contract: z.object({}),
});

export const STORY_PUBLISH_JOB = 'stories.publish' as const;
export const STORY_SWEEP_JOB = 'stories.publish-due-sweep' as const;
export const storyPublishJobKey = (storyId: string, scheduledAtIso: string) =>
  `story-publish:${storyId}:${scheduledAtIso}`;

/** Story status model (S27 "Status model"). `SCHEDULED` is not a status: a schedule is the attribute `scheduledAt`. */
export const STORY_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

export type StoryAction = 'publish' | 'archive';

/** The history actions recorded in `StoryTransition`. */
export const TRANSITION_ACTIONS = [
  'create',
  'publish',
  'schedule',
  'cancel_schedule',
  'fire',
  'fire_failed',
  'archive',
] as const;
export type TransitionAction = (typeof TRANSITION_ACTIONS)[number];

export function assertNever(value: never): never {
  throw new Error(`unhandled value ${String(value)}`);
}

/** The status after `action`, or `null` when the move is illegal (`409 invalid_transition`). */
export function nextStatus(
  from: StoryStatus,
  action: StoryAction,
): StoryStatus | null {
  switch (action) {
    case 'publish':
      return from === 'DRAFT' || from === 'PUBLISHED' || from === 'ARCHIVED'
        ? 'PUBLISHED'
        : null;
    case 'archive':
      return from === 'PUBLISHED' ? 'ARCHIVED' : null;
    default:
      return null;
  }
}

/** A schedule never changes the status (FR-014): a scheduled republish does not take the live story offline. */
export const statusAfterSchedule = (status: StoryStatus): StoryStatus => status;

import {
  STORY_STATUSES,
  nextStatus,
  statusAfterSchedule,
  type StoryAction,
  type StoryStatus,
} from './story-status';

const ACTIONS: StoryAction[] = ['publish', 'archive'];

describe('S27 story status table', () => {
  const allowed: [StoryStatus, StoryAction, StoryStatus][] = [
    ['DRAFT', 'publish', 'PUBLISHED'],
    ['PUBLISHED', 'publish', 'PUBLISHED'],
    ['ARCHIVED', 'publish', 'PUBLISHED'],
    ['PUBLISHED', 'archive', 'ARCHIVED'],
  ];

  it.each(allowed)('S27 AS-82: %s + %s → %s', (from, action, to) => {
    expect(nextStatus(from, action)).toBe(to);
  });

  it.each([
    ['DRAFT', 'archive'],
    ['ARCHIVED', 'archive'],
  ] as [StoryStatus, StoryAction][])(
    'S27 AS-82: %s + %s is invalid_transition',
    (from, action) => {
      expect(nextStatus(from, action)).toBeNull();
    },
  );

  it('S27 AS-82: the table is total and deterministic over every status and action', () => {
    const cells = STORY_STATUSES.flatMap((s) =>
      ACTIONS.map((a) => [s, a] as const),
    );
    expect(cells).toHaveLength(6);
    for (const [s, a] of cells) {
      const first = nextStatus(s, a);
      expect(nextStatus(s, a)).toBe(first);
      const listed = allowed.some(([f, act]) => f === s && act === a);
      expect(first !== null).toBe(listed);
    }
  });

  it('S27 AS-82: an unknown status or action never passes', () => {
    expect(nextStatus('SCHEDULED' as StoryStatus, 'publish')).toBeNull();
    expect(nextStatus('DRAFT', 'delete' as StoryAction)).toBeNull();
  });

  it.each(STORY_STATUSES)(
    'S27 AS-45: scheduling leaves %s unchanged',
    (status) => {
      expect(statusAfterSchedule(status)).toBe(status);
    },
  );
});

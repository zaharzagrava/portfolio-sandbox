import { describe, expect, it } from 'vitest';
import { formatDiscussionTime } from '@/lib/discussions-time';

const now = new Date('2026-10-14T12:00:00.000Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatDiscussionTime', () => {
  it.each([
    [10_000, 'just now'],
    [MIN, '1 minute ago'],
    [5 * MIN, '5 minutes ago'],
    [59 * MIN, '59 minutes ago'],
    [HOUR, '1 hour ago'],
    [3 * HOUR, '3 hours ago'],
    [23 * HOUR, '23 hours ago'],
    [DAY, '1 day ago'],
    [30 * DAY, '30 days ago'],
  ])('W02 FR-091: %d ms ago reads "%s"', (elapsed, text) => {
    expect(formatDiscussionTime(ago(elapsed), now).text).toBe(text);
  });

  it('W02 FR-091: past 30 days it is "Mon D, YYYY" and the exact instant is in title and datetime', () => {
    const result = formatDiscussionTime('2026-08-01T10:15:00.000Z', now);
    expect(result.text).toBe('Aug 1, 2026');
    expect(result.dateTime).toBe('2026-08-01T10:15:00.000Z');
    expect(result.title).toContain('2026');
    expect(result.title).toContain('10:15');
  });

  it('W02 FR-091: a time in the future reads "just now" and an invalid value reads nothing', () => {
    expect(formatDiscussionTime(new Date(now.getTime() + HOUR).toISOString(), now).text).toBe('just now');
    expect(formatDiscussionTime('not a date', now).text).toBe('');
  });
});

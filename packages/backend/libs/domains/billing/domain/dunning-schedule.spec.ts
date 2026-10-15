import { nextAttemptAt } from './dunning-schedule';

const at = (iso: string | null) => (iso ? new Date(iso) : null);

describe('S17 AS-43: the dunning schedule is a pure function', () => {
  it.each([
    {
      first: '2026-04-10T12:00:10.000Z',
      attempt: 1,
      next: '2026-04-11T12:00:10.000Z',
    },
    {
      first: '2026-04-10T12:00:10.000Z',
      attempt: 2,
      next: '2026-04-13T12:00:10.000Z',
    },
    {
      first: '2026-04-10T12:00:10.000Z',
      attempt: 3,
      next: '2026-04-17T12:00:10.000Z',
    },
    { first: '2026-04-10T12:00:10.000Z', attempt: 4, next: null },
    { first: '2026-04-10T12:00:10.000Z', attempt: 9, next: null },
    {
      first: '2026-01-30T23:59:59.999Z',
      attempt: 1,
      next: '2026-01-31T23:59:59.999Z',
    },
    {
      first: '2026-02-26T08:00:00.000Z',
      attempt: 2,
      next: '2026-03-01T08:00:00.000Z',
    },
    {
      first: '2028-02-25T00:00:00.000Z',
      attempt: 3,
      next: '2028-03-03T00:00:00.000Z',
    },
    {
      first: '2026-12-29T10:00:00.000Z',
      attempt: 3,
      next: '2027-01-05T10:00:00.000Z',
    },
  ])(
    'S17 AS-43: first failure $first, attempt $attempt failed -> $next',
    ({ first, attempt, next }) => {
      expect(nextAttemptAt(new Date(first), attempt)).toEqual(at(next));
    },
  );

  it('S17 AS-43: depends only on the first failure, never on when an attempt ran (a late attempt changes nothing)', () => {
    const first = new Date('2026-04-10T12:00:10.000Z');
    // attempt 2 executed 30 s late still schedules attempt 3 at first + 3 days: the function has no other input.
    expect(nextAttemptAt(first, 2)).toEqual(
      new Date('2026-04-13T12:00:10.000Z'),
    );
    expect(nextAttemptAt.length).toBe(2);
  });

  it('S17 AS-43: refuses attempt numbers below 1', () => {
    expect(() => nextAttemptAt(new Date(), 0)).toThrow();
  });
});

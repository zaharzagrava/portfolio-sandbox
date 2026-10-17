import { isTerminal, transition } from './version-state';
import type { VersionEvent, VersionState } from './version-state';

const states: VersionState[] = [
  { status: 'QUEUED' },
  { status: 'TESTING' },
  { status: 'ACTIVE' },
  { status: 'REJECTED' },
  { status: 'SUPERSEDED', passed: true },
  { status: 'SUPERSEDED', passed: false },
];
const events: VersionEvent[] = [
  { type: 'claim' },
  { type: 'passed', newerThanActive: true },
  { type: 'passed', newerThanActive: false },
  { type: 'failed' },
  { type: 'attemptsExhausted' },
  { type: 'newerActivated' },
  { type: 'rollback' },
];
const key = (s: VersionState, e: VersionEvent) =>
  `${s.status}${s.status === 'SUPERSEDED' && s.passed ? '(passed)' : ''} + ${e.type}${e.type === 'passed' ? (e.newerThanActive ? '(newer)' : '(older)') : ''}`;

describe('S45 AS-21: version state machine', () => {
  it.each<[string, VersionState, VersionEvent, string, string | null]>([
    ['QUEUED claim', { status: 'QUEUED' }, { type: 'claim' }, 'TESTING', null],
    [
      'TESTING passed newer',
      { status: 'TESTING' },
      { type: 'passed', newerThanActive: true },
      'ACTIVE',
      null,
    ],
    [
      'TESTING passed older',
      { status: 'TESTING' },
      { type: 'passed', newerThanActive: false },
      'SUPERSEDED',
      'stale',
    ],
    [
      'TESTING failed',
      { status: 'TESTING' },
      { type: 'failed' },
      'REJECTED',
      null,
    ],
    [
      'QUEUED exhausted',
      { status: 'QUEUED' },
      { type: 'attemptsExhausted' },
      'REJECTED',
      'judge_unavailable',
    ],
    [
      'TESTING exhausted',
      { status: 'TESTING' },
      { type: 'attemptsExhausted' },
      'REJECTED',
      'judge_unavailable',
    ],
    [
      'ACTIVE superseded by newer',
      { status: 'ACTIVE' },
      { type: 'newerActivated' },
      'SUPERSEDED',
      null,
    ],
    [
      'SUPERSEDED(passed) rollback',
      { status: 'SUPERSEDED', passed: true },
      { type: 'rollback' },
      'ACTIVE',
      'rollback',
    ],
  ])('%s', (_name, from, event, to, reason) => {
    const result = transition(from, event);
    expect(result?.to.status).toBe(to);
    expect(result?.reason).toBe(reason);
  });

  const allowed = new Set([
    'QUEUED + claim',
    'QUEUED + attemptsExhausted',
    'TESTING + passed(newer)',
    'TESTING + passed(older)',
    'TESTING + failed',
    'TESTING + attemptsExhausted',
    'ACTIVE + newerActivated',
    'SUPERSEDED(passed) + rollback',
  ]);
  const pairs = states.flatMap((s) => events.map((e) => [s, e] as const));

  it.each(pairs)('only the table pairs succeed: %j %j', (s, e) => {
    expect(transition(s, e) !== null).toBe(allowed.has(key(s, e)));
  });

  it('refuses a rollback of a superseded version that never passed, and any move out of REJECTED', () => {
    expect(
      transition({ status: 'SUPERSEDED', passed: false }, { type: 'rollback' }),
    ).toBeNull();
    for (const e of events)
      expect(transition({ status: 'REJECTED' }, e)).toBeNull();
  });

  it('an unknown status fails the exhaustive check', () => {
    expect(() =>
      transition({ status: 'WEIRD' } as unknown as VersionState, {
        type: 'claim',
      }),
    ).toThrow(/unhandled/);
  });

  it('knows terminal statuses', () => {
    expect(isTerminal('QUEUED')).toBe(false);
    expect(isTerminal('REJECTED')).toBe(true);
  });
});

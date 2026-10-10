import {
  JOB_EVENTS,
  JOB_STATUSES,
  IllegalJobTransitionError,
  JobEvent,
  JobStatus,
  describeStatus,
  isTerminal,
  nextStatus,
  sourceStatus,
} from './job-state';

/** Every legal (from, event) pair of the data-model table; all others must be rejected. */
const LEGAL: Array<[JobStatus, JobEvent, JobStatus]> = [
  ['QUEUED', 'claim', 'RUNNING'],
  ['RUNNING', 'complete', 'SUCCEEDED'],
  ['RUNNING', 'retry', 'QUEUED'],
  ['RUNNING', 'release', 'QUEUED'],
  ['RUNNING', 'reap', 'QUEUED'],
  ['RUNNING', 'fail', 'DEAD'],
  ['QUEUED', 'cancel', 'CANCELLED'],
  ['DEAD', 'operatorRetry', 'QUEUED'],
];

const ALL: Array<[JobStatus, JobEvent]> = JOB_STATUSES.flatMap((s) =>
  JOB_EVENTS.map((e) => [s, e] as [JobStatus, JobEvent]),
);
const ILLEGAL = ALL.filter(
  ([s, e]) => !LEGAL.some(([ls, le]) => ls === s && le === e),
);

describe('job state machine (S49)', () => {
  it.each(LEGAL)('S49 AS-38: %s --%s--> %s', (from, event, to) => {
    expect(nextStatus(from, event)).toBe(to);
  });

  it.each(ILLEGAL)('S49 AS-38: %s --%s--> is rejected', (from, event) => {
    expect(() => nextStatus(from, event)).toThrow(IllegalJobTransitionError);
  });

  it('S49 AS-38: every event has exactly one source status', () => {
    for (const event of JOB_EVENTS) {
      const sources = new Set(
        LEGAL.filter(([, e]) => e === event).map(([s]) => s),
      );
      expect(sources.size).toBe(1);
      expect(sourceStatus(event)).toBe([...sources][0]);
    }
  });

  it.each(JOB_STATUSES.map((s) => [s] as [JobStatus]))(
    'S49 AS-95: status %s is handled exhaustively',
    (status) => {
      expect(typeof describeStatus(status)).toBe('string');
      expect(typeof isTerminal(status)).toBe('boolean');
    },
  );

  it('S49 AS-95: terminal statuses are SUCCEEDED and CANCELLED; DEAD can be retried by an operator', () => {
    expect(JOB_STATUSES.filter(isTerminal)).toEqual(['SUCCEEDED', 'CANCELLED']);
  });
});

import {
  DEFAULT_MAX_ATTEMPTS,
  resolveMaxAttempts,
  validateEnqueueOptions,
} from './enqueue-options';
import { InvalidEnqueueOptionsError } from './job-errors';
import type { JobPayloads, JobType } from './job-types';
import type { JobsService } from './jobs.service';

const NOW = new Date('2026-10-09T10:00:00.000Z');
const DAY = 86_400_000;
const ok = (
  o: Parameters<typeof validateEnqueueOptions>[0],
  payload: unknown = {},
) => validateEnqueueOptions(o, payload, NOW);

describe('enqueue option limits (S49)', () => {
  it.each([
    ['empty payload', {}],
    ['payload at 64 KiB', { s: 'x'.repeat(65_536 - 8) }],
  ])('S49 AS-07: accepts %s', (_name, payload) => {
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(65_536);
    expect(() => ok({}, payload)).not.toThrow();
  });

  it('S49 AS-07: rejects a payload over 64 KiB serialised', () => {
    expect(() => ok({}, { s: 'x'.repeat(65_536) })).toThrow(
      expect.objectContaining({ field: 'payload' }),
    );
  });

  it('S49 AS-07: counts bytes, not characters', () => {
    expect(() => ok({}, { s: '€'.repeat(30_000) })).toThrow(
      InvalidEnqueueOptionsError,
    );
  });

  it.each([
    ['1 char', 'a', true],
    ['200 chars', 'k'.repeat(200), true],
    ['empty', '', false],
    ['201 chars', 'k'.repeat(201), false],
  ])('S49 AS-07: idempotency key %s', (_name, key, valid) => {
    const run = () => ok({ idempotencyKey: key });
    if (valid) expect(run).not.toThrow();
    else
      expect(run).toThrow(expect.objectContaining({ field: 'idempotencyKey' }));
  });

  it.each([
    [1, true],
    [25, true],
    [0, false],
    [26, false],
    [2.5, false],
    [NaN, false],
  ])('S49 AS-07: maxAttempts %s valid=%s', (value, valid) => {
    const run = () => ok({ maxAttempts: value });
    if (valid) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ field: 'maxAttempts' }));
  });

  it.each([
    ['now', NOW, true],
    ['in the past', new Date(NOW.getTime() - 400 * DAY), true],
    ['exactly 366 days ahead', new Date(NOW.getTime() + 366 * DAY), true],
    ['366 days and 1 ms ahead', new Date(NOW.getTime() + 366 * DAY + 1), false],
    ['invalid date', new Date('nope'), false],
  ])('S49 AS-07: runAt %s valid=%s', (_name, runAt, valid) => {
    const run = () => ok({ runAt });
    if (valid) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ field: 'runAt' }));
  });

  it.each([
    [{ option: 3, schedule: 5, typeDefault: 7 }, 3],
    [{ schedule: 5, typeDefault: 7 }, 5],
    [{ typeDefault: 7 }, 7],
    [{}, 8],
  ])('S49 AS-07: maxAttempts default order %j -> %s', (input, expected) => {
    expect(resolveMaxAttempts(input)).toBe(expected);
    expect(DEFAULT_MAX_ATTEMPTS).toBe(8);
  });
});

describe('payload contract typing (S49 AS-93)', () => {
  it('S49 AS-93: enqueue is typed against the JobPayloads augmentation', () => {
    // Compile-time only: a wrong payload or an unknown type must fail tsc (ts-jest reports it as a diagnostic).
    const typed = (jobs: JobsService) => {
      void jobs.enqueue('jobs.noop', {});
      void jobs.enqueue('jobs.partition-maintenance', { aheadDays: 3 });
      // @ts-expect-error - aheadDays is a number
      void jobs.enqueue('jobs.partition-maintenance', { aheadDays: 'x' });
      // @ts-expect-error - unknown job type
      void jobs.enqueue('no.such-type', {});
    };
    const t: JobType = 'jobs.noop';
    const payload: JobPayloads['jobs.noop'] = {};
    expect(typeof typed).toBe('function');
    expect([t, payload]).toBeDefined();
  });
});

import { InvalidScheduleError } from './job-errors';
import { validateScheduleInput } from './schedule-validation';

const valid = {
  name: 'billing.close-month',
  cron: '0 3 * * *',
  timezone: 'Europe/Warsaw',
};
const check = (patch: Record<string, unknown>) =>
  validateScheduleInput({ ...valid, ...patch } as never);

describe('schedule validation (S49 AS-76)', () => {
  it('S49 AS-76: accepts a valid schedule', () => {
    expect(() => check({})).not.toThrow();
    expect(() => check({ maxAttempts: 25, overlap: 'allow' })).not.toThrow();
  });

  it.each([
    ['a', true],
    ['platform.purge-idempotency-keys', true],
    ['a_b.c-d', true],
    ['x'.repeat(100), true],
    ['x'.repeat(101), false],
    ['', false],
    ['Upper', false],
    ['has space', false],
    ['.leading', false],
    ['trailing.', false],
    ['double..dot', false],
    ['semi;colon', false],
  ])('S49 AS-76: name "%s" valid=%s', (name, ok) => {
    const run = () => check({ name });
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ field: 'name' }));
  });

  it.each([
    ['* * * * *', true],
    ['*/10 * * * * *', true],
    ['0 9 * * MON-FRI', true],
    ['0 0 1,15 JAN-JUN *', true],
    ['* * * *', false],
    ['* * * * * * *', false],
    ['60 * * * *', false],
    ['* 24 * * *', false],
    ['0 0 L * *', false],
    ['0 0 15W * *', false],
    ['0 0 * * 5#2', false],
    ['0 0 ? * *', false],
    ['@daily', false],
    ['not a cron', false],
    ['0 0 31 2 *', false],
    ['', false],
  ])('S49 AS-76: cron "%s" valid=%s', (cron, ok) => {
    const run = () => check({ cron });
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ field: 'cron' }));
  });

  it.each([
    ['UTC', true],
    ['Europe/Warsaw', true],
    ['Asia/Kolkata', true],
    ['Mars/Olympus', false],
    ['', false],
    ['GMT+2', false],
  ])('S49 AS-76: time zone "%s" valid=%s', (timezone, ok) => {
    const run = () => check({ timezone });
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ field: 'timezone' }));
  });

  it.each([
    [1, true],
    [25, true],
    [0, false],
    [26, false],
    [1.5, false],
  ])('S49 AS-76: maxAttempts %s valid=%s', (maxAttempts, ok) => {
    const run = () => check({ maxAttempts });
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ field: 'maxAttempts' }));
  });

  it.each([
    ['skip', true],
    ['allow', true],
    ['queue', false],
  ])('S49 AS-76: overlap "%s" valid=%s', (overlap, ok) => {
    const run = () => check({ overlap });
    if (ok) expect(run).not.toThrow();
    else expect(run).toThrow(expect.objectContaining({ field: 'overlap' }));
  });

  it('S49 AS-76: errors are InvalidScheduleError', () => {
    expect(() => check({ cron: 'x' })).toThrow(InvalidScheduleError);
  });
});

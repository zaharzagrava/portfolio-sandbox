import { ConfigUtilsService } from '@app/common/config/config-utils/config-utils.service';
import {
  JobsConfig,
  jobsConfigKeys,
  jobsConfigRule,
} from '@app/common/config/jobs-config';

const parse = (env: Record<string, string>): JobsConfig =>
  new ConfigUtilsService().parseSrc<JobsConfig>(jobsConfigKeys, [
    env as unknown as Record<string, JobsConfig[keyof JobsConfig]>,
  ]);

describe('job scheduler configuration (S49)', () => {
  it('S49 G-22: defaults are 50 / 5 / 30 days / 500 ms when nothing is set', () => {
    expect(parse({})).toEqual({
      jobs_claim_batch: 50,
      jobs_per_shop_running_cap: 5,
      jobs_retain_days: 30,
      jobs_poll_idle_ms: 500,
    });
  });

  it('S49 G-22: values from the environment are used', () => {
    expect(
      parse({
        JOBS_CLAIM_BATCH: '20',
        JOBS_PER_SHOP_RUNNING_CAP: '2',
        JOBS_RETAIN_DAYS: '7',
        JOBS_POLL_IDLE_MS: '100',
      }),
    ).toEqual({
      jobs_claim_batch: 20,
      jobs_per_shop_running_cap: 2,
      jobs_retain_days: 7,
      jobs_poll_idle_ms: 100,
    });
  });

  it.each([
    ['JOBS_CLAIM_BATCH', '0'],
    ['JOBS_CLAIM_BATCH', '1001'],
    ['JOBS_CLAIM_BATCH', 'many'],
    ['JOBS_PER_SHOP_RUNNING_CAP', '0'],
    ['JOBS_RETAIN_DAYS', '-1'],
    ['JOBS_RETAIN_DAYS', '12.5'],
    ['JOBS_POLL_IDLE_MS', '0'],
  ])('S49 G-22: %s=%s is refused', (key, value) => {
    expect(() => parse({ [key]: value })).toThrow();
  });

  it.each([
    [50, 10, true],
    [100, 10, true],
    [101, 10, false],
    [50, 4, false],
    [50, undefined, true],
  ])(
    'S49 G-22: claim batch %s with a pool of %s is valid=%s',
    (batch, pool, valid) => {
      const found = jobsConfigRule({
        get: (key) =>
          key === 'jobs_claim_batch'
            ? batch
            : key === 'db_pool_max'
              ? pool
              : undefined,
        production: false,
      });
      expect(found.length === 0).toBe(valid);
    },
  );
});

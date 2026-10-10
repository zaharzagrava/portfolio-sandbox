import { buildPayloadContract, parseBuildParams } from './build-params';

const DEFAULTS = { days: 180, buckets: 16 };

describe('build job parameters', () => {
  it('S34 AS-42: an empty payload takes the defaults', () => {
    expect(parseBuildParams({}, DEFAULTS)).toEqual({
      ok: true,
      value: { days: 180, buckets: 16 },
    });
    expect(parseBuildParams(undefined, DEFAULTS)).toEqual({
      ok: true,
      value: { days: 180, buckets: 16 },
    });
  });

  it.each([
    [{ days: 1 }, { days: 1, buckets: 16 }],
    [{ days: 390 }, { days: 390, buckets: 16 }],
    [{ buckets: 1 }, { days: 180, buckets: 1 }],
    [{ buckets: 256, days: 7 }, { days: 7, buckets: 256 }],
  ])('S34 AS-42: %j is accepted', (payload, value) => {
    expect(parseBuildParams(payload, DEFAULTS)).toEqual({ ok: true, value });
  });

  it.each([
    [{ days: 0 }, ['days']],
    [{ days: 391 }, ['days']],
    [{ days: -5 }, ['days']],
    [{ days: 1.5 }, ['days']],
    [{ days: '30' }, ['days']],
    [{ buckets: 0 }, ['buckets']],
    [{ buckets: 257 }, ['buckets']],
    [{ buckets: 2.5 }, ['buckets']],
    [{ days: Number.NaN }, ['days']],
    [{ colour: 'red' }, ['colour']],
    [{ days: 0, buckets: 0 }, ['days', 'buckets']],
  ])('S34 AS-42: %j is rejected naming %j', (payload, fields) => {
    const result = parseBuildParams(payload, DEFAULTS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect([...result.fields].sort()).toEqual([...fields].sort());
  });

  it('S34 AS-42: the job payload contract is strict and carries the same bounds', () => {
    expect(buildPayloadContract.safeParse({}).success).toBe(true);
    expect(buildPayloadContract.safeParse({ days: 180, buckets: 16 }).success).toBe(true);
    expect(buildPayloadContract.safeParse({ days: 0 }).success).toBe(false);
    expect(buildPayloadContract.safeParse({ buckets: 257 }).success).toBe(false);
    expect(buildPayloadContract.safeParse({ extra: 1 }).success).toBe(false);
  });
});

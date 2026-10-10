import { randomUUID } from 'node:crypto';
import { inParallel } from '@app/test/utils/async-helpers';
import { ProbeApp, createProbeApp } from './test/probe-app';

/** S50 US13: two application instances, one shared store, one exact budget. */
describe('S50 fleet guarantee (e2e, two Nest apps on one Redis)', () => {
  let one: ProbeApp;
  let two: ProbeApp;

  beforeAll(async () => {
    one = await createProbeApp();
    two = await createProbeApp();
  });

  afterAll(async () => {
    await one.close();
    await two.close();
  });

  it('S50 AS-80: 200 parallel checks across two instances against a limit of 100 → exactly 100 allowed', async () => {
    const subject = `user:${randomUUID()}`;
    const results = await inParallel(200, (i) =>
      (i % 2 ? one : two).limiter.check('probe.window100', subject),
    );
    const allowed = results.filter(
      (r) => r.status === 'fulfilled' && r.value.allowed,
    );
    expect(allowed).toHaveLength(100);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('S50 AS-80: the same holds for a token bucket', async () => {
    const subject = `user:${randomUUID()}`;
    const results = await inParallel(100, (i) =>
      (i % 2 ? one : two).limiter.check('probe.burst', subject),
    );
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value.allowed),
    ).toHaveLength(10);
  });

  it('S50 AS-81: concurrency limit 2 across two instances → exactly 2 acquired', async () => {
    const subject = `user:${randomUUID()}`;
    const results = await inParallel(20, (i) =>
      (i % 2 ? one : two).limiter.acquire('probe.conc2', subject),
    );
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value.acquired),
    ).toHaveLength(2);
  });
});

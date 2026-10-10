import { randomUUID } from 'node:crypto';
import { inParallel, waitFor } from '@app/test/utils/async-helpers';
import { ProbeApp, createProbeApp } from './test/probe-app';
import { probeLog } from './test/probe.controller';
import {
  LimiterInstance,
  T0,
  createLimiter,
  storedItems,
  uniqueSubject,
} from './test/limiter-fixture';

/** S50 US3: concurrency limiter — at most N leases in flight, crashed holders recover. Real Redis, injected store time. */
describe('S50 concurrency limit (e2e, real Redis)', () => {
  let a: LimiterInstance;

  beforeAll(async () => {
    a = await createLimiter();
  });

  afterAll(async () => {
    await a.close();
  });

  beforeEach(() => a.manualTime.set(T0));

  it('S50 AS-15: limit 2 — the third is denied, a release frees a slot', async () => {
    const subject = uniqueSubject();
    const one = await a.limiter.acquire('probe.conc2', subject);
    const two = await a.limiter.acquire('probe.conc2', subject);
    const three = await a.limiter.acquire('probe.conc2', subject);
    expect([one.acquired, two.acquired, three.acquired]).toEqual([
      true,
      true,
      false,
    ]);
    expect(three.decision).toMatchObject({
      allowed: false,
      reason: 'limit-exceeded',
      source: 'store',
    });
    expect(three.decision.retryAfterMs).toBeGreaterThanOrEqual(1000);
    if (one.acquired) await one.release();
    const four = await a.limiter.acquire('probe.conc2', subject);
    expect(four.acquired).toBe(true);
  });

  it('S50 AS-16: 20 parallel acquires on limit 2 → exactly 2 acquired', async () => {
    const subject = uniqueSubject();
    const results = await inParallel(20, () =>
      a.limiter.acquire('probe.conc2', subject),
    );
    const acquired = results.filter(
      (r) => r.status === 'fulfilled' && r.value.acquired,
    );
    expect(acquired).toHaveLength(2);
  });

  it('S50 AS-17: a crashed holder frees its slot when its lease ends', async () => {
    const subject = uniqueSubject();
    await a.limiter.acquire('probe.conc2', subject);
    await a.limiter.acquire('probe.conc2', subject); // never released: the holder crashed
    expect((await a.limiter.acquire('probe.conc2', subject)).acquired).toBe(
      false,
    );
    a.manualTime.advance(29_999);
    expect((await a.limiter.acquire('probe.conc2', subject)).acquired).toBe(
      false,
    );
    a.manualTime.advance(1); // lease length 30 s reached
    expect((await a.limiter.acquire('probe.conc2', subject)).acquired).toBe(
      true,
    );
  });

  it('S50 AS-18: double release and a stale release are harmless and free only their own lease', async () => {
    const subject = uniqueSubject();
    const first = await a.limiter.acquire('probe.conc2', subject);
    const second = await a.limiter.acquire('probe.conc2', subject);
    if (!first.acquired || !second.acquired) throw new Error('setup');
    await first.release();
    await first.release(); // double release
    const third = await a.limiter.acquire('probe.conc2', subject);
    expect(third.acquired).toBe(true);
    // second and third hold; a fourth is denied although `first` was released twice
    expect((await a.limiter.acquire('probe.conc2', subject)).acquired).toBe(
      false,
    );

    // stale: second's lease expires, a new holder takes the slot, second's late release must not free it
    a.manualTime.advance(30_000);
    const fresh = await a.limiter.acquire('probe.conc2', subject);
    const fresh2 = await a.limiter.acquire('probe.conc2', subject);
    expect(fresh.acquired && fresh2.acquired).toBe(true);
    await second.release();
    expect((await a.limiter.acquire('probe.conc2', subject)).acquired).toBe(
      false,
    );
  });

  it('S50 AS-19: the retry hint is the time to the earliest lease expiry, clamped to 1-5 s', async () => {
    const subject = uniqueSubject();
    await a.limiter.acquire('probe.conc2', subject);
    await a.limiter.acquire('probe.conc2', subject);
    const hint = async () =>
      (await a.limiter.acquire('probe.conc2', subject)).decision.retryAfterMs;
    expect(await hint()).toBe(5_000); // 30 s left → clamp to 5 s
    a.manualTime.set(T0 + 27_000);
    expect(await hint()).toBe(3_000); // 3 s left
    a.manualTime.set(T0 + 29_500);
    expect(await hint()).toBe(1_000); // 0.5 s left → clamp to 1 s
  });

  it('S50 AS-08: leases expire at twice the lease length at the latest', async () => {
    const subject = uniqueSubject();
    await a.limiter.acquire('probe.conc2', subject);
    const items = await storedItems(a.redis, subject);
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe(`rl:{probe.conc2|${subject}}:cc`);
    expect(items[0].ttlMs).toBeGreaterThan(0);
    expect(items[0].ttlMs).toBeLessThanOrEqual(60_000);
  });
});

/** AS-20: the lease taken for a request is released on every outcome. */
describe('S50 concurrency over HTTP (e2e, real Redis)', () => {
  let probe: ProbeApp;

  beforeAll(async () => {
    probe = await createProbeApp();
  });

  afterAll(async () => {
    await probe.close();
  });

  beforeEach(() => probeLog.reset());

  const leases = (id: string) =>
    probe.redis.client.zcard(`rl:{http.slow|user:${id}}:cc`);

  it.each([
    ['success', undefined, 201],
    ['an error', 'error500', 500],
    ['a validation-style refusal', 'error422', 422],
  ])(
    'S50 AS-20: the lease is released after %s',
    async (_label, mode, status) => {
      const id = randomUUID();
      await probe
        .http()
        .post(`/api/probe/slow${mode ? `?mode=${mode}` : ''}`)
        .set({ 'x-user': id })
        .expect(status);
      expect(await leases(id)).toBe(0);
      // and the next request is admitted
      await probe
        .http()
        .post('/api/probe/slow')
        .set({ 'x-user': id })
        .expect(201);
    },
  );

  it('S50 AS-20: while a request is in flight the next one is a 429 with a 1-5 s hint; an aborted client frees the lease', async () => {
    const id = randomUUID();
    const server = probe.app.getHttpServer();
    const { port } = server.address() as { port: number };
    const controller = new AbortController();
    const first = fetch(`http://127.0.0.1:${port}/api/probe/slow?mode=park`, {
      method: 'POST',
      headers: { 'x-user': id },
      signal: controller.signal,
    }).catch(() => undefined);
    await waitFor(async () => (await leases(id)) === 1, {
      timeoutMs: 5_000,
      intervalMs: 10,
    });

    const refused = await probe
      .http()
      .post('/api/probe/slow')
      .set({ 'x-user': id })
      .expect(429);
    const wait = Number(refused.headers['retry-after']);
    expect(wait).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(5);
    expect(refused.headers['ratelimit']).toBeUndefined(); // concurrency policies have no RateLimit item

    controller.abort();
    await first;
    await waitFor(async () => (await leases(id)) === 0, {
      timeoutMs: 5_000,
      intervalMs: 10,
    });
    probeLog.release?.();
    await probe
      .http()
      .post('/api/probe/slow')
      .set({ 'x-user': id })
      .expect(201);
  });
});

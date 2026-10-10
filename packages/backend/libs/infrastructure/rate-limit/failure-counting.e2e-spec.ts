import { randomUUID } from 'node:crypto';
import { inParallel } from '@app/test/utils/async-helpers';
import { ProbeApp, createProbeApp } from './test/probe-app';
import { probeLog } from './test/probe.controller';
import {
  LimiterInstance,
  createLimiter,
  scanKeys,
  storedItems,
  uniqueSubject,
} from './test/limiter-fixture';
import { emailSubject } from './subject';

const uid = () => randomUUID();

/** S50 US8: only failed attempts count; successes clear; parallel guesses cannot slip through. Real Redis. */
describe('S50 failure-only counting (e2e, real Redis)', () => {
  let probe: ProbeApp;
  let code: LimiterInstance;

  beforeAll(async () => {
    probe = await createProbeApp();
    code = await createLimiter();
  });

  afterAll(async () => {
    await probe.close();
    await code.close();
  });

  beforeEach(() => probeLog.reset());

  const login = (email: string, password = 'wrong', outcome?: string) =>
    probe.http().post('/api/probe/login').send({ email, password, outcome });
  const used = async (email: string): Promise<number> => {
    const keys = await scanKeys(
      probe.redis,
      `rl:{http.login|${emailSubject(email)}}:sw:*`,
    );
    let total = 0;
    for (const key of keys) total += Number(await probe.redis.client.get(key));
    return total;
  };

  it('S50 AS-54: five wrong credentials, then the correct one is a 429 with a wait, and its handler does not run', async () => {
    const email = `a-${uid()}@example.com`;
    for (let i = 0; i < 5; i++) await login(email).expect(401);
    const sixth = await login(email, 'right').expect(429);
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect(probeLog.handled).toHaveLength(5);
  });

  it('S50 AS-55: a success clears the counter; five more failures are admitted, the sixth is a 429', async () => {
    const email = `b-${uid()}@example.com`;
    for (let i = 0; i < 4; i++) await login(email).expect(401);
    await login(email, 'right').expect(200);
    expect(await used(email)).toBe(0);
    for (let i = 0; i < 5; i++) await login(email).expect(401);
    await login(email).expect(429);
  });

  it('S50 AS-56: 20 parallel wrong attempts on a limit of 5 → exactly 5 reach the handler', async () => {
    const email = `c-${uid()}@example.com`;
    const results = await inParallel(20, () => login(email));
    const statuses = results.map((r) =>
      r.status === 'fulfilled' ? r.value.status : -1,
    );
    expect(statuses.slice().sort().join(',')).toBe(
      [...Array(5).fill(401), ...Array(15).fill(429)].sort().join(','),
    );
    expect(probeLog.handled).toHaveLength(5);
  });

  it('S50 AS-57: only failure statuses keep the slot — six 500s then a 401 leave one slot used', async () => {
    const email = `d-${uid()}@example.com`;
    for (let i = 0; i < 6; i++)
      await login(email, 'wrong', 'error500').expect(500);
    expect(await used(email)).toBe(0);
    await login(email).expect(401);
    expect(await used(email)).toBe(1);
    await login(email, 'wrong', 'bad-request').expect(400);
    expect(await used(email)).toBe(1); // 400 returns its slot
    await login(email, 'wrong', 'forbidden').expect(403);
    expect(await used(email)).toBe(2); // 403 is a default failure status
  });

  it('S50 AS-57: a client abort returns the slot', async () => {
    const email = `e-${uid()}@example.com`;
    const server = probe.app.getHttpServer();
    if (!server.listening) await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/probe/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong', outcome: 'park' }),
      signal: controller.signal,
    }).catch(() => undefined);
    await waitUntil(() => probeLog.handled.includes('login'));
    expect(await used(email)).toBe(1); // reserved at admission
    controller.abort();
    await pending;
    await waitUntil(async () => (await used(email)) === 0);
    probeLog.release?.();
  });

  it('S50 AS-58: three code paths share one counter with check, refund and reset', async () => {
    const subject = uniqueSubject('email');
    // verify fails, confirm fails: both keep their slot
    await code.limiter.check('probe.window5', subject);
    await code.limiter.check('probe.window5', subject);
    // regenerate succeeds: it reserved a slot and returns exactly that one
    await code.limiter.check('probe.window5', subject);
    await code.limiter.refund('probe.window5', subject);
    expect((await code.limiter.check('probe.window5', subject)).remaining).toBe(
      2,
    ); // 3 used incl. this one
    // a success elsewhere clears all of them
    await code.limiter.reset('probe.window5', subject);
    const after: boolean[] = [];
    for (let i = 0; i < 6; i++)
      after.push((await code.limiter.check('probe.window5', subject)).allowed);
    expect(after).toEqual([true, true, true, true, true, false]);
  });

  it('S50 AS-59: reset and refund on empty state create nothing and respect the bounds', async () => {
    const subject = uniqueSubject('email');
    await expect(
      code.limiter.reset('probe.window5', subject),
    ).resolves.toBeUndefined();
    await expect(
      code.limiter.refund('probe.window5', subject, 3),
    ).resolves.toBeUndefined();
    await code.limiter.reset('probe.burst', subject);
    await code.limiter.refund('probe.burst', subject, 3);
    await code.limiter.reset('probe.conc2', subject);
    expect(await storedItems(code.redis, subject)).toEqual([]);

    // never below zero
    await code.limiter.check('probe.window5', subject);
    await code.limiter.refund('probe.window5', subject, 5);
    const keys = await scanKeys(
      code.redis,
      `rl:{probe.window5|${subject}}:sw:*`,
    );
    expect(keys).toHaveLength(1);
    expect(Number(await code.redis.client.get(keys[0]))).toBe(0);
    expect(await code.redis.client.pttl(keys[0])).toBeGreaterThan(0); // refund keeps the expiry

    // never above the capacity
    const bucket = uniqueSubject();
    await code.limiter.check('probe.burst', bucket);
    await code.limiter.refund('probe.burst', bucket, 5);
    expect(
      Number(
        await code.redis.client.hget(`rl:{probe.burst|${bucket}}:tb`, 'tokens'),
      ),
    ).toBe(10);

    // reset deletes the subject's items
    await code.limiter.check('probe.burst', bucket);
    await code.limiter.reset('probe.burst', bucket);
    expect(await storedItems(code.redis, bucket)).toEqual([]);
  });
});

async function waitUntil(
  probe: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not reached');
}

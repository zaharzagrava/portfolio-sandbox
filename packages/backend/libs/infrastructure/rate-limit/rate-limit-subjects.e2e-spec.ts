import { randomUUID } from 'node:crypto';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { ProbeApp, createProbeApp } from './test/probe-app';
import { scanKeys } from './test/limiter-fixture';

const uid = () => randomUUID();
const fallbackCount = (policy: string) =>
  MetricsRegistry.value('rate_limit_subject_fallback_total', { policy }) ?? 0;

/** S50 US7: whose budget is it? Production pipeline (client address from the trusted-proxy chain), real Redis. */
describe('S50 rate limit subjects (e2e, real Redis)', () => {
  let probe: ProbeApp;

  beforeAll(async () => {
    probe = await createProbeApp();
  });

  afterAll(async () => {
    await probe.close();
  });

  beforeEach(async () => {
    for (const pattern of ['rl:{http.*|ip:*', 'rl:{probe.*|ip:*'])
      for (const key of await scanKeys(probe.redis, pattern))
        await probe.redis.client.del(key);
  });

  it('S50 AS-48: rotating CF-Connecting-IP / X-Forwarded-For / X-Real-IP does not give a fresh budget', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await probe
        .http()
        .get('/api/probe/ip')
        .set('CF-Connecting-IP', `10.0.0.${i}`)
        .set('X-Forwarded-For', `10.1.0.${i}`)
        .set('X-Real-IP', `10.2.0.${i}`);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);
    const keys = await scanKeys(probe.redis, 'rl:{http.ip20|ip:*');
    expect(keys.length).toBeGreaterThanOrEqual(1); // one subject (window items), never one per spoofed address
    expect(keys.length).toBeLessThanOrEqual(2);
    expect(
      keys.every((k) => !k.includes('10.0.0.') && !k.includes('10.1.0.')),
    ).toBe(true);
  });

  it('S50 AS-49: users are separate budgets', async () => {
    const a = uid();
    const b = uid();
    for (let i = 0; i < 5; i++)
      await probe
        .http()
        .get('/api/probe/user')
        .set({ 'x-user': a })
        .expect(200);
    await probe.http().get('/api/probe/user').set({ 'x-user': a }).expect(429);
    await probe.http().get('/api/probe/user').set({ 'x-user': b }).expect(200);
  });

  it('S50 AS-49: two API keys of one shop count separately on a key policy and together on a shop policy; other shops are unaffected', async () => {
    const shop = `shop-${uid()}`;
    const k1 = `key-${uid()}`;
    const k2 = `key-${uid()}`;
    const as = (key: string, shopId: string) => ({
      'x-api-key': key,
      'x-key-shop': shopId,
    });
    for (let i = 0; i < 3; i++)
      await probe.http().get('/api/probe/key').set(as(k1, shop)).expect(200);
    for (let i = 0; i < 2; i++)
      await probe.http().get('/api/probe/key').set(as(k2, shop)).expect(200);
    // the shop budget (5) is used up by the two keys together, although neither key is near its own limit
    await probe.http().get('/api/probe/key').set(as(k2, shop)).expect(429);
    expect((await probe.limiter.check('http.key', `key:${k1}`)).remaining).toBe(
      1,
    ); // 3 used + this one
    expect((await probe.limiter.check('http.key', `key:${k2}`)).remaining).toBe(
      2,
    ); // 2 used + this one; the refused one was returned
    // another shop is untouched
    await probe
      .http()
      .get('/api/probe/key')
      .set(as(`key-${uid()}`, `shop-${uid()}`))
      .expect(200);
  });

  it('S50 AS-50: a request without the identity the policy asks for is limited by address and counted', async () => {
    const before = fallbackCount('http.user');
    for (let i = 0; i < 5; i++)
      await probe.http().get('/api/probe/user').expect(200);
    await probe.http().get('/api/probe/user').expect(429);
    expect(fallbackCount('http.user')).toBe(before + 6);
    expect((await scanKeys(probe.redis, 'rl:{http.user|ip:*')).length).toBe(1);
  });

  it('S50 AS-53: a custom subject is used inside its namespace; nothing returned falls back to the address', async () => {
    const who = `tenant-${uid()}`;
    for (let i = 0; i < 5; i++)
      await probe.http().get(`/api/probe/custom?who=${who}`).expect(200);
    await probe.http().get(`/api/probe/custom?who=${who}`).expect(429);
    await probe.http().get(`/api/probe/custom?who=other-${uid()}`).expect(200);
    const before = fallbackCount('http.custom');
    await probe.http().get('/api/probe/custom').expect(200);
    expect(fallbackCount('http.custom')).toBe(before + 1);
    expect(
      await scanKeys(probe.redis, `rl:{http.custom|custom:${who}}:tb`),
    ).toHaveLength(1);
  });

  it('S50 AS-52: no e-mail, token, password or API-key secret is in any stored key, and every key expires', async () => {
    // unique per run: the store keeps other specs' keys, and only this test's secrets may be searched for
    const run = uid().slice(0, 8);
    const secrets = [
      `mailbox${run}@example.com`,
      `mailbox${run}`,
      `hunter2-password-${run}`,
      `sk_live_SECRET${run}`,
      `bearer-token-${run}`,
    ];
    await probe
      .http()
      .post('/api/probe/login')
      .set('Authorization', `Bearer ${secrets[4]}`)
      .set({
        'x-api-key': 'key-id-123',
        'x-key-shop': 'shop-123',
        'x-user': 'user-123',
      })
      .send({ email: secrets[0].toUpperCase(), password: secrets[2] });
    await probe
      .http()
      .get('/api/probe/key')
      .set('Authorization', `Bearer ${secrets[3]}`)
      .set({ 'x-api-key': 'key-id-123', 'x-key-shop': 'shop-123' })
      .expect(200);
    const keys = await scanKeys(probe.redis, 'rl:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      for (const secret of secrets)
        expect(key.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(await probe.redis.client.pttl(key)).toBeGreaterThan(0);
    }
  });
});

import { Logger } from '@nestjs/common';
import { ProbeApp, createProbeApp } from '@app/infrastructure/rate-limit/test/probe-app';
import { scanKeys } from '@app/infrastructure/rate-limit/test/limiter-fixture';
import { CspReportsController } from './csp-reports.controller';

/** W07 AS-21: `POST /api/csp-reports` through the production pipeline (configureHttpApp, filter, S50 limiter, real Redis). */
describe('W07 csp-reports (e2e)', () => {
  let probe: ProbeApp;
  let warn: jest.SpyInstance;
  const logged = () => warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('csp_violation'));

  beforeAll(async () => {
    probe = await createProbeApp({ controllers: [CspReportsController], policies: [] });
  });
  afterAll(async () => {
    await probe.close();
  });
  beforeEach(async () => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    for (const key of await scanKeys(probe.redis, 'rl:{default.write|ip:*')) await probe.redis.client.del(key);
  });
  afterEach(() => warn.mockRestore());

  const post = () => probe.http().post('/api/csp-reports');

  it('W07 AS-21: application/csp-report -> 204 and a log entry with the directive and the blocked host only', async () => {
    const body = {
      'csp-report': {
        'document-uri': 'https://shop.example.com/checkout?token=SECRET',
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src-elem',
        'blocked-uri': 'https://evil.example.net/x.js?session=SECRET2',
      },
    };
    const res = await post().set('Content-Type', 'application/csp-report').send(JSON.stringify(body)).expect(204);
    expect(res.text).toBe('');
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('script-src-elem');
    expect(lines[0]).toContain('https://evil.example.net');
    expect(lines[0]).not.toMatch(/SECRET|token|session|x\.js|checkout/);
  });

  it('W07 AS-21: application/reports+json (Reporting API array) -> 204 and one log entry per violation', async () => {
    const body = [
      { type: 'csp-violation', url: 'https://shop.example.com/?q=SECRET', body: { effectiveDirective: 'img-src', blockedURL: 'https://img.example.org/a.png?k=SECRET', documentURL: 'https://shop.example.com/?q=SECRET' } },
      { type: 'deprecation', body: { id: 'x' } },
      { type: 'csp-violation', body: { effectiveDirective: 'script-src', blockedURL: 'inline' } },
    ];
    await post().set('Content-Type', 'application/reports+json').send(JSON.stringify(body)).expect(204);
    const lines = logged();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/img-src.*https:\/\/img\.example\.org/);
    expect(lines[1]).toMatch(/script-src.*inline/);
    expect(lines.join('\n')).not.toMatch(/SECRET|a\.png/);
  });

  it('W07 AS-21: application/json is accepted too', async () => {
    await post().send({ 'csp-report': { 'effective-directive': 'connect-src', 'blocked-uri': 'https://api.example.org/v1' } }).expect(204);
    expect(logged()).toHaveLength(1);
  });

  it.each([
    ['application/csp-report', '{not json'],
    ['application/reports+json', '[[[['],
    ['application/json', '{"broken":'],
    ['application/csp-report', '"a string"'],
    ['application/csp-report', '{"csp-report": 5}'],
    ['application/reports+json', '[{"type": 7, "body": "x"}]'],
  ])('W07 AS-21: garbage body (%s %s) -> 204 and nothing logged', async (type, body) => {
    await post().set('Content-Type', type).send(body).expect(204);
    expect(logged()).toHaveLength(0);
  });

  it('W07 AS-21: an empty body -> 204', async () => {
    await post().set('Content-Type', 'application/csp-report').expect(204);
    await post().expect(204);
  });

  it('W07 AS-21: an oversized body -> 204 and nothing logged', async () => {
    const big = JSON.stringify({ 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': `https://a.example.org/${'x'.repeat(300_000)}` } });
    await post().set('Content-Type', 'application/csp-report').send(big).expect(204);
    expect(logged()).toHaveLength(0);
  });

  it.each(['text/plain', 'application/xml', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded'])(
    'W07 AS-21: wrong content type %s -> 204 and nothing logged',
    async (type) => {
      await post().set('Content-Type', type).send('csp-report=1').expect(204);
      expect(logged()).toHaveLength(0);
    },
  );

  it('W07 AS-21: only a plain directive name is logged: text after it is cut, anything else is "unknown" (no log injection)', async () => {
    const send = (directive: string) =>
      post()
        .set('Content-Type', 'application/csp-report')
        .send(JSON.stringify({ 'csp-report': { 'effective-directive': directive, 'blocked-uri': 'https://a.example.org' } }))
        .expect(204);
    await send('img-src\nFAKE LOG LINE');
    await send('<script>alert(1)</script>');
    const lines = logged();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('csp_violation directive=img-src blocked=https://a.example.org');
    expect(lines[1]).toBe('csp_violation directive=unknown blocked=https://a.example.org');
  });

  it('W07 AS-21: over the S50 limit the limiter answers 429 with Retry-After (default write policy, per address)', async () => {
    let last = 204;
    for (let i = 0; i < 70 && last === 204; i++) {
      const res = await post().set('Content-Type', 'application/csp-report').send('{}');
      last = res.status;
      if (last === 429) expect(res.headers['retry-after']).toBeDefined();
    }
    expect(last).toBe(429);
  });
});

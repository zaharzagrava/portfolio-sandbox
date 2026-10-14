import { ApiConfigService } from '@app/common/config';
import { WidgetPublicService } from './application/widget-public.service';
import { WidgetSiteCache } from './application/widget-site.cache';
import {
  createWidgetKit,
  exec,
  ORIGIN,
  ORIGIN_2,
  type CreatedSite,
  type WidgetKit,
  type WidgetWorld,
} from './testing/widget-kit';

const NONE = "frame-ancestors 'none'";

describe('Widget: embed document and framing policy', () => {
  let t: WidgetKit;
  let w: WidgetWorld;

  beforeAll(async () => {
    t = await createWidgetKit();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const embed = (key: string) =>
    t.http().get(`/api/widget/v1/embed?key=${encodeURIComponent(key)}`);
  const dashboard = (site: CreatedSite) =>
    `/api/shops/${w.shop.id}/widget/sites/${site.id}`;
  const directive = (csp: string, name: string): string | undefined =>
    csp.split('; ').find((d) => d === name || d.startsWith(`${name} `));

  describe('document and strict CSP (AS-34)', () => {
    it('S44 AS-34: 200 html with the full directive set, one nonced script, no inline code and the right headers', async () => {
      const site = await t.site(w);
      const res = await embed(site.publishableKey).expect(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      const csp = res.headers['content-security-policy'] as string;
      const nonce = /script-src 'nonce-([^']+)' 'strict-dynamic'/.exec(
        csp,
      )?.[1];
      expect(nonce).toBeDefined();
      expect(Buffer.from(nonce!, 'base64').length).toBeGreaterThanOrEqual(16);
      expect(directive(csp, 'default-src')).toBe("default-src 'none'");
      expect(directive(csp, 'script-src')).toBe(
        `script-src 'nonce-${nonce}' 'strict-dynamic'`,
      );
      expect(directive(csp, 'object-src')).toBe("object-src 'none'");
      expect(directive(csp, 'base-uri')).toBe("base-uri 'none'");
      expect(directive(csp, 'form-action')).toBe("form-action 'self'");
      for (const forbidden of [
        "'unsafe-inline'",
        "'unsafe-eval'",
        '*',
        'data:',
      ])
        expect(directive(csp, 'script-src')).not.toContain(forbidden);

      const html = res.text;
      expect(html.match(/<script\b/g)).toHaveLength(1);
      expect(html).toContain(
        `<script nonce="${nonce}" src="/widget/v1/app.js"></script>`,
      );
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).toContain(
        `data-site="${encodeURIComponent(site.publishableKey)}"`,
      );

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe(
        'strict-origin-when-cross-origin',
      );
      expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('S44 AS-34: 50 consecutive responses carry 50 different nonces', async () => {
      const site = await t.site(w);
      const nonces = new Set<string>();
      for (let i = 0; i < 50; i += 1) {
        const res = await embed(site.publishableKey).expect(200);
        nonces.add(
          /'nonce-([^']+)'/.exec(
            res.headers['content-security-policy'] as string,
          )![1],
        );
      }
      expect(nonces.size).toBe(50);
    });

    it('S44 AS-34: the bundle address is the configured WIDGET_APP_BUNDLE_URL', async () => {
      const site = await t.site(w);
      const config = t.app.get(ApiConfigService);
      const real = config.get.bind(config) as (key: string) => unknown;
      jest
        .spyOn(config, 'get')
        .mockImplementation(((key: string) =>
          key === 'widget_app_bundle_url'
            ? 'https://cdn.example/checkout/app.js'
            : real(key)) as never);
      const res = await embed(site.publishableKey).expect(200);
      expect(res.text).toContain('src="https://cdn.example/checkout/app.js"');
    });
  });

  describe('frame-ancestors is exactly the site list (AS-35)', () => {
    it('S44 AS-35: the exact sorted origins of each site, no wildcard, scheme source or self; an edit shows at once', async () => {
      const x = await t.site(w, { origins: [ORIGIN, ORIGIN_2] });
      const y = await t.site(w, { origins: ['https://other.example'] });
      const cspX = (await embed(x.publishableKey).expect(200)).headers[
        'content-security-policy'
      ] as string;
      const cspY = (await embed(y.publishableKey).expect(200)).headers[
        'content-security-policy'
      ] as string;
      expect(directive(cspX, 'frame-ancestors')).toBe(
        `frame-ancestors ${ORIGIN_2} ${ORIGIN}`,
      );
      expect(directive(cspY, 'frame-ancestors')).toBe(
        'frame-ancestors https://other.example',
      );
      expect(directive(cspX, 'frame-ancestors')).not.toMatch(
        /\*|'self'|https: |https:$/,
      );

      await t
        .as(w.owner)
        .patch(dashboard(x))
        .send({ allowedOrigins: ['https://new.example'], expectedVersion: 1 })
        .expect(200);
      const after = (await embed(x.publishableKey).expect(200)).headers[
        'content-security-policy'
      ] as string;
      expect(directive(after, 'frame-ancestors')).toBe(
        'frame-ancestors https://new.example',
      );
    });
  });

  describe('everything else refuses framing (AS-36)', () => {
    it('S44 AS-36: config, identify, session, a dashboard route, a 404, a 500 and every embed refusal carry frame-ancestors none', async () => {
      const site = await t.site(w);
      const off = await t.site(w);
      await t
        .as(w.owner)
        .put(`${dashboard(off)}/kill-switch`)
        .send({ on: true })
        .expect(200);

      const responses: [string, Awaited<ReturnType<typeof embed>>][] = [];
      const add = async (name: string, req: ReturnType<typeof embed>) =>
        responses.push([name, await req]);
      await add(
        'config ok',
        t
          .http()
          .get(`/api/widget/v1/config?key=${site.publishableKey}`)
          .set('Origin', ORIGIN),
      );
      await add(
        'config refused',
        t
          .http()
          .get(`/api/widget/v1/config?key=${site.publishableKey}`)
          .set('Origin', 'https://evil.example'),
      );
      await add(
        'config unknown',
        t.http().get('/api/widget/v1/config?key=nope').set('Origin', ORIGIN),
      );
      await add(
        'identify',
        t
          .http()
          .post('/api/widget/v1/identify')
          .set('Origin', ORIGIN)
          .send({ key: site.publishableKey, token: 'x' }),
      );
      await add(
        'session',
        t.http().get('/api/widget/v1/session').set('Origin', ORIGIN),
      );
      await add(
        'dashboard',
        t.as(w.owner).get(`/api/shops/${w.shop.id}/widget/sites`),
      );
      await add('404 page', t.http().get('/api/does-not-exist'));
      await add('embed unknown', embed(`pk_live_${'u'.repeat(24)}`));
      await add('embed malformed', embed('malformed'));
      await add('embed switched off', embed(off.publishableKey));
      jest
        .spyOn(WidgetPublicService.prototype, 'shapedConfig')
        .mockRejectedValue(new Error('boom'));
      await add(
        '500',
        t
          .http()
          .get(`/api/widget/v1/config?key=${site.publishableKey}`)
          .set('Origin', ORIGIN),
      );
      expect(responses.find(([n]) => n === '500')![1].status).toBe(500);

      for (const [name, res] of responses) {
        const csp = res.headers['content-security-policy'] as string;
        if (!csp || !csp.includes(NONE))
          throw new Error(`${name}: CSP ${csp} (status ${res.status})`);
        if (!res.headers['x-frame-options'])
          throw new Error(`${name}: no X-Frame-Options (status ${res.status})`);
      }
    });
  });

  describe('refusals and reflection (AS-37)', () => {
    it('S44 AS-37: a switched-off site, unknown, malformed and hostile keys are problem documents that never echo the key', async () => {
      const off = await t.site(w);
      await t
        .as(w.owner)
        .put(`${dashboard(off)}/kill-switch`)
        .send({ on: true })
        .expect(200);
      const hostile = '"><script>alert(1)</script>';
      const cases: [string, number, string][] = [
        [off.publishableKey, 410, 'widget_disabled'],
        [`pk_live_${'u'.repeat(24)}`, 404, 'widget_site_not_found'],
        ['malformed', 404, 'widget_site_not_found'],
        [hostile, 404, 'widget_site_not_found'],
      ];
      for (const [key, status, code] of cases) {
        const res = await embed(key);
        if (res.status !== status || res.body.code !== code)
          throw new Error(`${key}: ${res.status} ${res.text}`);
        expect(res.headers['content-type']).toMatch(
          /application\/problem\+json/,
        );
        expect(res.headers['content-security-policy']).toContain(NONE);
        expect(res.text).not.toContain('<script');
        expect(res.text).not.toContain('alert(1)');
        if (key !== off.publishableKey) expect(res.text).not.toContain(key);
      }
    });

    it('S44 AS-37: a site whose shop is suspended answers 410 widget_disabled', async () => {
      const site = await t.site(w);
      await embed(site.publishableKey).expect(200);
      await exec(
        t.app,
        `UPDATE "WidgetSite" SET "shopStatus" = 'SUSPENDED' WHERE id = :id`,
        { id: site.id },
      );
      await t.app.get(WidgetSiteCache).invalidate([site.publishableKey]);
      const res = await embed(site.publishableKey).expect(410);
      expect(res.body.code).toBe('widget_disabled');
    });
  });
});

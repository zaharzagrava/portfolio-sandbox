import * as jwt from 'jsonwebtoken';
import {
  createWidgetKit,
  ORIGIN,
  type WidgetKit,
  type WidgetWorld,
} from './testing/widget-kit';

/**
 * One journey over the whole widget surface (config, identify, embed, kill switch). The per-rule scenarios live in the
 * widget-*.e2e-spec.ts files; this one proves that the pieces compose for one site.
 */
describe('Widget: journey of one site', () => {
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

  it('S44 AS-14 AS-23 AS-35 AS-39: config for a registered origin, identify once, embed frameable by the site only, then the kill switch turns it all off', async () => {
    const site = await t.site(w);
    const config = (origin?: string) => {
      const req = t
        .http()
        .get(`/api/widget/v1/config?key=${site.publishableKey}`);
      return origin ? req.set('Origin', origin) : req;
    };

    const ok = await config(ORIGIN).expect(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers.vary).toContain('Origin');
    expect(ok.body.products).toEqual(expect.any(Array));
    const scheme = await config('http://www.my-shop.com').expect(403);
    expect(scheme.headers['access-control-allow-origin']).toBeUndefined();
    const noOrigin = await config().expect(403);
    expect(noOrigin.headers['access-control-allow-origin']).toBeUndefined();
    await config('https://evil-my-shop.com').expect(403);

    const token = t.handoff(site);
    const identify = (jwt: string) =>
      t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({ key: site.publishableKey, token: jwt });
    const res = await identify(token).expect(200);
    expect(res.body.customer).toEqual({
      id: 'cust-42',
      email: 'buyer@example.com',
    });
    expect(res.body.expiresIn).toBe(900);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(jwt.decode(res.body.widgetToken)).toMatchObject({
      site: site.id,
      shop: w.shop.id,
      ext: 'cust-42',
    });
    const replay = await identify(token).expect(401);
    expect(replay.body.widgetToken).toBeUndefined();
    const forged = await identify(
      t.handoff(site, {}, `wis_${'x'.repeat(43)}`),
    ).expect(401);
    expect(forged.body.widgetToken).toBeUndefined();

    const embed = () =>
      t.http().get(`/api/widget/v1/embed?key=${site.publishableKey}`);
    const framed = await embed().expect(200);
    expect(framed.headers['x-frame-options']).toBeUndefined();
    expect(framed.headers['content-security-policy']).toContain(
      `frame-ancestors https://shop.example:8443 ${ORIGIN}`,
    );

    await t
      .as(w.owner)
      .put(`/api/shops/${w.shop.id}/widget/sites/${site.id}/kill-switch`)
      .send({ on: true })
      .expect(200);
    const goneConfig = await config(ORIGIN).expect(410);
    expect(goneConfig.body.products).toBeUndefined();
    const goneEmbed = await embed().expect(410);
    expect(goneEmbed.text).not.toContain('<script');
    const afterKill = await identify(t.handoff(site));
    expect(afterKill.status).toBe(410);
  });
});

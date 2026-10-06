import { INestApplication, Module } from '@nestjs/common';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { WidgetModule } from './widget.module';
import { normalizeOrigin, WidgetService } from './application/widget.service';

@Module({ imports: [WidgetModule, RateLimitModule, SequelizeModule.forFeature([Shop])] })
class SpecModule {}

const ORIGIN = 'https://www.my-shop.com';

/** SD-01 against real Postgres + Redis. */
describe('Embeddable widget (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let widget: WidgetService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], { stores: ['redis'] });
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    seeds = app.get(SeedsService);
    widget = app.get(WidgetService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  const site = async () => {
    const shop = await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'My Shop', slug: `my-${v4().slice(0, 8)}` });
    const [product] = await seeds.createTreelike([{ __type__: TableName.Product, title: 'Earbuds', shopId: shop.id, quantity: 3 }]);
    return { shopId: shop.id, ...(await widget.createSite(shop.id, [ORIGIN, 'https://shop.example:8443'], [product.id])) };
  };

  const handoff = (pk: string, secret: string, extra: Partial<jwt.JwtPayload> = {}) =>
    jwt.sign({ sub: 'cust-42', email: 'buyer@example.com', jti: v4(), ...extra }, secret, { algorithm: 'HS256', audience: 'marketplace-widget', issuer: pk, expiresIn: 120 });

  it('config only for registered origins (exact match), echoed CORS origin, Vary: Origin', async () => {
    const s = await site();
    const ok = await http().get(`/api/widget/v1/config?key=${s.publishableKey}`).set('Origin', ORIGIN).expect(200);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers.vary).toContain('Origin');
    expect(ok.body.products).toEqual([expect.objectContaining({ title: 'Earbuds', inStock: true })]);

    await http().get(`/api/widget/v1/config?key=${s.publishableKey}`).set('Origin', 'https://evil-my-shop.com').expect(403);
    await http().get(`/api/widget/v1/config?key=${s.publishableKey}`).set('Origin', 'http://www.my-shop.com').expect(403); // scheme matters
    await http().get(`/api/widget/v1/config?key=${s.publishableKey}`).expect(403); // no Origin at all
    expect(normalizeOrigin('https://WWW.My-Shop.com/path?q=1')).toBe(ORIGIN);
  });

  it('identity hand-off: valid token → widget token; wrong secret, foreign issuer, long expiry or replay → 401', async () => {
    const s = await site();
    const identify = (token: string) => http().post('/api/widget/v1/identify').set('Origin', ORIGIN).send({ key: s.publishableKey, token });

    const token = handoff(s.publishableKey, s.identitySecret);
    const res = await identify(token).expect(200);
    expect(res.body.customer).toEqual({ id: 'cust-42', email: 'buyer@example.com' });
    expect(jwt.decode(res.body.widgetToken)).toMatchObject({ typ: 'widget', shop: s.shopId, ext: 'cust-42', aud: 'widget' });

    await identify(token).expect(401); // jti replay
    await identify(handoff(s.publishableKey, 'not-the-secret')).expect(401);
    await identify(handoff('pk_live_someoneelse', s.identitySecret)).expect(401);
    await identify(jwt.sign({ sub: 'x', jti: v4() }, s.identitySecret, { algorithm: 'HS256', audience: 'marketplace-widget', issuer: s.publishableKey, expiresIn: 3_600 })).expect(401);
  });

  it('embed page is frameable only by the site\'s origins; the kill switch turns the widget off', async () => {
    const s = await site();
    const embed = await http().get(`/api/widget/v1/embed?key=${s.publishableKey}`).expect(200);
    expect(embed.headers['content-security-policy']).toContain(`frame-ancestors ${ORIGIN} https://shop.example:8443`);
    expect(embed.headers['x-frame-options']).toBeUndefined();

    await widget.setKillSwitch(s.shopId, s.id, true);
    await http().get(`/api/widget/v1/config?key=${s.publishableKey}`).set('Origin', ORIGIN).expect(410);
    await http().get(`/api/widget/v1/embed?key=${s.publishableKey}`).expect(410);
  });
});

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import * as jwt from 'jsonwebtoken';
import {
  widgetIdentifySchema,
  widgetSessionSchema,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { v4 as uuidv4 } from 'uuid';
import { WidgetIdentityService } from './application/widget-identity.service';
import { WidgetSessionService } from './application/widget-session.service';
import { WidgetSiteCache } from './application/widget-site.cache';
import {
  createWidgetKit,
  exec,
  fastStoreOf,
  ORIGIN,
  restoreFastStore,
  rows,
  signWidgetHandoff,
  type CreatedSite,
  type WidgetKit,
  type WidgetWorld,
} from './testing/widget-kit';

const STRIP = (body: Record<string, unknown>) =>
  JSON.stringify({ ...body, requestId: undefined, instance: undefined });

describe('Widget: identity hand-off and widget session', () => {
  let t: WidgetKit;
  let w: WidgetWorld;
  let site: CreatedSite;

  beforeAll(async () => {
    t = await createWidgetKit();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    w = await t.world();
    site = await t.site(w);
  });
  afterEach(async () => {
    await restoreFastStore(t);
  });

  const identify = (
    token: unknown,
    over: { key?: string; origin?: string | null } = {},
  ) => {
    const req = t
      .http()
      .post('/api/widget/v1/identify')
      .send({ key: over.key ?? site.publishableKey, token });
    return over.origin === null
      ? req
      : req.set('Origin', over.origin ?? ORIGIN);
  };
  const markers = (siteId = site.id) =>
    t.app.get(RedisService).client.keys(`widget:jti:${siteId}:*`);
  const dashboard = () => `/api/shops/${w.shop.id}/widget/sites/${site.id}`;
  const session = (token: string, origin: string | null = ORIGIN) => {
    const req = t
      .http()
      .get('/api/widget/v1/session')
      .set('Authorization', `Bearer ${token}`);
    return origin === null ? req : req.set('Origin', origin);
  };
  const exchange = async (claims: Record<string, unknown> = {}) => {
    const res = await identify(t.handoff(site, claims)).expect(200);
    return widgetIdentifySchema.parse(res.body);
  };

  describe('exchange (AS-23)', () => {
    it('S44 AS-23: a valid hand-off token becomes a 900 second widget token with the documented claims and one single-use marker', async () => {
      const res = await identify(t.handoff(site));
      expect(res.status).toBe(200);
      const body = widgetIdentifySchema.parse(res.body);
      expect(body).toMatchObject({
        expiresIn: 900,
        customer: { id: 'cust-42', email: 'buyer@example.com' },
      });
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
      expect(res.headers['set-cookie']).toBeUndefined();

      const decoded = jwt.decode(body.widgetToken, { complete: true })!;
      const iat = Math.floor(t.clock.now().getTime() / 1000);
      expect(decoded.header.typ).toBe('widget+jwt');
      expect(decoded.payload).toMatchObject({
        typ: 'widget+jwt',
        aud: 'marketplace-widget-session',
        iss: 'marketplace',
        site: site.id,
        shop: w.shop.id,
        ext: 'cust-42',
        email: 'buyer@example.com',
        iat,
        exp: iat + 900,
      });
      expect((decoded.payload as jwt.JwtPayload).jti).toBeTruthy();

      const stored = await markers();
      expect(stored).toHaveLength(1);
      const ttl = await t.app.get(RedisService).client.ttl(stored[0]);
      expect(ttl).toBeGreaterThan(170);
      expect(ttl).toBeLessThanOrEqual(180); // token exp (120 s) + 60 s
    });

    it('S44 AS-23: a token without an e-mail gives email null', async () => {
      const res = await identify(t.handoff(site, { email: undefined })).expect(
        200,
      );
      expect(res.body.customer).toEqual({ id: 'cust-42', email: null });
    });
  });

  describe('claims policy and forgeries (AS-24, AS-25)', () => {
    it('S44 AS-24: a token that lives too long and one without a jti are the same 401, nothing stored', async () => {
      const now = Math.floor(t.clock.now().getTime() / 1000);
      const tooLong = await identify(
        t.handoff(site, { exp: now + 301 }),
      ).expect(401);
      const noJti = await identify(t.handoff(site, { jti: undefined })).expect(
        401,
      );
      expect(tooLong.body.code).toBe('identity_token_invalid');
      expect(STRIP(tooLong.body)).toBe(STRIP(noJti.body));
      expect(await markers()).toHaveLength(0);
    });

    it('S44 AS-25: 16 forged or tampered tokens are all the same 401 with no widget token and no marker', async () => {
      const now = Math.floor(t.clock.now().getTime() / 1000);
      const other = await t.site(w);
      const b64 = (o: object) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      const claims = {
        iss: site.publishableKey,
        aud: 'marketplace-widget',
        sub: 'cust-42',
        jti: uuidv4(),
        exp: now + 120,
      };
      const good = t.handoff(site);
      const [h, p] = good.split('.');
      const forged: [string, string][] = [
        ['another secret', t.handoff(site, {}, `wis_${'x'.repeat(43)}`)],
        ['a foreign issuer', t.handoff(site, { iss: other.publishableKey })],
        ['alg none', `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`],
        [
          'alg none with a signature part',
          `${b64({ alg: 'none', typ: 'JWT' })}.${p}.${good.split('.')[2]}`,
        ],
        [
          'HS384',
          signWidgetHandoff(site.identitySecret, claims, {
            algorithm: 'HS384',
          }),
        ],
        [
          'HS512',
          signWidgetHandoff(site.identitySecret, claims, {
            algorithm: 'HS512',
          }),
        ],
        [
          'RS256 header with our public text as the key',
          `${b64({ alg: 'RS256', typ: 'JWT' })}.${p}.${Buffer.from('-----BEGIN PUBLIC KEY-----').toString('base64url')}`,
        ],
        ['an hour of lifetime', t.handoff(site, { exp: now + 3600 })],
        ['expired', t.handoff(site, { exp: now - 1 })],
        ['a token of another site of the same shop', t.handoff(other)],
        ['not a JWT', 'definitely-not-a-jwt'],
        ['two parts', `${h}.${p}`],
        ['a wrong audience', t.handoff(site, { aud: 'marketplace-api' })],
        ['an audience list', t.handoff(site, { aud: ['marketplace-widget'] })],
        ['a missing subject', t.handoff(site, { sub: undefined })],
        [
          'a tampered payload',
          `${h}.${b64({ ...claims, sub: 'victim' })}.${good.split('.')[2]}`,
        ],
      ];
      expect(forged.length).toBeGreaterThanOrEqual(15);
      const bodies: string[] = [];
      for (const [name, token] of forged) {
        const res = await identify(token);
        if (res.status !== 401)
          throw new Error(`${name}: ${res.status} ${JSON.stringify(res.body)}`);
        expect(res.body.code).toBe('identity_token_invalid');
        expect(res.body.widgetToken).toBeUndefined();
        bodies.push(STRIP(res.body));
      }
      for (const b of bodies) expect(b).toBe(bodies[0]);
      expect(await markers()).toHaveLength(0);
      expect(await markers(other.id)).toHaveLength(0);
    });
  });

  describe('single use (AS-26, AS-27)', () => {
    it('S44 AS-26: a replay is refused; 20 simultaneous exchanges of one token give exactly one 200; the same jti is independent per site', async () => {
      const token = t.handoff(site);
      await identify(token).expect(200);
      const replay = await identify(token).expect(401);
      expect(replay.body.code).toBe('identity_token_invalid');

      const jti = uuidv4();
      const race = t.handoff(site, { jti });
      const results = await Promise.all(
        Array.from({ length: 20 }, () => identify(race)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(19);

      const other = await t.site(w);
      await identify(t.handoff(other, { jti }), {
        key: other.publishableKey,
      }).expect(200);
    });

    it('S44 AS-26: SC-003, of 1,000 simultaneous exchanges of one hand-off token exactly one succeeds', async () => {
      const identity = t.app.get(WidgetIdentityService);
      const view = (await t.app.get(WidgetSiteCache).get(site.publishableKey))!;
      const token = t.handoff(site, { jti: `race-${uuidv4()}` });
      const results = await Promise.allSettled(
        Array.from({ length: 1000 }, () => identity.identify(view, token)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(999);
      expect(await markers()).toHaveLength(1);
    });

    it('S44 AS-27: with the single-use store down a valid token gets 503 and no widget token, and is not consumed', async () => {
      // restoring the limiter moves the test clock by two minutes: the token must outlive that
      const token = t.handoff(site, {
        exp: Math.floor(t.clock.now().getTime() / 1000) + 290,
      });
      await fastStoreOf(t.app).deny('widget:jti:');
      const down = await identify(token);
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('service_unavailable');
      expect(down.body.widgetToken).toBeUndefined();
      await restoreFastStore(t);
      expect(await markers()).toHaveLength(0);
      await identify(token).expect(200);
      await identify(token).expect(401);
    });
  });

  describe('secret overlap (AS-28)', () => {
    it('S44 AS-28: tokens signed with the previous secret are accepted at T+24h-1s and refused at T+24h', async () => {
      const rotate = await t
        .as(w.owner)
        .post(`${dashboard()}/rotate-secret`)
        .send({ overlapHours: 24 })
        .expect(201);
      const next = rotate.body.identitySecret as string;
      const old = site.identitySecret;

      t.advance(24 * 3600 * 1000 - 1000);
      await identify(t.handoff(site, {}, old)).expect(200);
      await identify(t.handoff(site, {}, next)).expect(200);
      t.advance(1000);
      const refused = await identify(t.handoff(site, {}, old));
      expect(refused.status).toBe(401);
      expect(refused.body.code).toBe('identity_token_invalid');
      await identify(t.handoff(site, {}, next)).expect(200);
    });

    it('S44 AS-28: expire-previous-secret and overlapHours 0 refuse the previous secret at once', async () => {
      const rotate = await t
        .as(w.owner)
        .post(`${dashboard()}/rotate-secret`)
        .send({})
        .expect(201);
      await identify(t.handoff(site, {}, site.identitySecret)).expect(200);
      await t
        .as(w.owner)
        .post(`${dashboard()}/expire-previous-secret`)
        .send({})
        .expect(200);
      await identify(t.handoff(site, {}, site.identitySecret)).expect(401);
      await identify(t.handoff(site, {}, rotate.body.identitySecret)).expect(
        200,
      );

      const zero = await t
        .as(w.owner)
        .post(`${dashboard()}/rotate-secret`)
        .send({ overlapHours: 0 })
        .expect(201);
      await identify(t.handoff(site, {}, rotate.body.identitySecret)).expect(
        401,
      );
      await identify(t.handoff(site, {}, zero.body.identitySecret)).expect(200);
    });
  });

  describe('no account linking (AS-29)', () => {
    it('S44 AS-29: exchanging a token with the e-mail of a marketplace user creates and changes no user or session', async () => {
      const buyer = await t.newUser({ email: 'buyer@example.com' });
      const dynamo = t.app.get(DynamoService);
      const sessions = async () =>
        (
          await dynamo.doc.send(
            new ScanCommand({
              TableName: dynamo.table('Auth'),
              Select: 'COUNT',
              FilterExpression: 'begins_with(PK, :p)',
              ExpressionAttributeValues: { ':p': 'SESSION#' },
            }),
          )
        ).Count;
      const users = async () =>
        rows<Record<string, unknown>>(
          t.app,
          `SELECT id, email, "updatedAt" FROM "User" ORDER BY id`,
        );
      const before = { users: await users(), sessions: await sessions() };

      const body = await exchange({
        email: 'buyer@example.com',
        sub: 'shop-customer-7',
      });
      expect(body.customer).toEqual({
        id: 'shop-customer-7',
        email: 'buyer@example.com',
      });
      const claims = jwt.decode(body.widgetToken) as jwt.JwtPayload;
      expect(claims.ext).toBe('shop-customer-7');
      expect(claims.sub).toBeUndefined();

      expect({ users: await users(), sessions: await sessions() }).toEqual(
        before,
      );
      // the widget token is not a session of that user
      await t
        .http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${body.widgetToken}`)
        .expect(401);
      expect(buyer.id).toBeDefined();
    });
  });

  describe('order of checks (AS-30)', () => {
    it('S44 AS-30: key, then origin, then switch and shop status, then the token; a refused call never opens the token', async () => {
      const token = t.handoff(site);
      await t
        .as(w.owner)
        .put(`${dashboard()}/kill-switch`)
        .send({ on: true })
        .expect(200);
      const off = await identify(token).expect(410);
      expect(off.body.code).toBe('widget_disabled');
      const badOrigin = await identify(token, {
        origin: 'https://evil.example',
      }).expect(403);
      expect(badOrigin.body.code).toBe('origin_not_allowed');
      const unknown = await identify(token, {
        key: `pk_live_${'u'.repeat(24)}`,
      }).expect(404);
      expect(unknown.body.code).toBe('widget_site_not_found');
      expect(await markers()).toHaveLength(0);

      // the token was never opened: once the site is on again it still works
      await t
        .as(w.owner)
        .put(`${dashboard()}/kill-switch`)
        .send({ on: false })
        .expect(200);
      await identify(token).expect(200);
    });
  });

  describe('no ambient credentials (AS-31)', () => {
    it('S44 AS-31: a form or plain text body is 415 and nothing is evaluated', async () => {
      const token = t.handoff(site);
      const form = await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .type('form')
        .send({ key: site.publishableKey, token })
        .expect(415);
      expect(form.body.code).toBe('unsupported_media_type');
      await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .set('Content-Type', 'text/plain')
        .send(JSON.stringify({ key: site.publishableKey, token }))
        .expect(415);
      expect(await markers()).toHaveLength(0);
      await identify(token).expect(200);
    });

    it('S44 AS-31: a marketplace session cookie is no credential; without a token the answer is 401 identity_token_invalid', async () => {
      const { cookie } = t.cookieSession(w.owner);
      const res = await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .send({ key: site.publishableKey });
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('identity_token_invalid');
      expect(res.headers['set-cookie']).toBeUndefined();
      const ok = await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .set('Cookie', cookie)
        .send({ key: site.publishableKey, token: t.handoff(site) });
      expect(ok.status).toBe(200);
      expect(ok.headers['set-cookie']).toBeUndefined();
    });

    it('S44 AS-31: a body over 8 KiB is 413, a token over 4 KiB is 400, and no response sets a cookie', async () => {
      const big = await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({ key: site.publishableKey, token: 'x'.repeat(9000) });
      expect(big.status).toBe(413);
      expect(big.body.code).toBe('payload_too_large');
      const long = await identify('x'.repeat(5000));
      expect(long.status).toBe(400);
      expect(long.body.code).toBe('validation_failed');
      for (const res of [big, long])
        expect(res.headers['set-cookie']).toBeUndefined();
      const cfg = await t
        .http()
        .get(`/api/widget/v1/config?key=${site.publishableKey}`)
        .set('Origin', ORIGIN);
      expect(cfg.headers['set-cookie']).toBeUndefined();
    });
  });

  describe('session check and verifier (AS-32, AS-33)', () => {
    it('S44 AS-32: GET session answers for a valid token and the verifier returns the same principal', async () => {
      const { widgetToken } = await exchange();
      const res = await session(widgetToken).expect(200);
      const body = widgetSessionSchema.parse(res.body);
      expect(body).toMatchObject({
        site: { id: site.id },
        customer: { id: 'cust-42', email: 'buyer@example.com' },
      });
      expect(body.expiresAt).toBe(
        new Date(t.clock.now().getTime() + 900_000).toISOString(),
      );
      expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);

      const verifier = t.app.get(WidgetSessionService);
      expect(await verifier.verify(widgetToken, ORIGIN)).toEqual({
        siteId: site.id,
        shopId: w.shop.id,
        externalCustomerId: 'cust-42',
        email: 'buyer@example.com',
        expiresAt: body.expiresAt,
      });
      expect(await verifier.verify(widgetToken)).not.toBeNull();
    });

    it('S44 AS-32: an expired, malformed, mistyped or foreign-key token is 401 widget_token_invalid, no header too; the verifier gives null', async () => {
      const { widgetToken } = await exchange();
      const key = t.app.get(ApiConfigService).get('widget_token_key');
      const claims = jwt.decode(widgetToken) as jwt.JwtPayload;
      const sign = (
        over: object,
        secret = key,
        header: object = { typ: 'widget+jwt' },
      ) =>
        jwt.sign({ ...claims, ...over }, secret, {
          algorithm: 'HS256',
          header: { alg: 'HS256', ...header } as jwt.JwtHeader,
          noTimestamp: true,
        });
      const bad: [string, string][] = [
        ['malformed', 'not-a-token'],
        ['another audience', sign({ aud: 'marketplace-api' })],
        ['another type claim', sign({ typ: 'at+jwt' })],
        ['another type header', sign({}, key, { typ: 'at+jwt' })],
        ['another issuer', sign({ iss: 'someone' })],
        ['another key', sign({}, 'a-completely-different-key-of-32-bytes!!')],
      ];
      const verifier = t.app.get(WidgetSessionService);
      for (const [name, token] of bad) {
        const res = await session(token);
        if (res.status !== 401 || res.body.code !== 'widget_token_invalid')
          throw new Error(`${name}: ${res.status} ${JSON.stringify(res.body)}`);
        expect(await verifier.verify(token, ORIGIN)).toBeNull();
      }
      const none = await t
        .http()
        .get('/api/widget/v1/session')
        .set('Origin', ORIGIN)
        .expect(401);
      expect(none.body.code).toBe('widget_token_invalid');

      t.advance(901_000);
      const expired = await session(widgetToken).expect(401);
      expect(expired.body.code).toBe('widget_token_invalid');
      expect(await verifier.verify(widgetToken, ORIGIN)).toBeNull();
    });

    it('S44 AS-32: a deleted site is 401, a switched-off site or inactive shop 410, a removed origin 403; one decision for the verifier', async () => {
      const { widgetToken } = await exchange();
      const verifier = t.app.get(WidgetSessionService);

      const unregistered = await session(
        widgetToken,
        'https://evil.example',
      ).expect(403);
      expect(unregistered.body.code).toBe('origin_not_allowed');
      expect(
        await verifier.verify(widgetToken, 'https://evil.example'),
      ).toBeNull();
      const noOrigin = await session(widgetToken, null).expect(403);
      expect(noOrigin.body.code).toBe('origin_not_allowed');

      await t
        .as(w.owner)
        .put(`${dashboard()}/kill-switch`)
        .send({ on: true })
        .expect(200);
      const off = await session(widgetToken).expect(410);
      expect(off.body.code).toBe('widget_disabled');
      expect(await verifier.verify(widgetToken, ORIGIN)).toBeNull();
      await t
        .as(w.owner)
        .put(`${dashboard()}/kill-switch`)
        .send({ on: false })
        .expect(200);
      await session(widgetToken).expect(200);

      await exec(
        t.app,
        `UPDATE "WidgetSite" SET "shopStatus" = 'SUSPENDED' WHERE id = :id`,
        { id: site.id },
      );
      await t.app.get(WidgetSiteCache).invalidate([site.publishableKey]);
      await session(widgetToken).expect(410);
      expect(await verifier.verify(widgetToken)).toBeNull();
      await exec(
        t.app,
        `UPDATE "WidgetSite" SET "shopStatus" = 'ACTIVE' WHERE id = :id`,
        { id: site.id },
      );

      await t.as(w.owner).delete(dashboard()).expect(204);
      const gone = await session(widgetToken).expect(401);
      expect(gone.body.code).toBe('widget_token_invalid');
      expect(await verifier.verify(widgetToken, ORIGIN)).toBeNull();
    });

    it('S44 AS-33: a widget token opens no marketplace route; an access token, an sk_ key and a hand-off token are no widget token', async () => {
      const { widgetToken } = await exchange();
      await t
        .http()
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${widgetToken}`)
        .expect(401);
      await t
        .http()
        .get(`/api/shops/${w.shop.id}/widget/sites`)
        .set('Authorization', `Bearer ${widgetToken}`)
        .expect(401);

      for (const token of [
        w.owner.bearer.replace(/^Bearer /, ''),
        `sk_live_${'a'.repeat(12)}${'b'.repeat(32)}`,
        t.handoff(site),
      ]) {
        const res = await session(token).expect(401);
        expect(res.body.code).toBe('widget_token_invalid');
      }
      // and the reverse: a hand-off token is not accepted as a widget session
      expect(
        await t.app.get(WidgetSessionService).verify(t.handoff(site), ORIGIN),
      ).toBeNull();
    });
  });
});

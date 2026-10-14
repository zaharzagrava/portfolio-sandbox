import { Logger } from '@nestjs/common';
import {
  ORIGIN_REJECTION_REASONS,
  WIDGET_ERROR_CODES,
  widgetConfigSchema,
  widgetErrorCodeSchema,
  widgetIdentifySchema,
  widgetProblemSchema,
  widgetSecretRotatedSchema,
  widgetSiteChangedPayloadSchema,
  widgetSiteCreatedSchema,
  widgetSiteHistoryPageSchema,
  widgetSitePageSchema,
  widgetSiteSchema,
  widgetSessionSchema,
  widgetThemeSchema,
  WIDGET_PUBLISHABLE_KEY,
} from '@marketplace-sandbox/contracts';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { v4 as uuidv4 } from 'uuid';
import { ShopDeleted } from '@app/domains/tenancy';
import { WIDGET_ERROR_CATALOGUE } from './domain/widget-errors';
import { isPublishableKey } from './domain/site-rules';
import { validateTheme } from './domain/theme';
import { WidgetShopDeletedConsumer } from './infra/widget-consumers';
import {
  clearRateLimits,
  createWidgetKit,
  ORIGIN,
  rows,
  type CreatedSite,
  type WidgetKit,
  type WidgetWorld,
} from './testing/widget-kit';

const EVENT = 'developerplatform.widget_site_changed';

describe('Widget: events, observability and contracts', () => {
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

  const dashboard = (site: CreatedSite) =>
    `/api/shops/${w.shop.id}/widget/sites/${site.id}`;
  const envelopes = (aggregateId: string) =>
    rows<{ envelope: Record<string, unknown> }>(
      t.app,
      `SELECT payload AS envelope FROM "Outbox" WHERE "eventName" = :name AND "aggregateId" = :id ORDER BY "createdAt", id`,
      { name: EVENT, id: aggregateId },
    ).then((r) => r.map((x) => x.envelope));
  const changes = async (id: string) =>
    (await envelopes(id)).map((e) => (e.payload as { change: string }).change);

  describe('events (AS-51)', () => {
    it('S44 AS-51: every kind of change writes exactly one event of the common envelope, with no secret, key or origin list', async () => {
      const product = await t.product(w);
      const site = await t.site(w);
      const owner = t.as(w.owner);
      await owner
        .patch(dashboard(site))
        .send({ allowedOrigins: ['https://new.example'], expectedVersion: 1 })
        .expect(200);
      await owner
        .patch(dashboard(site))
        .send({
          featuredProductIds: [product.id],
          theme: { primaryColor: '#112233' },
          expectedVersion: 2,
        })
        .expect(200);
      const rotated = await owner
        .post(`${dashboard(site)}/rotate-secret`)
        .send({})
        .expect(201);
      await owner
        .post(`${dashboard(site)}/expire-previous-secret`)
        .send({})
        .expect(200);
      await owner
        .put(`${dashboard(site)}/kill-switch`)
        .send({ on: true })
        .expect(200);
      await owner
        .put(`${dashboard(site)}/kill-switch`)
        .send({ on: false })
        .expect(200);
      expect(await changes(site.id)).toEqual([
        'created',
        'origins_changed',
        'products_changed',
        'theme_changed',
        'secret_rotated',
        'previous_secret_expired',
        'kill_switch_on',
        'kill_switch_off',
      ]);
      await owner.delete(dashboard(site)).expect(204);
      expect((await changes(site.id)).slice(-1)).toEqual(['deleted']);

      const all = await envelopes(site.id);
      for (const e of all) {
        expect(e).toMatchObject({
          type: EVENT,
          version: 1,
          aggregateType: 'widget',
          aggregateId: site.id,
        });
        expect(e.eventId).toBeTruthy();
        expect(e.occurredAt).toBeTruthy();
        expect(widgetSiteChangedPayloadSchema.parse(e.payload)).toMatchObject({
          siteId: site.id,
          shopId: w.shop.id,
        });
      }
      const text = JSON.stringify(all);
      for (const forbidden of [
        site.identitySecret,
        rotated.body.identitySecret,
        site.publishableKey,
        ORIGIN,
        'new.example',
      ])
        expect(text).not.toContain(forbidden);
    });

    it('S44 AS-51: a no-op publishes nothing; a rolled-back change publishes nothing', async () => {
      const site = await t.site(w);
      const owner = t.as(w.owner);
      await owner
        .put(`${dashboard(site)}/kill-switch`)
        .send({ on: false })
        .expect(200);
      await owner
        .patch(dashboard(site))
        .send({
          allowedOrigins: [ORIGIN, 'https://shop.example:8443'],
          expectedVersion: 1,
        })
        .expect(200);
      expect(await changes(site.id)).toEqual(['created']);

      jest
        .spyOn(OutboxService.prototype, 'append')
        .mockRejectedValueOnce(new Error('outbox down'));
      const failed = await owner
        .put(`${dashboard(site)}/kill-switch`)
        .send({ on: true });
      expect(failed.status).toBe(500);
      const [row] = await rows<{ killSwitch: boolean; version: number }>(
        t.app,
        `SELECT "killSwitch", version FROM "WidgetSite" WHERE id = :id`,
        { id: site.id },
      );
      expect(row).toEqual({ killSwitch: false, version: 1 });
      expect(
        await rows(
          t.app,
          `SELECT 1 FROM "WidgetSiteChange" WHERE "siteId" = :id`,
          { id: site.id },
        ),
      ).toHaveLength(0);
      expect(await changes(site.id)).toEqual(['created']);
    });

    it('S44 AS-44: a shop deletion publishes one deleted event per site', async () => {
      const sites = [await t.site(w), await t.site(w)];
      await t.app
        .get(WidgetShopDeletedConsumer)
        .project([
          ShopDeleted.create(
            w.shop.id,
            9,
            { shopId: w.shop.id, shopVersion: 9 },
            t.clock.now(),
          ),
        ]);
      for (const s of sites)
        expect(await changes(s.id)).toEqual(['created', 'deleted']);
    });
  });

  describe('observability (AS-52)', () => {
    const counter = (name: string, labels: Record<string, string> = {}) =>
      MetricsRegistry.value(name, labels) ?? 0;

    it('S44 AS-52: counters move for every outcome, and no log line, label or error body holds a secret, token or e-mail', async () => {
      const logged: string[] = [];
      const capture = (...args: unknown[]) =>
        void logged.push(
          args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '),
        );
      for (const level of [
        'log',
        'warn',
        'error',
        'debug',
        'verbose',
        'fatal',
      ] as const)
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation(capture as never);
      const out = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(
          ((chunk: unknown) => (logged.push(String(chunk)), true)) as never,
        );
      const err = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(
          ((chunk: unknown) => (logged.push(String(chunk)), true)) as never,
        );

      const before = {
        configOk: counter('widget_config_requests_total', { result: 'ok' }),
        unknown: counter('widget_config_requests_total', {
          result: 'unknown_key',
        }),
        rejected: counter('widget_config_requests_total', {
          result: 'origin_rejected',
        }),
        disabled: counter('widget_config_requests_total', {
          result: 'disabled',
        }),
        identifyOk: counter('widget_identify_total', { result: 'ok' }),
        invalid: counter('widget_identify_total', { result: 'invalid' }),
        replay: counter('widget_identify_total', { result: 'replay' }),
        origin: counter('widget_origin_rejected_total'),
        embed: counter('widget_embed_total', { result: 'ok' }),
        killOn: counter('widget_kill_switch_total', { state: 'on' }),
      };

      const secrets: string[] = [];
      const product = await t.product(w);
      const site = await t.site(w, { featuredProductIds: [product.id] });
      secrets.push(site.identitySecret);
      const hand = t.handoff(site, { email: 'private-buyer@example.org' });
      secrets.push(hand, 'private-buyer@example.org');
      const ok = await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({ key: site.publishableKey, token: hand })
        .expect(200);
      secrets.push(ok.body.widgetToken);
      await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({ key: site.publishableKey, token: hand })
        .expect(401);
      const forged = t.handoff(
        site,
        {},
        'wis_forged-secret-0123456789012345678901234567',
      );
      secrets.push(forged);
      await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({ key: site.publishableKey, token: forged })
        .expect(401);
      await t
        .http()
        .get('/api/widget/v1/session')
        .set('Origin', ORIGIN)
        .set('Authorization', `Bearer ${ok.body.widgetToken}`)
        .expect(200);
      await t
        .http()
        .get(`/api/widget/v1/config?key=${site.publishableKey}`)
        .set('Origin', ORIGIN)
        .expect(200);
      await t
        .http()
        .get(`/api/widget/v1/config?key=${site.publishableKey}`)
        .set('Origin', 'https://evil.example')
        .expect(403);
      await t
        .http()
        .get(`/api/widget/v1/config?key=pk_live_${'z'.repeat(24)}`)
        .set('Origin', ORIGIN)
        .expect(404);
      await t
        .http()
        .get(`/api/widget/v1/embed?key=${site.publishableKey}`)
        .expect(200);
      const killed = await t
        .as(w.owner)
        .put(`${dashboard(site)}/kill-switch`)
        .send({ on: true })
        .expect(200);
      expect(killed.body.identitySecret).toBeUndefined();
      const refused = await t
        .http()
        .get(`/api/widget/v1/config?key=${site.publishableKey}`)
        .set('Origin', ORIGIN)
        .expect(410);
      await clearRateLimits(t.app);
      const bodies = [JSON.stringify(refused.body)];

      out.mockRestore();
      err.mockRestore();

      expect(
        counter('widget_config_requests_total', { result: 'ok' }) -
          before.configOk,
      ).toBe(1);
      expect(
        counter('widget_config_requests_total', { result: 'unknown_key' }) -
          before.unknown,
      ).toBe(1);
      expect(
        counter('widget_config_requests_total', { result: 'origin_rejected' }) -
          before.rejected,
      ).toBe(1);
      expect(
        counter('widget_config_requests_total', { result: 'disabled' }) -
          before.disabled,
      ).toBe(1);
      expect(
        counter('widget_identify_total', { result: 'ok' }) - before.identifyOk,
      ).toBe(1);
      expect(
        counter('widget_identify_total', { result: 'invalid' }) -
          before.invalid,
      ).toBe(1);
      expect(
        counter('widget_identify_total', { result: 'replay' }) - before.replay,
      ).toBe(1);
      expect(counter('widget_origin_rejected_total') - before.origin).toBe(1);
      expect(
        counter('widget_embed_total', { result: 'ok' }) - before.embed,
      ).toBe(1);
      expect(
        counter('widget_kill_switch_total', { state: 'on' }) - before.killOn,
      ).toBe(1);

      const haystack = [
        ...logged,
        ...bodies,
        ...[
          'widget_config_requests_total',
          'widget_identify_total',
          'widget_embed_total',
          'widget_kill_switch_total',
          'widget_origin_rejected_total',
          'widget_identify_rejected_total',
        ].flatMap((n) =>
          MetricsRegistry.labelSets(n).map((l) => JSON.stringify(l)),
        ),
      ].join('\n');
      for (const secret of secrets) expect(haystack).not.toContain(secret);
      expect(haystack).not.toMatch(/Bearer [A-Za-z0-9._-]{20,}/);
    });

    it('S44 AS-52: identify limited by the limiter is counted as rate_limited', async () => {
      const site = await t.site(w);
      const before = counter('widget_identify_total', {
        result: 'rate_limited',
      });
      for (let i = 0; i < 32; i += 1)
        await t
          .http()
          .post('/api/widget/v1/identify')
          .set('Origin', ORIGIN)
          .send({ key: site.publishableKey, token: 'x' });
      expect(
        counter('widget_identify_total', { result: 'rate_limited' }) - before,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  describe('errors and contract (AS-53)', () => {
    it('S44 AS-53: the code list of the contract package is the catalogue of the domain, each with a 4xx or 5xx status', () => {
      const own = Object.keys(WIDGET_ERROR_CATALOGUE);
      for (const code of own) expect(WIDGET_ERROR_CODES).toContain(code);
      for (const [code, [status]] of Object.entries(WIDGET_ERROR_CATALOGUE)) {
        expect(widgetErrorCodeSchema.safeParse(code).success).toBe(true);
        expect(status).toBeGreaterThanOrEqual(400);
      }
      for (const reason of ORIGIN_REJECTION_REASONS)
        expect(reason).toMatch(/^[a-z_]+$/);
    });

    it('S44 AS-53: every success body parses with its schema and every error is problem+json with a code from the closed list', async () => {
      const other = await t.world();
      const product = await t.product(w);
      const site = await t.site(w, { featuredProductIds: [product.id] });
      const owner = t.as(w.owner);
      const base = `/api/shops/${w.shop.id}/widget/sites`;

      widgetSiteCreatedSchema.parse(
        await owner
          .post(base)
          .send({ origins: [ORIGIN] })
          .expect(201)
          .then((r) => r.body),
      );
      widgetSitePageSchema.parse((await owner.get(base).expect(200)).body);
      widgetSiteSchema.parse(
        (await owner.get(`${base}/${site.id}`).expect(200)).body,
      );
      widgetSiteSchema.parse(
        (
          await owner
            .patch(`${base}/${site.id}`)
            .send({ name: 'n', expectedVersion: 1 })
            .expect(200)
        ).body,
      );
      const rotation = widgetSecretRotatedSchema.parse(
        (
          await owner
            .post(`${base}/${site.id}/rotate-secret`)
            .send({})
            .expect(201)
        ).body,
      );
      widgetSiteSchema.parse(
        (
          await owner
            .post(`${base}/${site.id}/expire-previous-secret`)
            .send({})
            .expect(200)
        ).body,
      );
      widgetSiteSchema.parse(
        (
          await owner
            .put(`${base}/${site.id}/kill-switch`)
            .send({ on: true })
            .expect(200)
        ).body,
      );
      widgetSiteSchema.parse(
        (
          await owner
            .put(`${base}/${site.id}/kill-switch`)
            .send({ on: false })
            .expect(200)
        ).body,
      );
      widgetSiteHistoryPageSchema.parse(
        (await owner.get(`${base}/${site.id}/history`).expect(200)).body,
      );
      widgetConfigSchema.parse(
        (
          await t
            .http()
            .get(`/api/widget/v1/config?key=${site.publishableKey}`)
            .set('Origin', ORIGIN)
            .expect(200)
        ).body,
      );
      const idn = await t
        .http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({
          key: site.publishableKey,
          token: t.handoff(site, {}, rotation.identitySecret),
        })
        .expect(200);
      widgetIdentifySchema.parse(idn.body);
      widgetSessionSchema.parse(
        (
          await t
            .http()
            .get('/api/widget/v1/session')
            .set('Origin', ORIGIN)
            .set('Authorization', `Bearer ${idn.body.widgetToken}`)
            .expect(200)
        ).body,
      );

      const unknownSite = uuidv4();
      const errors: [string, ReturnType<typeof owner.get>][] = [
        [
          'origin_invalid',
          owner.post(base).send({ origins: ['http://x.example'] }),
        ],
        ['validation_failed', owner.post(base).send({})],
        ['widget_site_not_found', owner.get(`${base}/${unknownSite}`)],
        [
          'site_version_conflict',
          owner
            .patch(`${base}/${site.id}`)
            .send({ name: 'x', expectedVersion: 99 }),
        ],
        [
          'featured_product_invalid',
          owner
            .patch(`${base}/${site.id}`)
            .send({ featuredProductIds: [uuidv4()], expectedVersion: 3 }),
        ],
        [
          'rotation_not_in_progress',
          owner.post(`${base}/${site.id}/expire-previous-secret`).send({}),
        ],
        ['permission_denied', t.as(w.viewer).get(base)],
        ['shop_not_found', t.as(other.owner).get(base)],
        [
          'origin_not_allowed',
          t
            .http()
            .get(`/api/widget/v1/config?key=${site.publishableKey}`)
            .set('Origin', 'https://evil.example'),
        ],
        [
          'widget_site_not_found',
          t.http().get('/api/widget/v1/config?key=nope').set('Origin', ORIGIN),
        ],
        [
          'identity_token_invalid',
          t
            .http()
            .post('/api/widget/v1/identify')
            .set('Origin', ORIGIN)
            .send({ key: site.publishableKey, token: 'bad' }),
        ],
        [
          'widget_token_invalid',
          t.http().get('/api/widget/v1/session').set('Origin', ORIGIN),
        ],
        [
          'unsupported_media_type',
          t
            .http()
            .post('/api/widget/v1/identify')
            .set('Origin', ORIGIN)
            .type('form')
            .send({ key: 'k' }),
        ],
      ];
      for (const [code, request] of errors) {
        const res = await request;
        if (res.body.code !== code)
          throw new Error(`${code}: ${res.status} ${JSON.stringify(res.body)}`);
        expect(res.headers['content-type']).toMatch(
          /application\/problem\+json/,
        );
        const problem = widgetProblemSchema.parse(res.body);
        expect(widgetErrorCodeSchema.safeParse(problem.code).success).toBe(
          true,
        );
        expect(problem.instance).toBeTruthy();
        expect(problem.requestId).toBeTruthy();
      }

      // a 5xx is generic: the cause never reaches the body
      const fresh = await t.site(w, { featuredProductIds: [product.id] });
      t.faults.catalogDown = true;
      const down = await t
        .http()
        .get(`/api/widget/v1/config?key=${fresh.publishableKey}`)
        .set('Origin', ORIGIN);
      t.faults.catalogDown = false;
      expect(down.status).toBe(503);
      expect(down.body.detail).not.toMatch(/catalog|down|error|stack/i);
      widgetProblemSchema.parse(down.body);
    });

    it('S44 AS-53: the domain rules and the contract schemas agree on themes and keys', () => {
      const themes: unknown[] = [
        {},
        { primaryColor: '#0a0B0c' },
        { borderRadius: '24px' },
        { borderRadius: '25px' },
        { fontFamily: 'mono' },
        { fontFamily: 'Comic Sans' },
        { buttonLabel: 'Buy' },
        { buttonLabel: '<b>' },
        { buttonLabel: '' },
        { nope: '#000000' },
        { primaryColor: 'red' },
        { buttonLabel: 'x'.repeat(41) },
      ];
      for (const theme of themes)
        expect(validateTheme(theme).ok).toBe(
          widgetThemeSchema.safeParse(theme).success,
        );
      for (const key of [
        'pk_live_abcdefghijklmnopqrstuvwx',
        'pk_live_x',
        '',
        'pk_test_abcdefghijklmnopqrstuvwx',
      ])
        expect(isPublishableKey(key)).toBe(WIDGET_PUBLISHABLE_KEY.test(key));
    });
  });
});

import { widgetSiteSchema } from '@marketplace-sandbox/contracts';
import { SecretBox } from '@app/domains/identity';
import { WidgetBackfill } from './infra/widget-shop-copy.backfill';
import {
  ShopDeleted,
  ShopQueryService,
  ShopStatusChanged,
  ShopUpdated,
} from '@app/domains/tenancy';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { v4 as uuidv4 } from 'uuid';
import {
  WidgetShopDeletedConsumer,
  WidgetShopStatusConsumer,
  WidgetShopUpdatedConsumer,
} from './infra/widget-consumers';
import { WidgetSessionService } from './application/widget-session.service';
import {
  clearRateLimits,
  createWidgetKit,
  exec,
  ORIGIN,
  outboxEvents,
  rows,
  type CreatedSite,
  type WidgetInstance,
  type WidgetKit,
  type WidgetWorld,
} from './testing/widget-kit';

const EVENT = 'developerplatform.widget_site_changed';

describe('Widget: kill switch and shop lifecycle (consumers)', () => {
  let t: WidgetKit;
  let second: WidgetInstance;
  let w: WidgetWorld;

  beforeAll(async () => {
    t = await createWidgetKit();
    second = await t.instance();
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
  const kill = (site: CreatedSite, body: unknown) =>
    t
      .as(w.owner)
      .put(`${dashboard(site)}/kill-switch`)
      .send(body as object);
  const call = {
    config: (http: () => ReturnType<typeof t.http>, site: CreatedSite) =>
      http()
        .get(`/api/widget/v1/config?key=${site.publishableKey}`)
        .set('Origin', ORIGIN),
    identify: (http: () => ReturnType<typeof t.http>, site: CreatedSite) =>
      http()
        .post('/api/widget/v1/identify')
        .set('Origin', ORIGIN)
        .send({ key: site.publishableKey, token: t.handoff(site) }),
    embed: (http: () => ReturnType<typeof t.http>, site: CreatedSite) =>
      http().get(`/api/widget/v1/embed?key=${site.publishableKey}`),
    session: (http: () => ReturnType<typeof t.http>, token: string) =>
      http()
        .get('/api/widget/v1/session')
        .set('Origin', ORIGIN)
        .set('Authorization', `Bearer ${token}`),
  };
  const identifyToken = async (site: CreatedSite): Promise<string> =>
    (await call.identify(t.http, site).expect(200)).body.widgetToken as string;
  const history = (siteId: string) =>
    rows<{
      change: string;
      fromValue: string;
      toValue: string;
      actorId: string;
      seq: number;
    }>(
      t.app,
      `SELECT change, "fromValue", "toValue", "actorId", seq::int AS seq FROM "WidgetSiteChange" WHERE "siteId" = :siteId ORDER BY seq`,
      { siteId },
    );

  describe('switch off (AS-39)', () => {
    it('S44 AS-39: off applies on the next request on both instances, with history, one event, and issued tokens stop', async () => {
      const site = await t.site(w);
      const token = await identifyToken(site);
      for (const http of [t.http, second.http]) {
        await call.config(http, site).expect(200);
        await call.session(http, token).expect(200);
      }

      const res = await kill(site, { on: true }).expect(200);
      expect(widgetSiteSchema.parse(res.body)).toMatchObject({
        killSwitch: true,
        version: 2,
      });
      const log = await history(site.id);
      expect(log).toEqual([
        expect.objectContaining({
          change: 'kill_switch_on',
          fromValue: 'false',
          toValue: 'true',
          actorId: w.owner.id,
        }),
      ]);
      const events = await outboxEvents(t.app, EVENT, { aggregateId: site.id });
      expect(events.map((e) => e.payload.change)).toEqual([
        'created',
        'kill_switch_on',
      ]);

      for (const http of [t.http, second.http]) {
        const cfg = await call.config(http, site).expect(410);
        expect(cfg.body.code).toBe('widget_disabled');
        expect(cfg.headers['cache-control']).toBe('public, s-maxage=30');
        expect(cfg.headers['access-control-allow-origin']).toBe(ORIGIN);
        for (const other of [
          call.identify(http, site),
          call.embed(http, site),
          call.session(http, token),
        ]) {
          const r = await other;
          expect(r.status).toBe(410);
          expect(r.body.code).toBe('widget_disabled');
          expect(r.headers['cache-control']).toBe('no-store');
        }
      }
      expect(
        await t.app.get(WidgetSessionService).verify(token, ORIGIN),
      ).toBeNull();

      const listed = await t
        .as(w.owner)
        .get(`${dashboard(site)}/history`)
        .expect(200);
      expect(listed.body.items).toHaveLength(1);
      expect(listed.body.items[0]).toMatchObject({
        change: 'kill_switch_on',
        from: 'false',
        to: 'true',
      });
    });
  });

  describe('idempotent and race-safe (AS-40)', () => {
    it('S44 AS-40: repeating the same value changes nothing: 200, no history, no event, same version', async () => {
      const site = await t.site(w);
      await kill(site, { on: true }).expect(200);
      const again = await kill(site, { on: true }).expect(200);
      expect(again.body.version).toBe(2);
      expect(await history(site.id)).toHaveLength(1);
      expect(
        await outboxEvents(t.app, EVENT, { aggregateId: site.id }),
      ).toHaveLength(2);
    });

    it('S44 AS-40: 10 concurrent switch-offs leave one history row and one event; 20 rounds', async () => {
      for (let round = 0; round < 20; round += 1) {
        await exec(t.app, `DELETE FROM "WidgetSite" WHERE "shopId" = :id`, {
          id: w.shop.id,
        });
        await clearRateLimits(t.app);
        const site = await t.site(w);
        const results = await Promise.all(
          Array.from({ length: 10 }, () => kill(site, { on: true })),
        );
        expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
        expect(await history(site.id)).toHaveLength(1);
        expect(
          (await outboxEvents(t.app, EVENT, { aggregateId: site.id })).filter(
            (e) => e.payload.change === 'kill_switch_on',
          ),
        ).toHaveLength(1);
      }
    });

    it('S44 AS-40: opposite switches at once both answer 200, the final state is the last committed change and the history chain is unbroken; 20 rounds', async () => {
      for (let round = 0; round < 20; round += 1) {
        await exec(t.app, `DELETE FROM "WidgetSite" WHERE "shopId" = :id`, {
          id: w.shop.id,
        });
        await clearRateLimits(t.app);
        const site = await t.site(w);
        const results = await Promise.all([
          kill(site, { on: true }),
          kill(site, { on: false }),
          kill(site, { on: true }),
          kill(site, { on: false }),
        ]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
        const log = await history(site.id);
        expect(log.length).toBeGreaterThanOrEqual(1);
        let state = 'false';
        for (const row of log) {
          expect(row.fromValue).toBe(state);
          expect(row.toValue).not.toBe(row.fromValue);
          state = row.toValue;
        }
        const [stored] = await rows<{ killSwitch: boolean }>(
          t.app,
          `SELECT "killSwitch" FROM "WidgetSite" WHERE id = :id`,
          { id: site.id },
        );
        expect(String(stored.killSwitch)).toBe(state);
        const events = (
          await outboxEvents(t.app, EVENT, { aggregateId: site.id })
        ).filter((e) => String(e.payload.change).startsWith('kill_switch'));
        expect(events).toHaveLength(log.length);
      }
    });
  });

  describe('restore (AS-41)', () => {
    it('S44 AS-41: switching on again restores service and emits kill_switch_off; malformed bodies are 400', async () => {
      const site = await t.site(w);
      await kill(site, { on: true }).expect(200);
      await call.config(t.http, site).expect(410);
      await kill(site, { on: false }).expect(200);
      await call.config(t.http, site).expect(200);
      const events = await outboxEvents(t.app, EVENT, { aggregateId: site.id });
      expect(events.map((e) => e.payload.change)).toEqual([
        'created',
        'kill_switch_on',
        'kill_switch_off',
      ]);
      const version = (await t.as(w.owner).get(dashboard(site))).body.version;

      for (const bad of [
        { on: 'yes' },
        {},
        { on: true, extra: 1 },
        { on: null },
      ]) {
        const res = await kill(site, bad).expect(400);
        expect(res.body.code).toBe('validation_failed');
      }
      const noBody = await t
        .as(w.owner)
        .put(`${dashboard(site)}/kill-switch`)
        .expect(400);
      expect(noBody.body.code).toBe('validation_failed');
      expect((await t.as(w.owner).get(dashboard(site))).body.version).toBe(
        version,
      );
    });
  });

  describe('consumers (AS-42 … AS-45)', () => {
    const envelope = <T extends { create: (...a: never[]) => EventEnvelope }>(
      definition: T,
      shopId: string,
      shopVersion: number,
      payload: object,
    ): EventEnvelope =>
      (
        definition.create as (
          id: string,
          v: number,
          p: object,
          at?: Date,
        ) => EventEnvelope
      )(shopId, shopVersion, payload, t.clock.now());
    const updated = (shopId: string, shopVersion: number, name: string) =>
      envelope(ShopUpdated, shopId, shopVersion, {
        shopId,
        name,
        slug: 'my-shop',
        shopVersion,
      });
    const status = (
      shopId: string,
      shopVersion: number,
      to: string,
      from = 'ACTIVE',
    ) =>
      envelope(ShopStatusChanged, shopId, shopVersion, {
        shopId,
        from,
        to,
        shopVersion,
      });
    const deleted = (shopId: string, shopVersion = 9) =>
      envelope(ShopDeleted, shopId, shopVersion, { shopId, shopVersion });
    const copyOf = async (id: string) =>
      (
        await rows<{
          shopName: string;
          shopStatus: string;
          shopVersion: number;
        }>(
          t.app,
          `SELECT "shopName", "shopStatus", "shopVersion"::int AS "shopVersion" FROM "WidgetSite" WHERE id = :id`,
          { id },
        )
      )[0];
    const consumers = () => ({
      updated: t.app.get(WidgetShopUpdatedConsumer),
      status: t.app.get(WidgetShopStatusConsumer),
      deleted: t.app.get(WidgetShopDeletedConsumer),
    });

    it('S44 AS-42: a rename applies to every site of the shop, an older or repeated event changes nothing, other shops are untouched', async () => {
      const other = await t.world();
      const a = await t.site(w);
      const b = await t.site(w);
      const foreign = await t.site(other);
      await call.config(t.http, a).expect(200);

      await consumers().updated.project([updated(w.shop.id, 6, 'My Shop 2')]);
      expect(await copyOf(a.id)).toMatchObject({
        shopName: 'My Shop 2',
        shopVersion: 6,
      });
      expect(await copyOf(b.id)).toMatchObject({
        shopName: 'My Shop 2',
        shopVersion: 6,
      });
      expect(await copyOf(foreign.id)).toMatchObject({
        shopName: 'My Shop',
        shopVersion: 1,
      });
      expect((await call.config(t.http, a).expect(200)).body.shop.name).toBe(
        'My Shop 2',
      );
      expect(
        (await call.config(second.http, a).expect(200)).body.shop.name,
      ).toBe('My Shop 2');

      await consumers().updated.project([updated(w.shop.id, 4, 'Old')]);
      await consumers().updated.project([updated(w.shop.id, 6, 'Duplicate')]);
      expect(await copyOf(a.id)).toMatchObject({
        shopName: 'My Shop 2',
        shopVersion: 6,
      });
    });

    it('S44 AS-43: a suspension answers 410 everywhere without touching the switch; reactivation restores; the higher version wins out of order', async () => {
      const site = await t.site(w);
      const token = await identifyToken(site);
      await consumers().status.project([status(w.shop.id, 7, 'SUSPENDED')]);
      for (const http of [t.http, second.http]) {
        for (const r of [
          call.config(http, site),
          call.identify(http, site),
          call.embed(http, site),
          call.session(http, token),
        ])
          expect((await r).status).toBe(410);
      }
      expect(
        (
          await rows<{ killSwitch: boolean }>(
            t.app,
            `SELECT "killSwitch" FROM "WidgetSite" WHERE id = :id`,
            { id: site.id },
          )
        )[0].killSwitch,
      ).toBe(false);

      await consumers().status.project([
        status(w.shop.id, 8, 'ACTIVE', 'SUSPENDED'),
      ]);
      await call.config(t.http, site).expect(200);
      await call.session(second.http, token).expect(200);

      // reverse order on a second shop: the later version arrives first
      const other = await t.world();
      const o = await t.site(other);
      await consumers().status.project([
        status(other.shop.id, 8, 'ACTIVE', 'SUSPENDED'),
      ]);
      await consumers().status.project([status(other.shop.id, 7, 'SUSPENDED')]);
      await call.config(t.http, o).expect(200);
      expect(await copyOf(o.id)).toMatchObject({
        shopStatus: 'ACTIVE',
        shopVersion: 8,
      });

      for (const [i, to] of ['DELETING', 'DELETED'].entries()) {
        await consumers().status.project([status(other.shop.id, 20 + i, to)]);
        await call.config(t.http, o).expect(410);
      }
    });

    it('S44 AS-44: shop deleted removes the sites and their history, emits one deleted event per site, and is idempotent', async () => {
      const sites = [await t.site(w), await t.site(w), await t.site(w)];
      await kill(sites[0], { on: true }).expect(200);
      expect(await history(sites[0].id)).toHaveLength(1);

      await consumers().deleted.project([deleted(w.shop.id)]);
      expect(
        await rows(t.app, `SELECT 1 FROM "WidgetSite" WHERE "shopId" = :id`, {
          id: w.shop.id,
        }),
      ).toHaveLength(0);
      expect(
        await rows(
          t.app,
          `SELECT 1 FROM "WidgetSiteChange" WHERE "shopId" = :id`,
          { id: w.shop.id },
        ),
      ).toHaveLength(0);
      for (const s of sites) {
        const events = await outboxEvents(t.app, EVENT, { aggregateId: s.id });
        expect(
          events.filter((e) => e.payload.change === 'deleted'),
        ).toHaveLength(1);
        for (const http of [t.http, second.http]) {
          const r = await call.config(http, s);
          expect([r.status, r.body.code]).toEqual([
            404,
            'widget_site_not_found',
          ]);
        }
      }
      await consumers().deleted.project([deleted(w.shop.id)]);
      await consumers().deleted.project([deleted(uuidv4())]);
      for (const s of sites)
        expect(
          (await outboxEvents(t.app, EVENT, { aggregateId: s.id })).filter(
            (e) => e.payload.change === 'deleted',
          ),
        ).toHaveLength(1);
    });

    it('S44 AS-45: invalid payloads are dead-lettered without effect for each consumer; a valid message delivered twice has one effect', async () => {
      const site = await t.site(w);
      const before = await copyOf(site.id);
      const tamper = (
        base: EventEnvelope,
        payload: Record<string, unknown>,
        over: Partial<EventEnvelope> = {},
      ): EventEnvelope => ({
        ...base,
        ...over,
        payload,
      });
      const cases: [
        string,
        ReturnType<typeof consumers>[keyof ReturnType<typeof consumers>],
        EventEnvelope[],
      ][] = [
        [
          'shop_updated',
          consumers().updated,
          [
            tamper(updated(w.shop.id, 6, 'x'), {
              name: 'x',
              slug: 's',
              shopVersion: 6,
            }),
            tamper(updated(w.shop.id, 6, 'x'), {
              shopId: 'not-a-uuid',
              name: 'x',
              slug: 's',
              shopVersion: 6,
            }),
            tamper(updated(w.shop.id, 6, 'x'), {
              shopId: w.shop.id,
              name: 'x',
              slug: 's',
              shopVersion: 6.5,
            }),
            { ...updated(w.shop.id, 6, 'x'), version: 2 },
          ],
        ],
        [
          'shop_status_changed',
          consumers().status,
          [
            tamper(status(w.shop.id, 7, 'SUSPENDED'), {
              from: 'ACTIVE',
              to: 'SUSPENDED',
              shopVersion: 7,
            }),
            tamper(status(w.shop.id, 7, 'SUSPENDED'), {
              shopId: 'nope',
              from: 'ACTIVE',
              to: 'SUSPENDED',
              shopVersion: 7,
            }),
            tamper(status(w.shop.id, 7, 'SUSPENDED'), {
              shopId: w.shop.id,
              from: 'ACTIVE',
              to: 'EXPLODED',
              shopVersion: 7,
            }),
            tamper(status(w.shop.id, 7, 'SUSPENDED'), {
              shopId: w.shop.id,
              from: 'ACTIVE',
              to: 'SUSPENDED',
              shopVersion: 'seven',
            }),
            { ...status(w.shop.id, 7, 'SUSPENDED'), version: 2 },
          ],
        ],
        [
          'shop_deleted',
          consumers().deleted,
          [
            tamper(deleted(w.shop.id), { shopVersion: 9 }),
            tamper(deleted(w.shop.id), { shopId: 'nope', shopVersion: 9 }),
            tamper(deleted(w.shop.id), { shopId: w.shop.id, shopVersion: 1.5 }),
            { ...deleted(w.shop.id), version: 2 },
          ],
        ],
      ];
      for (const [name, consumer, invalid] of cases)
        for (const bad of invalid) {
          await expect(
            (
              consumer as { project(e: EventEnvelope[]): Promise<void> }
            ).project([bad]),
          ).rejects.toBeInstanceOf(PermanentError);
          expect(await copyOf(site.id)).toEqual(before);
          expect(name).toBeTruthy();
        }

      const dup = updated(w.shop.id, 6, 'Once');
      await consumers().updated.project([dup, dup]);
      expect(await copyOf(site.id)).toMatchObject({
        shopName: 'Once',
        shopVersion: 6,
      });
      const sup = status(w.shop.id, 7, 'SUSPENDED');
      await consumers().status.project([sup, sup]);
      expect(await copyOf(site.id)).toMatchObject({
        shopStatus: 'SUSPENDED',
        shopVersion: 7,
      });
      const del = deleted(w.shop.id);
      await consumers().deleted.project([del, del]);
      expect(
        (await outboxEvents(t.app, EVENT, { aggregateId: site.id })).filter(
          (e) => e.payload.change === 'deleted',
        ),
      ).toHaveLength(1);
    });
  });

  describe('backfill of existing rows (G-09, G-21)', () => {
    it('S44 AS-46: the backfill seals old secrets with the site context and fills the shop copy once; a second run changes nothing', async () => {
      const box = t.app.get(SecretBox);
      const id = uuidv4();
      const secret = `wis_${'l'.repeat(43)}`;
      await exec(
        t.app,
        `INSERT INTO "WidgetSite" (id, "shopId", "publishableKey", "allowedOrigins", "identitySecretSealed")
         VALUES (:id, :shopId, :key, ARRAY[:origin]::text[], :sealed)`,
        {
          id,
          shopId: w.shop.id,
          key: `pk_live_${'l'.repeat(24)}`,
          origin: ORIGIN,
          sealed: box.seal(secret), // legacy: no context
        },
      );
      const read = () =>
        rows<{
          identitySecretSealed: string;
          shopName: string;
          shopVersion: number;
        }>(
          t.app,
          `SELECT "identitySecretSealed", "shopName", "shopVersion"::int AS "shopVersion" FROM "WidgetSite" WHERE id = :id`,
          { id },
        ).then((r) => r[0]);
      expect(await read()).toMatchObject({ shopName: '', shopVersion: 0 });

      const backfill = t.app.get(WidgetBackfill);
      const first = await backfill.run();
      expect(first.resealed).toBeGreaterThanOrEqual(1);
      const after = await read();
      expect(after).toMatchObject({ shopName: 'My Shop', shopVersion: 1 });
      expect(after.identitySecretSealed.startsWith('v2.')).toBe(true);
      expect(box.open(after.identitySecretSealed, `widget-site:${id}`)).toBe(
        secret,
      );

      const second = await backfill.run();
      expect(second.resealed).toBe(0);
      expect(second.shopCopies).toBe(0);
      expect(await read()).toEqual(after);
    });
  });

  describe('creation seeds the copy (AS-46)', () => {
    it('S44 AS-46: the shop is read once through the exported service and stored with its version; older events are ignored, newer apply', async () => {
      await exec(
        t.app,
        `UPDATE "Shop" SET "shopVersion" = 12, name = 'Twelve' WHERE id = :id`,
        { id: w.shop.id },
      );
      const spy = jest.spyOn(ShopQueryService.prototype, 'getShopsByIds');
      const site = await t.site(w);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toEqual([w.shop.id]);
      const [copy] = await rows<{
        shopName: string;
        shopStatus: string;
        shopVersion: number;
      }>(
        t.app,
        `SELECT "shopName", "shopStatus", "shopVersion"::int AS "shopVersion" FROM "WidgetSite" WHERE id = :id`,
        { id: site.id },
      );
      expect(copy).toEqual({
        shopName: 'Twelve',
        shopStatus: 'ACTIVE',
        shopVersion: 12,
      });

      const consumer = t.app.get(WidgetShopUpdatedConsumer);
      await consumer.project([
        envelope12(w.shop.id, 12, 'Same version'),
        envelope12(w.shop.id, 11, 'Older'),
      ]);
      const [same] = await rows<{ shopName: string }>(
        t.app,
        `SELECT "shopName" FROM "WidgetSite" WHERE id = :id`,
        { id: site.id },
      );
      expect(same.shopName).toBe('Twelve');
      await consumer.project([envelope12(w.shop.id, 13, 'Newer')]);
      const [newer] = await rows<{ shopName: string }>(
        t.app,
        `SELECT "shopName" FROM "WidgetSite" WHERE id = :id`,
        { id: site.id },
      );
      expect(newer.shopName).toBe('Newer');
    });

    it('S44 AS-46: a failing lookup is 503 and an unknown shop 404, and no site is created', async () => {
      jest
        .spyOn(ShopQueryService.prototype, 'getShopsByIds')
        .mockRejectedValueOnce(new Error('tenancy down'));
      const down = await t
        .as(w.owner)
        .post(`/api/shops/${w.shop.id}/widget/sites`)
        .send({ origins: [ORIGIN] });
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('service_unavailable');
      jest
        .spyOn(ShopQueryService.prototype, 'getShopsByIds')
        .mockResolvedValueOnce(new Map());
      const missing = await t
        .as(w.owner)
        .post(`/api/shops/${w.shop.id}/widget/sites`)
        .send({ origins: [ORIGIN] });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('shop_not_found');
      expect(
        await rows(t.app, `SELECT 1 FROM "WidgetSite" WHERE "shopId" = :id`, {
          id: w.shop.id,
        }),
      ).toHaveLength(0);
    });

    const envelope12 = (
      shopId: string,
      shopVersion: number,
      name: string,
    ): EventEnvelope =>
      ShopUpdated.create(
        shopId,
        shopVersion,
        { shopId, name, slug: 'my-shop', shopVersion },
        t.clock.now(),
      );
  });
});

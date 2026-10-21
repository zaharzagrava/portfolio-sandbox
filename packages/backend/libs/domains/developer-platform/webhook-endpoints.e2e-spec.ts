import {
  createdWebhookEndpointSchema,
  WEBHOOK_EVENT_TYPES,
  webhookEndpointPageSchema,
  webhookEndpointSchema,
  webhookEventTypesResponseSchema,
} from '@marketplace-sandbox/contracts';
import { SecretBox } from '@app/domains/identity';
import { ApiVersionService } from './application/api-version.service';
import { BreakerStore } from './domain/webhook-ports';
import {
  createWebhookKit,
  type WebhookKit,
  type WebhookWorld,
} from './testing/webhook-e2e.fixture';
import {
  clearRateLimits,
  fastStoreOf,
  waitFor,
} from './testing/public-api-kit';

const EVENT = 'developerplatform.webhook_endpoint_changed';
const PUBLIC_ADDRESS = '93.184.216.34';

interface Row {
  id: string;
  shopId: string;
  url: string;
  urlNormalized: string;
  events: string[];
  apiVersion: string;
  status: string;
  disabledReason: string | null;
  failingSince: Date | null;
  secretSealed: string;
  previousSecretSealed: string | null;
  previousSecretExpiresAt: Date | null;
  createdAt: Date;
}

describe('Webhooks: endpoint management (dashboard)', () => {
  let t: WebhookKit;
  let w: WebhookWorld;

  beforeAll(async () => {
    t = await createWebhookKit();
  }, 120_000);
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    await clearRateLimits(t.app);
    w = await t.seedWorld();
  });

  const base = (world: { shop: { id: string } } = w) => t.base(world);
  const owner = () => t.as(w.owner);
  const mk = (url = t.endpointUrl(), events: string[] = ['order.paid']) => ({
    url,
    events,
  });
  const create = (body: object = mk(), world: WebhookWorld = w) =>
    t.as(world.owner).post(base(world)).send(body);
  const created = async (body: object = mk(), world: WebhookWorld = w) => {
    const res = await create(body, world);
    if (res.status !== 201)
      throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
    return createdWebhookEndpointSchema.parse(res.body);
  };
  const row = async (id: string) =>
    (
      await t.rows<Row>(`SELECT * FROM "WebhookEndpoint" WHERE id = :id`, {
        id,
      })
    )[0];
  const count = async (shopId = w.shop.id) =>
    (
      await t.rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM "WebhookEndpoint" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0].n;
  const counter = async (shopId = w.shop.id) =>
    (
      await t.rows<{ endpoints: number }>(
        `SELECT endpoints FROM "WebhookShopCounter" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0]?.endpoints ?? 0;
  const history = (endpointId: string) =>
    t.rows<{
      facet: string;
      fromValue: string | null;
      toValue: string | null;
      actorId: string | null;
    }>(
      `SELECT facet, "fromValue", "toValue", "actorId" FROM "WebhookEndpointHistory"
        WHERE "endpointId" = :endpointId ORDER BY "createdAt", id`,
      { endpointId },
    );
  const changes = async (endpointId: string) =>
    (await t.outboxEvents(EVENT, { aggregateId: endpointId })).map(
      (e) => e.payload.change as string,
    );
  const strip = (b: Record<string, unknown>) => ({
    ...b,
    requestId: undefined,
    instance: undefined,
  });
  /** Frees the shop's slots (and counter) between rounds of a repeated test. */
  const emptyShop = async () => {
    await t.exec(`DELETE FROM "WebhookEndpoint" WHERE "shopId" = :id`, {
      id: w.shop.id,
    });
    await t.exec(`DELETE FROM "WebhookShopCounter" WHERE "shopId" = :id`, {
      id: w.shop.id,
    });
    await clearRateLimits(t.app);
  };

  /**
   * Runs `rounds` rounds of a repeated test, `size` at a time. Each round gets a shop of its own (so the rounds share no
   * endpoint slots, counters or rate-limit allowance) and the rounds of one batch run at the same time.
   */
  const inRounds = async (
    rounds: number,
    size: number,
    round: (world: WebhookWorld, index: number) => Promise<void>,
  ): Promise<WebhookWorld[]> => {
    const worlds: WebhookWorld[] = [];
    for (let from = 0; from < rounds; from += size)
      await Promise.all(
        Array.from({ length: Math.min(size, rounds - from) }, async (_, k) => {
          const world = await t.seedWorld();
          worlds[from + k] = world;
          await round(world, from + k);
        }),
      );
    return worlds;
  };

  describe('create and read (AS-01, AS-04, AS-06)', () => {
    it('S43 AS-01: an owner creates an endpoint; the secret is shown once and sealed at rest, with a history row and one outbox event', async () => {
      const url = t.endpointUrl();
      const res = await create({
        url,
        events: ['order.paid', 'product.stock_low'],
      });
      expect(res.status).toBe(201);
      const body = createdWebhookEndpointSchema.parse(res.body);
      expect(body).toMatchObject({
        url,
        events: ['order.paid', 'product.stock_low'],
        status: 'enabled',
      });

      const stored = await row(body.id);
      expect(stored).toMatchObject({
        shopId: w.shop.id,
        status: 'enabled',
        disabledReason: null,
        failingSince: null,
        previousSecretSealed: null,
      });
      expect(stored.secretSealed).not.toContain(body.secret);
      expect(
        t.app
          .get(SecretBox)
          .open(stored.secretSealed, `webhook-endpoint:${body.id}`),
      ).toBe(body.secret);
      expect(await counter()).toBe(1);

      const hist = await history(body.id);
      expect(hist).toHaveLength(1);
      expect(hist[0]).toMatchObject({ facet: 'created', actorId: w.owner.id });
      const events = await t.outboxEvents(EVENT, { aggregateId: body.id });
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        endpointId: body.id,
        shopId: w.shop.id,
        change: 'created',
        actorId: w.owner.id,
      });

      const read = await owner().get(`${base()}/${body.id}`).expect(200);
      expect(read.body).not.toHaveProperty('secret');
      expect(JSON.stringify(read.body)).not.toContain(body.secret);
      const parsed = webhookEndpointSchema.parse(read.body);
      expect(parsed).toMatchObject({
        id: body.id,
        status: 'enabled',
        disabledReason: null,
        failingSince: null,
        breaker: 'closed',
        hasPreviousSecret: false,
        previousSecretExpiresAt: null,
      });
    });

    it("S43 AS-04: the default apiVersion is the shop's S42 pin, else the latest; an explicit supported value wins; a later pin change leaves the endpoint alone", async () => {
      const versions = t.app.get(ApiVersionService);
      const [older, newer] = [...versions.supportedVersions()].sort();
      const other = await t.seedWorld();
      await versions.pin(w.shop.id, older, w.owner.id);

      const pinned = await created();
      expect(pinned.apiVersion).toBe(older);
      const unpinned = await created(mk(), other);
      expect(unpinned.apiVersion).toBe(versions.latestVersion());
      const explicit = await created({ ...mk(), apiVersion: newer });
      expect(explicit.apiVersion).toBe(newer);
      expect(
        (await created({ ...mk(), apiVersion: 'latest' })).apiVersion,
      ).toBe(versions.latestVersion());

      await versions.pin(w.shop.id, newer, w.owner.id);
      expect((await row(pinned.id)).apiVersion).toBe(older);
    });

    it('S43 AS-06: reading one endpoint; unknown id is 404 webhook_endpoint_not_found, a non-uuid is 400', async () => {
      const e = await created();
      const res = await owner().get(`${base()}/${e.id}`).expect(200);
      expect(webhookEndpointSchema.parse(res.body).id).toBe(e.id);
      const unknown = await owner()
        .get(`${base()}/00000000-0000-4000-8000-000000000000`)
        .expect(404);
      expect(unknown.body.code).toBe('webhook_endpoint_not_found');
      await owner().get(`${base()}/not-a-uuid`).expect(400);
    });
  });

  describe('validation and the address guard (AS-02, AS-03)', () => {
    const stateOfShop = async () => ({
      endpoints: await count(),
      history: (
        await t.rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM "WebhookEndpointHistory" WHERE "shopId" = :id`,
          { id: w.shop.id },
        )
      )[0].n,
      outbox: (await t.outboxEvents(EVENT)).length,
    });

    it.each([
      ['no url', { events: ['order.paid'] }, 'url'],
      ['url not a string', { url: 5, events: ['order.paid'] }, 'url'],
      [
        'url over 2,048 characters',
        {
          url: `https://a.acme.test/${'x'.repeat(2100)}`,
          events: ['order.paid'],
        },
        'url',
      ],
      ['events missing', { url: 'https://a.acme.test/in' }, 'events'],
      ['events empty', { url: 'https://a.acme.test/in', events: [] }, 'events'],
      [
        'unknown event type',
        { url: 'https://a.acme.test/in', events: ['order.exploded'] },
        'events',
      ],
      [
        'duplicate event types',
        { url: 'https://a.acme.test/in', events: ['order.paid', 'order.paid'] },
        'events',
      ],
      [
        'more than 20 types',
        {
          url: 'https://a.acme.test/in',
          events: Array.from(
            { length: 21 },
            (_, i) => WEBHOOK_EVENT_TYPES[i % 11],
          ),
        },
        'events',
      ],
      [
        'apiVersion not supported',
        {
          url: 'https://a.acme.test/in',
          events: ['order.paid'],
          apiVersion: '1999-01-01',
        },
        'apiVersion',
      ],
      [
        'unknown property',
        { url: 'https://a.acme.test/in', events: ['order.paid'], foo: 1 },
        'foo',
      ],
      [
        'url not parseable',
        { url: 'not a url', events: ['order.paid'] },
        'url',
      ],
    ])(
      'S43 AS-02: %s answers 400 validation_failed naming the field and writes nothing',
      async (_name, body, field) => {
        const before = await stateOfShop();
        const res = await create(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('validation_failed');
        const fields = (res.body.errors as { field: string }[]).map(
          (e) => e.field,
        );
        expect(fields.some((f) => f.startsWith(field))).toBe(true);
        expect(await stateOfShop()).toEqual(before);
      },
    );

    const host = () =>
      `hooks-${Math.random().toString(16).slice(2, 14)}.acme.test`;
    const guardCases: [
      string,
      (h: string) => string,
      string[] | null,
      string,
    ][] = [
      ['http scheme', (h) => `http://${h}/in`, [PUBLIC_ADDRESS], 'not_https'],
      [
        'user-info',
        (h) => `https://user:pw@${h}/in`,
        [PUBLIC_ADDRESS],
        'credentials_not_allowed',
      ],
      [
        'port 8443',
        (h) => `https://${h}:8443/in`,
        [PUBLIC_ADDRESS],
        'port_not_allowed',
      ],
      ['IPv4 literal', () => 'https://203.0.113.9/in', null, 'ip_literal'],
      ['IPv6 literal', () => 'https://[2001:db8::1]/in', null, 'ip_literal'],
      ['localhost', () => 'https://localhost/in', null, 'blocked_address'],
      [
        'name resolving to 10.0.0.5',
        (h) => `https://${h}/in`,
        ['10.0.0.5'],
        'blocked_address',
      ],
      [
        'name resolving to the metadata address',
        (h) => `https://${h}/in`,
        ['169.254.169.254'],
        'blocked_address',
      ],
      [
        'name resolving to a mapped private address',
        (h) => `https://${h}/in`,
        ['::ffff:10.0.0.5'],
        'blocked_address',
      ],
      [
        'name with one private answer among public ones',
        (h) => `https://${h}/in`,
        [PUBLIC_ADDRESS, '192.168.1.10'],
        'blocked_address',
      ],
      [
        'name that does not resolve',
        (h) => `https://${h}/in`,
        null,
        'unresolvable',
      ],
    ];

    it.each(guardCases)(
      'S43 AS-03: create with %s answers 422 endpoint_url_rejected and stores nothing',
      async (_name, urlOf, answers, reason) => {
        const h = host();
        if (answers) t.resolver.set(h, answers);
        const before = await stateOfShop();
        const res = await create({ url: urlOf(h), events: ['order.paid'] });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('endpoint_url_rejected');
        expect(res.body.details).toEqual({ reason });
        expect(await stateOfShop()).toEqual(before);
      },
    );

    it.each(guardCases)(
      'S43 AS-03: patch to %s answers 422 and changes nothing, not even the other fields of the request',
      async (_name, urlOf, answers, reason) => {
        const e = await created();
        const before = await row(e.id);
        const beforeHistory = await history(e.id);
        const h = host();
        if (answers) t.resolver.set(h, answers);
        const res = await owner()
          .patch(`${base()}/${e.id}`)
          .send({ url: urlOf(h), events: ['order.cancelled'] });
        expect(res.status).toBe(422);
        expect(res.body.code).toBe('endpoint_url_rejected');
        expect(res.body.details).toEqual({ reason });
        expect(await row(e.id)).toEqual(before);
        expect(await history(e.id)).toEqual(beforeHistory);
      },
    );
  });

  describe('list and update (AS-05, AS-07)', () => {
    it('S43 AS-05: the list is keyset-paged (createdAt desc, id desc) with an opaque cursor, no secrets, other shops never appear', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        ids.push((await created()).id);
        t.clock.advance(1000);
      }
      const otherWorld = await t.seedWorld();
      await created(mk(), otherWorld);
      const expected = (
        await t.rows<{ id: string }>(
          `SELECT id FROM "WebhookEndpoint" WHERE "shopId" = :id ORDER BY "createdAt" DESC, id DESC`,
          { id: w.shop.id },
        )
      ).map((r) => r.id);
      expect(expected).toHaveLength(7);

      const first = await owner().get(`${base()}?limit=3`).expect(200);
      const page1 = webhookEndpointPageSchema.parse(first.body);
      expect(page1.items.map((i) => i.id)).toEqual(expected.slice(0, 3));
      expect(page1.nextCursor).toEqual(expect.any(String));
      expect(JSON.stringify(first.body)).not.toMatch(/whsec_|secretSealed/);
      const second = webhookEndpointPageSchema.parse(
        (
          await owner()
            .get(`${base()}?limit=3&cursor=${page1.nextCursor}`)
            .expect(200)
        ).body,
      );
      expect(second.items.map((i) => i.id)).toEqual(expected.slice(3, 6));
      const third = webhookEndpointPageSchema.parse(
        (
          await owner()
            .get(`${base()}?limit=3&cursor=${second.nextCursor}`)
            .expect(200)
        ).body,
      );
      expect(third.items.map((i) => i.id)).toEqual(expected.slice(6));
      expect(third.nextCursor).toBeNull();

      const all = webhookEndpointPageSchema.parse(
        (await owner().get(base()).expect(200)).body,
      );
      expect(all.items.map((i) => i.id)).toEqual(expected);
      expect(all.nextCursor).toBeNull();

      for (const bad of ['limit=0', 'limit=101', 'limit=abc']) {
        const res = await owner().get(`${base()}?${bad}`);
        expect([res.status, res.body.code]).toEqual([400, 'validation_failed']);
      }
      const tampered = await owner().get(`${base()}?cursor=garbage`);
      expect([tampered.status, tampered.body.code]).toEqual([
        400,
        'invalid_cursor',
      ]);
    });

    it('S43 AS-07: patch updates url, events and version, leaves secret, status and failure state, writes one history row and one event per changed facet', async () => {
      const versions = t.app.get(ApiVersionService);
      const [older, newer] = [...versions.supportedVersions()].sort();
      const e = await created({ ...mk(), apiVersion: newer });
      const before = await row(e.id);
      t.clock.advance(1000);
      const newUrl = t.endpointUrl('/in2');
      const res = await owner()
        .patch(`${base()}/${e.id}`)
        .send({
          url: newUrl,
          events: ['order.paid', 'order.cancelled'],
          apiVersion: older,
        });
      expect(res.status).toBe(200);
      const dto = webhookEndpointSchema.parse(res.body);
      expect(dto).toMatchObject({
        url: newUrl,
        events: ['order.paid', 'order.cancelled'],
        apiVersion: older,
        status: 'enabled',
      });
      const after = await row(e.id);
      expect(after.secretSealed).toBe(before.secretSealed);
      expect(after.status).toBe('enabled');
      expect(after.failingSince).toBeNull();

      const facets = (await history(e.id)).map((h) => h.facet);
      expect(facets).toEqual(['created', 'url', 'events', 'api_version']);
      const urlRow = (await history(e.id)).find((h) => h.facet === 'url')!;
      expect(urlRow.toValue).toBe(new URL(newUrl).host);
      expect(urlRow.toValue).not.toContain('/in2');
      expect((await changes(e.id)).sort()).toEqual(
        [
          'created',
          'url_changed',
          'events_changed',
          'api_version_changed',
        ].sort(),
      );
    });

    it('S43 AS-07: an empty body, the removed enabled field and unknown properties are 400', async () => {
      const e = await created();
      for (const body of [{}, { enabled: false }, { foo: 1 }]) {
        const res = await owner().patch(`${base()}/${e.id}`).send(body);
        expect([res.status, res.body.code]).toEqual([400, 'validation_failed']);
      }
      expect((await row(e.id)).status).toBe('enabled');
    });
  });

  describe('enable, disable and delete (AS-08, AS-09, AS-10)', () => {
    it('S43 AS-08: disable and enable record a history row each; illegal pairs answer 409 endpoint_state_conflict; the breaker is closed again after enable', async () => {
      const e = await created();
      const breaker = t.app.get(BreakerStore);
      for (let i = 0; i < 5; i += 1)
        await breaker.recordFailure(e.id, t.clock.now().getTime());
      expect((await owner().get(`${base()}/${e.id}`)).body.breaker).toBe(
        'open',
      );

      const off = await owner().post(`${base()}/${e.id}/disable`).expect(200);
      expect(webhookEndpointSchema.parse(off.body)).toMatchObject({
        status: 'disabled',
        disabledReason: 'manual',
      });
      const again = await owner().post(`${base()}/${e.id}/disable`);
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('endpoint_state_conflict');
      expect(again.body.details).toEqual({ status: 'disabled' });

      await t.exec(
        `UPDATE "WebhookEndpoint" SET "failingSince" = now() WHERE id = :id`,
        { id: e.id },
      );
      const on = await owner().post(`${base()}/${e.id}/enable`).expect(200);
      expect(webhookEndpointSchema.parse(on.body)).toMatchObject({
        status: 'enabled',
        disabledReason: null,
        failingSince: null,
        breaker: 'closed',
      });
      expect((await breaker.get(e.id)).consecutiveFailures).toBe(0);
      const enabledTwice = await owner().post(`${base()}/${e.id}/enable`);
      expect([
        enabledTwice.status,
        enabledTwice.body.code,
        enabledTwice.body.details,
      ]).toEqual([409, 'endpoint_state_conflict', { status: 'enabled' }]);

      const hist = (await history(e.id)).filter((h) => h.facet === 'status');
      expect(hist.map((h) => [h.fromValue, h.toValue])).toEqual([
        ['enabled', 'disabled'],
        ['disabled', 'enabled'],
      ]);
      expect(await changes(e.id)).toEqual(['created', 'disabled', 'enabled']);
    });

    it('S43 AS-08: enabling re-checks the address; when it is now blocked the answer is 422 and the endpoint stays disabled', async () => {
      const url = t.endpointUrl();
      const e = await created(mk(url));
      await owner().post(`${base()}/${e.id}/disable`).expect(200);
      t.resolver.set(new URL(url).host, ['10.0.0.5']);
      const res = await owner().post(`${base()}/${e.id}/enable`);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('endpoint_url_rejected');
      expect(res.body.details).toEqual({ reason: 'blocked_address' });
      expect((await row(e.id)).status).toBe('disabled');
      expect(
        (await history(e.id)).filter((h) => h.facet === 'status'),
      ).toHaveLength(1);
    });

    it('S43 AS-09: two concurrent enables of a disabled endpoint: exactly one 200 and one 409, one history row and one event (20 rounds)', async () => {
      await inRounds(20, 5, async (world) => {
        const own = () => t.as(world.owner);
        const e = await created(mk(), world);
        await own().post(`${base(world)}/${e.id}/disable`).expect(200);
        const results = await Promise.all([
          own().post(`${base(world)}/${e.id}/enable`),
          own().post(`${base(world)}/${e.id}/enable`),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(
          (await history(e.id)).filter((h) => h.toValue === 'enabled'),
        ).toHaveLength(1);
        expect(
          (await changes(e.id)).filter((c) => c === 'enabled'),
        ).toHaveLength(1);
        await own().delete(`${base(world)}/${e.id}`).expect(204);
      });
    }, 120_000);

    it('S43 AS-10: delete removes the row and frees the slot, leaves a history row and an event; every route then answers 404, also a second delete', async () => {
      const e = await created();
      await owner().delete(`${base()}/${e.id}`).expect(204);
      expect(await row(e.id)).toBeUndefined();
      expect(await counter()).toBe(0);
      expect((await history(e.id)).map((h) => h.facet)).toEqual([
        'created',
        'deleted',
      ]);
      expect(await changes(e.id)).toEqual(['created', 'deleted']);

      const after = [
        owner().get(`${base()}/${e.id}`),
        owner()
          .patch(`${base()}/${e.id}`)
          .send({ events: ['order.paid'] }),
        owner().post(`${base()}/${e.id}/enable`),
        owner().post(`${base()}/${e.id}/disable`),
        owner().post(`${base()}/${e.id}/rotate-secret`).send({}),
        owner().post(`${base()}/${e.id}/expire-previous-secret`),
        owner().delete(`${base()}/${e.id}`),
      ];
      for (const res of await Promise.all(after)) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('webhook_endpoint_not_found');
      }
    });

    it("S43 AS-13: another shop's endpoint id and an unknown id give the same 404 and change nothing", async () => {
      const other = await t.seedWorld();
      const foreign = await created(mk(), other);
      const unknownId = '00000000-0000-4000-8000-000000000001';
      const call = (id: string) => [
        owner().get(`${base()}/${id}`),
        owner()
          .patch(`${base()}/${id}`)
          .send({ events: ['order.cancelled'] }),
        owner().post(`${base()}/${id}/enable`),
        owner().post(`${base()}/${id}/disable`),
        owner().post(`${base()}/${id}/rotate-secret`).send({}),
        owner().post(`${base()}/${id}/expire-previous-secret`),
        owner().delete(`${base()}/${id}`),
      ];
      const foreignRes = await Promise.all(call(foreign.id));
      const unknownRes = await Promise.all(call(unknownId));
      foreignRes.forEach((res, i) => {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('webhook_endpoint_not_found');
        expect(strip(res.body)).toEqual(strip(unknownRes[i].body));
      });
      const kept = await row(foreign.id);
      expect(kept).toMatchObject({ status: 'enabled', events: ['order.paid'] });
      expect(await counter(other.shop.id)).toBe(1);
    });
  });

  describe('limits (AS-11, AS-12)', () => {
    it('S43 AS-11: from 18 endpoints three concurrent creates give exactly two 201 and one 422 endpoint_limit_reached, the counter equals the rows (20 rounds)', async () => {
      const worlds = await inRounds(20, 5, async (world) => {
        await Promise.all(
          Array.from({ length: 18 }, () => created(mk(), world)),
        );
        const results = await Promise.all([
          create(mk(), world),
          create(mk(), world),
          create(mk(), world),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 201, 422]);
        expect(results.find((r) => r.status === 422)!.body.code).toBe(
          'endpoint_limit_reached',
        );
        expect(await count(world.shop.id)).toBe(20);
        expect(await counter(world.shop.id)).toBe(20);
        const extra = await create(mk(), world);
        expect([extra.status, extra.body.code]).toEqual([
          422,
          'endpoint_limit_reached',
        ]);
        expect(await count(world.shop.id)).toBe(20);
        expect(await counter(world.shop.id)).toBe(20);
      });
      // deleting one frees a slot
      const last = worlds[worlds.length - 1];
      const [any] = await t.rows<{ id: string }>(
        `SELECT id FROM "WebhookEndpoint" WHERE "shopId" = :id LIMIT 1`,
        { id: last.shop.id },
      );
      await t
        .as(last.owner)
        .delete(`${base(last)}/${any.id}`)
        .expect(204);
      await create(mk(), last).then((r) => expect(r.status).toBe(201));
      expect(await counter(last.shop.id)).toBe(20);
    }, 300_000);

    it('S43 AS-12: a second endpoint with the same address after normalisation is 409 duplicate_endpoint_url; another shop may use it', async () => {
      const url = t.endpointUrl('/in');
      const host = new URL(url).host;
      const first = await created(mk(url));
      for (const variant of [
        `https://${host.toUpperCase()}:443/in`,
        `${url}#fragment`,
      ]) {
        const res = await create(mk(variant));
        expect([res.status, res.body.code]).toEqual([
          409,
          'duplicate_endpoint_url',
        ]);
      }
      expect(await count()).toBe(1);
      expect(await counter()).toBe(1);
      const other = await t.seedWorld();
      await created(mk(url), other);
      expect(first.id).toBeDefined();
    });

    it('S43 AS-12: two concurrent creates of the same new address give one 201 and one 409 (20 rounds)', async () => {
      await inRounds(20, 5, async (world) => {
        const url = t.endpointUrl();
        const results = await Promise.all([
          create(mk(url), world),
          create(mk(url), world),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
        expect(results.find((r) => r.status === 409)!.body.code).toBe(
          'duplicate_endpoint_url',
        );
        expect(await count(world.shop.id)).toBe(1);
        expect(await counter(world.shop.id)).toBe(1);
      });
    }, 120_000);
  });

  describe('access (AS-13, AS-14)', () => {
    type Call = (
      agent: ReturnType<WebhookKit['as']> | null,
      id: string,
    ) => Promise<{ status: number; body: any }>;
    const via = (agent: ReturnType<WebhookKit['as']> | null) =>
      agent ?? {
        get: (u: string) => t.http().get(u),
        post: (u: string) => t.http().post(u),
        patch: (u: string) => t.http().patch(u),
        delete: (u: string) => t.http().delete(u),
        put: (u: string) => t.http().put(u),
      };
    const routes: { name: string; ok: number; call: Call; write: boolean }[] = [
      {
        name: 'create',
        ok: 201,
        write: true,
        call: (a) => via(a).post(base()).send(mk()),
      },
      { name: 'list', ok: 200, write: false, call: (a) => via(a).get(base()) },
      {
        name: 'read',
        ok: 200,
        write: false,
        call: (a, id) => via(a).get(`${base()}/${id}`),
      },
      {
        name: 'patch',
        ok: 200,
        write: true,
        call: (a, id) =>
          via(a)
            .patch(`${base()}/${id}`)
            .send({ events: ['order.cancelled'] }),
      },
      {
        name: 'disable',
        ok: 200,
        write: true,
        call: (a, id) => via(a).post(`${base()}/${id}/disable`),
      },
      {
        name: 'enable',
        ok: 409,
        write: true,
        call: (a, id) => via(a).post(`${base()}/${id}/enable`),
      },
      {
        name: 'rotate',
        ok: 201,
        write: true,
        call: (a, id) => via(a).post(`${base()}/${id}/rotate-secret`).send({}),
      },
      {
        name: 'expire-previous-secret',
        ok: 409,
        write: true,
        call: (a, id) => via(a).post(`${base()}/${id}/expire-previous-secret`),
      },
      {
        name: 'delete',
        ok: 204,
        write: true,
        call: (a, id) => via(a).delete(`${base()}/${id}`),
      },
      {
        name: 'event types',
        ok: 200,
        write: false,
        call: (a) =>
          via(a).get(`/api/shops/${w.shop.id}/developers/webhook-event-types`),
      },
    ];

    it('S43 AS-13: every route x anonymous / viewer / staff / outsider / admin / owner: 401, 403 permission_denied, 403, 404 shop_not_found, then success', async () => {
      const actors: [
        string,
        ReturnType<WebhookKit['as']> | null,
        number | 'ok',
      ][] = [
        ['anonymous', null, 401],
        ['viewer', t.as(w.viewer), 403],
        ['staff', t.as(w.staff), 403],
        ['outsider', t.as(w.outsider), 404],
        ['admin', t.as(w.admin), 'ok'],
        ['owner', t.as(w.owner), 'ok'],
      ];
      for (const route of routes) {
        // one clean shop per route; the six people each use an endpoint of their own, at the same time
        await emptyShop();
        await Promise.all(
          actors.map(async ([who, agent, expected]) => {
            const e = await created();
            const res = await route.call(agent, e.id);
            const want = expected === 'ok' ? route.ok : expected;
            if (res.status !== want)
              throw new Error(
                `${route.name} as ${who}: expected ${want}, got ${res.status} ${JSON.stringify(res.body)}`,
              );
            if (expected === 403)
              expect(res.body.code).toBe('permission_denied');
            if (expected === 404)
              expect(res.body.code).toBe('shop_not_found');
            if (expected !== 'ok')
              expect((await row(e.id)).status).toBe('enabled');
          }),
        );
      }
    }, 180_000);

    it('S43 AS-13: a suspended shop answers 403 shop_suspended and an offboarding shop 409 shop_offboarding on every write route, and changes nothing', async () => {
      for (const [status, http, code] of [
        ['SUSPENDED', 403, 'shop_suspended'],
        ['DELETING', 409, 'shop_offboarding'],
      ] as const) {
        const world = await t.seedWorld();
        const e = await created(mk(), world);
        await t.exec(`UPDATE "Shop" SET status = :status WHERE id = :id`, {
          status,
          id: world.shop.id,
        });
        const b = base(world);
        const o = t.as(world.owner);
        const calls = [
          o.post(b).send(mk()),
          o.patch(`${b}/${e.id}`).send({ events: ['order.cancelled'] }),
          o.post(`${b}/${e.id}/disable`),
          o.post(`${b}/${e.id}/enable`),
          o.post(`${b}/${e.id}/rotate-secret`).send({}),
          o.post(`${b}/${e.id}/expire-previous-secret`),
          o.delete(`${b}/${e.id}`),
        ];
        for (const res of await Promise.all(calls)) {
          expect([res.status, res.body.code]).toEqual([http, code]);
        }
        expect(await row(e.id)).toMatchObject({
          status: 'enabled',
          events: ['order.paid'],
        });
        expect(await counter(world.shop.id)).toBe(1);
      }
    });

    it('S43 AS-14: the catalogue lists exactly the 11 event types in a fixed order and create accepts each of them', async () => {
      const res = await owner()
        .get(`/api/shops/${w.shop.id}/developers/webhook-event-types`)
        .expect(200);
      const parsed = webhookEventTypesResponseSchema.parse(res.body);
      expect(parsed.items.map((i) => i.type)).toEqual([...WEBHOOK_EVENT_TYPES]);
      expect(parsed.items).toHaveLength(11);
      for (const item of parsed.items) {
        expect(item.description.length).toBeGreaterThan(0);
        expect(item.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      expect(
        parsed.items.find((i) => i.type === 'webhook.ping')!.resource,
      ).toBe('ping');
      const all = await create(mk(t.endpointUrl(), [...WEBHOOK_EVENT_TYPES]));
      expect(all.status).toBe(201);
    });
  });

  describe('rate limits (AS-15)', () => {
    it('S43 AS-15: the 121st mutating call of a shop in a minute is 429 with structured RateLimit headers and Retry-After; another shop is unaffected', async () => {
      const unknown = '00000000-0000-4000-8000-0000000000aa';
      // the first 120 calls are all allowed, so they can go 20 at a time; the 121st comes after all of them
      for (let from = 0; from < 120; from += 20) {
        const batch = await Promise.all(
          Array.from({ length: 20 }, () =>
            owner().post(`${base()}/${unknown}/disable`),
          ),
        );
        batch.forEach((res, k) => {
          if (res.status !== 404)
            throw new Error(
              `call ${from + k + 1}: expected 404, got ${res.status}`,
            );
        });
      }
      const limited = await owner().post(`${base()}/${unknown}/disable`);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.headers.ratelimit).toBeDefined();
      expect(limited.headers['ratelimit-policy']).toBeDefined();
      expect(limited.headers['x-ratelimit-limit']).toBeUndefined();
      expect(limited.headers['x-ratelimit-remaining']).toBeUndefined();
      // reads are not limited by the mutation policy
      await owner().get(base()).expect(200);
      const other = await t.seedWorld();
      await created(mk(), other);
    }, 120_000);

    it('S43 AS-15: with the limiter store down mutating calls fail closed with 503 and write nothing, reads keep working (forced fault)', async () => {
      const e = await created();
      await fastStoreOf(t.app).deny('rl:');
      try {
        const refused = await owner().post(base()).send(mk());
        expect(refused.status).toBe(503);
        expect(refused.body.code).toBe('rate_limiter_unavailable');
        expect(refused.headers['retry-after']).toBeDefined();
        expect(
          (
            await owner()
              .patch(`${base()}/${e.id}`)
              .send({ events: ['order.cancelled'] })
          ).status,
        ).toBe(503);
        expect(await count()).toBe(1);
        expect((await row(e.id)).events).toEqual(['order.paid']);
        await owner().get(`${base()}/${e.id}`).expect(200);
      } finally {
        await fastStoreOf(t.app).allow();
        t.clock.advance(120_000);
        await clearRateLimits(t.app);
        await waitFor(
          async () => {
            const probe = await t.as(w.owner).get(base());
            const mutating = await t
              .as(w.owner)
              .post(`${base()}/00000000-0000-4000-8000-0000000000bb/disable`);
            return probe.status === 200 && mutating.status === 404;
          },
          'the limiter store to recover',
          30_000,
        );
        await clearRateLimits(t.app);
      }
    }, 120_000);
  });
});

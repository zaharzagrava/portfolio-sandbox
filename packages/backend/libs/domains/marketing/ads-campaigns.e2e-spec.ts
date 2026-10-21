import {
  adCampaignDetailSchema,
  adCampaignPageSchema,
  adCampaignSchema,
  adCampaignEventPayloadSchema,
  problemDetailsSchema,
  productSponsorshipChangedPayloadSchema,
} from '@marketplace-sandbox/contracts';
import { inParallel } from '@app/test/utils/async-helpers';
import {
  createAdsApp,
  unknownId,
  type AdsTestApp,
  type Team,
} from './testing/ads.fixtures';

describe('Sponsored listings: campaigns', () => {
  let t: AdsTestApp;
  let team: Team;

  beforeAll(async () => {
    t = await createAdsApp({ redisProxy: true });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    team = await t.team();
  });

  const problem = (res: { body: unknown }) =>
    problemDetailsSchema.parse(res.body);
  const campaignRows = async (shopId = team.shop.id) =>
    t.sql<{ id: string; status: string }>(
      `SELECT "id", "status" FROM "AdCampaign" WHERE "shopId" = :shopId ORDER BY "createdAt", "id"`,
      { shopId },
    );
  const types = async (aggregateId: string) =>
    (await t.events(aggregateId)).map((e) => e.type);

  it('S36 AS-01: owner creates a campaign: 201, the contract body, one row, one history row, two events in the outbox', async () => {
    const product = await t.product(team.shop.id, { category: 'audio' });
    const res = await t.create(team.owner, team.shop.id, {
      productId: product.id,
      cpcMinor: 25,
      dailyBudgetMinor: 1000,
    });

    expect(res.status).toBe(201);
    const campaign = adCampaignSchema.parse(res.body);
    expect(campaign).toEqual({
      id: campaign.id,
      shopId: team.shop.id,
      productId: product.id,
      category: 'audio',
      cpcMinor: 25,
      dailyBudgetMinor: 1000,
      currency: 'EUR',
      status: 'ACTIVE',
      statusReason: null,
      campaignVersion: 1,
      createdAt: t.clock.now().toISOString(),
      updatedAt: t.clock.now().toISOString(),
    });
    expect(await campaignRows()).toHaveLength(1);
    const history = await t.sql(
      `SELECT "actorId", "fromStatus", "toStatus", "campaignVersion" FROM "AdCampaignHistory" WHERE "campaignId" = :id`,
      { id: campaign.id },
    );
    expect(history).toEqual([
      {
        actorId: team.owner.id,
        fromStatus: null,
        toStatus: 'ACTIVE',
        campaignVersion: 1,
      },
    ]);
    const [created] = await t.events(campaign.id);
    expect(created).toMatchObject({
      type: 'marketing.campaign_created',
      version: 1,
      aggregateId: campaign.id,
      aggregateVersion: 1,
    });
    expect(adCampaignEventPayloadSchema.parse(created.payload)).toMatchObject({
      campaignId: campaign.id,
      category: 'audio',
      status: 'ACTIVE',
      campaignVersion: 1,
    });
    const [sponsorship] = await t.events(product.id);
    expect(sponsorship).toMatchObject({
      type: 'marketing.product_sponsorship_changed',
      aggregateVersion: 1,
    });
    expect(
      productSponsorshipChangedPayloadSchema.parse(sponsorship.payload),
    ).toEqual({
      productId: product.id,
      shopId: team.shop.id,
      sponsored: true,
      sponsorshipVersion: 1,
    });
  });

  describe('S36 AS-02: validation classes', () => {
    const productId = '00000000-0000-4000-8000-000000000001';
    const ok = { productId, cpcMinor: 25, dailyBudgetMinor: 1000 };
    const without = (key: string) => {
      const { [key]: _omitted, ...rest } = ok as Record<string, unknown>;
      void _omitted;
      return rest;
    };

    it.each([
      ['no productId', without('productId'), 'productId'],
      ['productId not a UUID', { ...ok, productId: 'nope' }, 'productId'],
      ['cpcMinor missing', without('cpcMinor'), 'cpcMinor'],
      ['cpcMinor 0', { ...ok, cpcMinor: 0 }, 'cpcMinor'],
      ['cpcMinor -1', { ...ok, cpcMinor: -1 }, 'cpcMinor'],
      ['cpcMinor 12.5', { ...ok, cpcMinor: 12.5 }, 'cpcMinor'],
      ['cpcMinor "25"', { ...ok, cpcMinor: '25' }, 'cpcMinor'],
      ['cpcMinor 10001', { ...ok, cpcMinor: 10_001 }, 'cpcMinor'],
      [
        'dailyBudgetMinor missing',
        without('dailyBudgetMinor'),
        'dailyBudgetMinor',
      ],
      [
        'dailyBudgetMinor 99',
        { ...ok, dailyBudgetMinor: 99 },
        'dailyBudgetMinor',
      ],
      [
        'dailyBudgetMinor 12.5',
        { ...ok, dailyBudgetMinor: 12.5 },
        'dailyBudgetMinor',
      ],
      [
        'dailyBudgetMinor 10000001',
        { ...ok, dailyBudgetMinor: 10_000_001 },
        'dailyBudgetMinor',
      ],
      ['unknown property category', { ...ok, category: 'audio' }, 'category'],
      ['unknown property currency', { ...ok, currency: 'EUR' }, 'currency'],
      ['unknown property status', { ...ok, status: 'PAUSED' }, 'status'],
    ])(
      '%s → 400 validation_failed naming the field, nothing written',
      async (_name, body, field) => {
        const res = await t.create(team.owner, team.shop.id, body);
        expect(res.status).toBe(400);
        expect(problem(res).code).toBe('validation_failed');
        expect(
          res.body.errors.map((e: { field: string }) => e.field),
        ).toContain(field);
        expect(await campaignRows()).toEqual([]);
      },
    );

    it('a budget below the price per click → 422 budget_below_cpc, nothing written', async () => {
      const product = await t.product(team.shop.id);
      const res = await t.create(team.owner, team.shop.id, {
        productId: product.id,
        cpcMinor: 500,
        dailyBudgetMinor: 400,
      });
      expect(res.status).toBe(422);
      expect(problem(res).code).toBe('budget_below_cpc');
      expect(await campaignRows()).toEqual([]);
      expect(await t.events(product.id)).toEqual([]);
    });
  });

  it('S36 AS-03: without credentials 401; viewer and staff cannot mutate (403) but a viewer can read; admin and owner succeed', async () => {
    const { campaign } = await t.campaign(team);
    const base = `/api/shops/${team.shop.id}/ads/campaigns`;
    for (const res of [
      await t.http().post(base).send({}),
      await t.http().get(base),
      await t.http().get(`${base}/${campaign.id}`),
      await t.http().post(`${base}/${campaign.id}/pause`),
    ])
      expect(res.status).toBe(401);

    const product = await t.product(team.shop.id);
    const body = {
      productId: product.id,
      cpcMinor: 25,
      dailyBudgetMinor: 1000,
    };
    for (const user of [team.viewer, team.staff]) {
      const denied = await t.create(user, team.shop.id, body);
      expect(denied.status).toBe(403);
      expect(problem(denied).code).toBe('permission_denied');
      expect(
        (await t.act(user, team.shop.id, campaign.id, 'pause')).status,
      ).toBe(403);
    }
    expect(await campaignRows()).toHaveLength(1);

    expect((await t.as(team.viewer).get(base)).status).toBe(200);
    expect((await t.as(team.viewer).get(`${base}/${campaign.id}`)).status).toBe(
      200,
    );
    expect((await t.create(team.admin, team.shop.id, body)).status).toBe(201);
    expect(
      (await t.act(team.owner, team.shop.id, campaign.id, 'pause')).status,
    ).toBe(200);
  });

  it('S36 AS-04: another shop’s campaign, shop and product answer 404 like an unknown one; nothing changes', async () => {
    const other = await t.team();
    const { campaign: theirs, product: theirProduct } = await t.campaign(other);
    const eventsBefore = (await t.events(theirs.id)).length;
    const base = `/api/shops/${team.shop.id}/ads/campaigns`;

    const unknown = await t.as(team.owner).get(`${base}/${unknownId()}`);
    expect(problem(unknown).code).toBe('campaign_not_found');
    for (const res of [
      await t.as(team.owner).get(`${base}/${theirs.id}`),
      await t.act(team.owner, team.shop.id, theirs.id, 'pause'),
      await t.act(team.owner, team.shop.id, theirs.id, 'end'),
    ]) {
      expect(res.status).toBe(404);
      expect(problem(res).code).toBe('campaign_not_found');
      expect(res.body.detail).toBe(unknown.body.detail);
    }

    const foreignShop = await t
      .as(team.owner)
      .get(`/api/shops/${other.shop.id}/ads/campaigns`);
    expect(foreignShop.status).toBe(404);
    expect(problem(foreignShop).code).toBe('shop_not_found');

    const foreignProduct = await t.create(team.owner, team.shop.id, {
      productId: theirProduct.id,
      cpcMinor: 25,
      dailyBudgetMinor: 1000,
    });
    expect(foreignProduct.status).toBe(404);
    expect(problem(foreignProduct).code).toBe('product_not_found');
    const unknownProduct = await t.create(team.owner, team.shop.id, {
      productId: unknownId(),
      cpcMinor: 25,
      dailyBudgetMinor: 1000,
    });
    expect(unknownProduct.body.detail).toBe(foreignProduct.body.detail);

    const [row] = await t.sql<{ status: string; campaignVersion: number }>(
      `SELECT "status", "campaignVersion" FROM "AdCampaign" WHERE "id" = :id`,
      { id: theirs.id },
    );
    expect(row).toEqual({ status: 'ACTIVE', campaignVersion: 1 });
    expect((await t.events(theirs.id)).length).toBe(eventsBefore);
    expect(await campaignRows()).toEqual([]);
  });

  it('S36 AS-05: archived and sandbox products 422, unknown 404, out of stock 201', async () => {
    const archived = await t.product(team.shop.id, { status: 'ARCHIVED' });
    const sandbox = await t.product(team.shop.id, { isSandbox: true });
    const soldOut = await t.product(team.shop.id, { quantity: 0 });
    const body = (productId: string) => ({
      productId,
      cpcMinor: 25,
      dailyBudgetMinor: 1000,
    });

    for (const product of [archived, sandbox]) {
      const res = await t.create(team.owner, team.shop.id, body(product.id));
      expect(res.status).toBe(422);
      expect(problem(res).code).toBe('product_not_sponsorable');
    }
    const unknown = await t.create(team.owner, team.shop.id, body(unknownId()));
    expect(unknown.status).toBe(404);
    expect(problem(unknown).code).toBe('product_not_found');

    const ok = await t.create(team.owner, team.shop.id, body(soldOut.id));
    expect(ok.status).toBe(201);
    expect(await campaignRows()).toHaveLength(1);
  });

  describe('S36 AS-06: one open campaign per product', () => {
    it('a second create is 409 campaign_already_exists; after the first ended a create succeeds', async () => {
      const { campaign, product } = await t.campaign(team);
      const body = {
        productId: product.id,
        cpcMinor: 30,
        dailyBudgetMinor: 900,
      };
      const second = await t.create(team.owner, team.shop.id, body);
      expect(second.status).toBe(409);
      expect(problem(second).code).toBe('campaign_already_exists');
      expect(await campaignRows()).toHaveLength(1);

      await t.act(team.owner, team.shop.id, campaign.id, 'pause');
      expect((await t.create(team.owner, team.shop.id, body)).status).toBe(409);
      await t.act(team.owner, team.shop.id, campaign.id, 'end');
      expect((await t.create(team.owner, team.shop.id, body)).status).toBe(201);
      expect(await campaignRows()).toHaveLength(2);
    });

    it('two creates racing for one product: exactly one 201 and one 409, one row, one sponsorship event', async () => {
      const product = await t.product(team.shop.id);
      const body = {
        productId: product.id,
        cpcMinor: 25,
        dailyBudgetMinor: 1000,
      };
      const results = await inParallel(2, () =>
        t.create(team.owner, team.shop.id, body),
      );
      const statuses = results
        .map(
          (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
        )
        .sort();
      expect(statuses).toEqual([201, 409]);
      expect(await campaignRows()).toHaveLength(1);
      expect(await types(product.id)).toEqual([
        'marketing.product_sponsorship_changed',
      ]);
    });
  });

  describe('S36 AS-07: at most 50 open campaigns per shop', () => {
    const fillQuota = (open: number) =>
      t.sql(
        `INSERT INTO "AdShopQuota" ("shopId", "openCount") VALUES (:shopId, :open)
         ON CONFLICT ("shopId") DO UPDATE SET "openCount" = :open RETURNING "shopId"`,
        { shopId: team.shop.id, open },
      );
    const openCount = async () =>
      Number(
        (
          await t.sql<{ openCount: number }>(
            `SELECT "openCount" FROM "AdShopQuota" WHERE "shopId" = :shopId`,
            { shopId: team.shop.id },
          )
        )[0].openCount,
      );

    it('the 51st create is 422 campaign_limit_reached and writes nothing', async () => {
      await fillQuota(50);
      const product = await t.product(team.shop.id);
      const res = await t.create(team.owner, team.shop.id, {
        productId: product.id,
        cpcMinor: 25,
        dailyBudgetMinor: 1000,
      });
      expect(res.status).toBe(422);
      expect(problem(res).code).toBe('campaign_limit_reached');
      expect(await campaignRows()).toEqual([]);
      expect(await openCount()).toBe(50);
    });

    it('two creates racing at 49: exactly one 201 and one 422, the count is 50', async () => {
      await fillQuota(49);
      const [a, b] = await Promise.all([
        t.product(team.shop.id),
        t.product(team.shop.id),
      ]);
      const results = await inParallel(2, (i) =>
        t.create(team.owner, team.shop.id, {
          productId: [a, b][i].id,
          cpcMinor: 25,
          dailyBudgetMinor: 1000,
        }),
      );
      const statuses = results
        .map(
          (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
        )
        .sort();
      expect(statuses).toEqual([201, 422]);
      expect(await openCount()).toBe(50);
      expect(await campaignRows()).toHaveLength(1);
    });

    it('ending a campaign frees its place', async () => {
      const { campaign } = await t.campaign(team);
      expect(await openCount()).toBe(1);
      await t.act(team.owner, team.shop.id, campaign.id, 'end');
      expect(await openCount()).toBe(0);
    });
  });

  it('S36 AS-08: pause, resume and end change status, reason and version, write history and publish the events', async () => {
    const { campaign, product } = await t.campaign(team);

    const paused = await t.act(team.admin, team.shop.id, campaign.id, 'pause');
    expect(paused.status).toBe(200);
    expect(adCampaignSchema.parse(paused.body)).toMatchObject({
      status: 'PAUSED',
      statusReason: 'seller',
      campaignVersion: 2,
    });
    const resumed = await t.act(
      team.owner,
      team.shop.id,
      campaign.id,
      'resume',
    );
    expect(resumed.status).toBe(200);
    expect(adCampaignSchema.parse(resumed.body)).toMatchObject({
      status: 'ACTIVE',
      statusReason: null,
      campaignVersion: 3,
    });
    const ended = await t.act(team.owner, team.shop.id, campaign.id, 'end');
    expect(ended.status).toBe(200);
    expect(adCampaignSchema.parse(ended.body)).toMatchObject({
      status: 'ENDED',
      campaignVersion: 4,
    });

    const history = await t.sql<{
      fromStatus: string | null;
      toStatus: string;
      campaignVersion: number;
      actorId: string;
    }>(
      `SELECT "fromStatus", "toStatus", "campaignVersion", "actorId" FROM "AdCampaignHistory"
        WHERE "campaignId" = :id ORDER BY "campaignVersion"`,
      { id: campaign.id },
    );
    expect(
      history.map((h) => [h.fromStatus, h.toStatus, h.campaignVersion]),
    ).toEqual([
      [null, 'ACTIVE', 1],
      ['ACTIVE', 'PAUSED', 2],
      ['PAUSED', 'ACTIVE', 3],
      ['ACTIVE', 'ENDED', 4],
    ]);
    expect(history[1].actorId).toBe(team.admin.id);

    expect(await types(campaign.id)).toEqual([
      'marketing.campaign_created',
      'marketing.campaign_paused',
      'marketing.campaign_resumed',
      'marketing.campaign_ended',
    ]);
    const sponsorship = (await t.events(product.id)).map((e) => ({
      sponsored: e.payload.sponsored,
      version: e.aggregateVersion,
      payloadVersion: e.payload.sponsorshipVersion,
    }));
    expect(sponsorship).toEqual([
      { sponsored: true, version: 1, payloadVersion: 1 },
      { sponsored: false, version: 2, payloadVersion: 2 },
      { sponsored: true, version: 3, payloadVersion: 3 },
      { sponsored: false, version: 4, payloadVersion: 4 },
    ]);
  });

  it.each([
    ['pause a paused campaign', ['pause'], 'pause'],
    ['resume an active campaign', [], 'resume'],
    ['pause an ended campaign', ['end'], 'pause'],
    ['resume an ended campaign', ['end'], 'resume'],
    ['end an ended campaign', ['end'], 'end'],
  ] as const)(
    'S36 AS-09: %s → 409 invalid_transition, nothing changes',
    async (_name, setup, action) => {
      const { campaign } = await t.campaign(team);
      for (const step of setup)
        await t.act(team.owner, team.shop.id, campaign.id, step);
      const before = (await t.events(campaign.id)).length;
      const [row] = await t.sql<{ campaignVersion: number; status: string }>(
        `SELECT "campaignVersion", "status" FROM "AdCampaign" WHERE "id" = :id`,
        { id: campaign.id },
      );

      const res = await t.act(team.owner, team.shop.id, campaign.id, action);

      expect(res.status).toBe(409);
      expect(problem(res).code).toBe('invalid_transition');
      expect(res.body).toMatchObject({ from: row.status, action });
      expect((await t.events(campaign.id)).length).toBe(before);
      const [after] = await t.sql<{ campaignVersion: number }>(
        `SELECT "campaignVersion" FROM "AdCampaign" WHERE "id" = :id`,
        { id: campaign.id },
      );
      expect(after.campaignVersion).toBe(row.campaignVersion);
    },
  );

  it.each(['pause', 'end'] as const)(
    'S36 AS-10: two %s requests racing: exactly one 200 and one 409, one history row, one event',
    async (action) => {
      const { campaign } = await t.campaign(team);
      const results = await inParallel(2, () =>
        t.act(team.owner, team.shop.id, campaign.id, action),
      );
      const statuses = results
        .map(
          (r) => (r as PromiseFulfilledResult<{ status: number }>).value.status,
        )
        .sort();
      expect(statuses).toEqual([200, 409]);
      const history = await t.sql(
        `SELECT 1 FROM "AdCampaignHistory" WHERE "campaignId" = :id AND "campaignVersion" = 2`,
        { id: campaign.id },
      );
      expect(history).toHaveLength(1);
      const type =
        action === 'pause'
          ? 'marketing.campaign_paused'
          : 'marketing.campaign_ended';
      expect((await types(campaign.id)).filter((x) => x === type)).toHaveLength(
        1,
      );
    },
  );

  it('S36 AS-11: ending a paused campaign publishes campaign_ended and no sponsorship event; the version stays 2', async () => {
    const { campaign, product } = await t.campaign(team);
    await t.act(team.owner, team.shop.id, campaign.id, 'pause');
    expect((await t.events(product.id)).map((e) => e.aggregateVersion)).toEqual(
      [1, 2],
    );

    await t.act(team.owner, team.shop.id, campaign.id, 'end');

    expect(await types(campaign.id)).toContain('marketing.campaign_ended');
    expect((await t.events(product.id)).map((e) => e.aggregateVersion)).toEqual(
      [1, 2],
    );
    const [row] = await t.sql<{
      sponsored: boolean;
      sponsorshipVersion: number;
    }>(
      `SELECT "sponsored", "sponsorshipVersion" FROM "AdProductSponsorship" WHERE "productId" = :id`,
      { id: product.id },
    );
    expect(row).toEqual({ sponsored: false, sponsorshipVersion: 2 });
  });

  describe('S36 AS-12: list', () => {
    it('keyset pages newest first, filters by status, never shows another shop’s campaigns', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        t.clock.advance(1_000);
        ids.push((await t.campaign(team)).campaign.id);
      }
      const other = await t.team();
      const { campaign: foreign } = await t.campaign(other);
      const base = `/api/shops/${team.shop.id}/ads/campaigns`;

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await t
          .as(team.viewer)
          .get(
            `${base}?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          );
        expect(res.status).toBe(200);
        const page = adCampaignPageSchema.parse(res.body);
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((c) => c.id));
        cursor = page.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual([...ids].reverse());
      expect(seen).not.toContain(foreign.id);

      await t.act(team.owner, team.shop.id, ids[0], 'pause');
      const active = adCampaignPageSchema.parse(
        (await t.as(team.viewer).get(`${base}?status=ACTIVE`)).body,
      );
      expect(active.items.map((c) => c.id)).toEqual(
        [...ids.slice(1)].reverse(),
      );
      const paused = adCampaignPageSchema.parse(
        (await t.as(team.viewer).get(`${base}?status=PAUSED`)).body,
      );
      expect(paused.items.map((c) => c.id)).toEqual([ids[0]]);
    });

    it.each([
      ['limit=0', 'limit=0', 'validation_failed'],
      ['limit=101', 'limit=101', 'validation_failed'],
      ['status=FOO', 'status=FOO', 'validation_failed'],
      ['an unknown query parameter', 'foo=1', 'validation_failed'],
      ['a tampered cursor', 'cursor=abc.def', 'invalid_cursor'],
    ])('%s → 400 %s', async (_name, query, code) => {
      const res = await t
        .as(team.viewer)
        .get(`/api/shops/${team.shop.id}/ads/campaigns?${query}`);
      expect(res.status).toBe(400);
      expect(problem(res).code).toBe(code);
    });

    it('a cursor of another shop’s list is refused', async () => {
      await t.campaign(team);
      await t.campaign(team);
      const other = await t.team();
      await t.campaign(other);
      await t.campaign(other);
      const theirs = await t
        .as(other.viewer)
        .get(`/api/shops/${other.shop.id}/ads/campaigns?limit=1`);
      const cursor = adCampaignPageSchema.parse(theirs.body).nextCursor!;
      const res = await t
        .as(team.viewer)
        .get(
          `/api/shops/${team.shop.id}/ads/campaigns?cursor=${encodeURIComponent(cursor)}`,
        );
      expect(res.status).toBe(400);
      expect(problem(res).code).toBe('invalid_cursor');
    });
  });

  it('S36 AS-13: the detail adds billedTodayMinor from the charges posted in the current UTC day, never an estimate', async () => {
    const { campaign } = await t.campaign(team);
    const base = `/api/shops/${team.shop.id}/ads/campaigns/${campaign.id}`;
    const fresh = adCampaignDetailSchema.parse(
      (await t.as(team.viewer).get(base)).body,
    );
    expect(fresh.billedTodayMinor).toBe(0);

    const day = t.clock.now().toISOString().slice(0, 10);
    const run = (hour: string, state: string, amount: number) =>
      t.sql(
        `INSERT INTO "AdBillingRun" ("campaignId", "hour", "state", "source", "clicks", "billableClicks", "cappedClicks",
                                      "amountMinor", "ledgerReference")
         VALUES (:id, :hour, :state, 'stream', :clicks, :clicks, 0, :amount, :ref) RETURNING "campaignId"`,
        {
          id: campaign.id,
          hour: new Date(`${hour}:00:00.000Z`),
          state,
          clicks: amount / 25,
          amount,
          ref: `ad:${campaign.id}:${hour}`,
        },
      );
    await run(`${day}T00`, 'CHARGED', 750);
    await run(`${day}T01`, 'CHARGED', 250);
    await run(`${day}T02`, 'PENDING', 500); // not posted yet: not counted
    const yesterday = new Date(`${day}T00:00:00.000Z`).getTime() - 3_600_000;
    await run(new Date(yesterday).toISOString().slice(0, 13), 'CHARGED', 900); // another UTC day

    const detail = adCampaignDetailSchema.parse(
      (await t.as(team.viewer).get(base)).body,
    );
    expect(detail).toMatchObject({ id: campaign.id, billedTodayMinor: 1000 });
  });

  describe('S36 AS-14: write rate limit', () => {
    it('the 61st mutation of a shop within the minute is 429 with Retry-After and writes nothing', async () => {
      const { campaign } = await t.campaign(team);
      // 59 refused requests in two waves at once (was one by one)
      for (const size of [30, 29])
        await Promise.all(
          Array.from({ length: size }, () =>
            t.act(team.owner, team.shop.id, campaign.id, 'resume'),
          ), // 409 each: a refused request still counts
        );
      const product = await t.product(team.shop.id);
      // 1 (create) + 59 = 60 so far: the next one is the 61st
      const limited = await t.create(team.owner, team.shop.id, {
        productId: product.id,
        cpcMinor: 25,
        dailyBudgetMinor: 1000,
      });
      expect(limited.status).toBe(429);
      expect(problem(limited).code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.headers['ratelimit']).toBeDefined();
      expect(limited.headers['ratelimit-policy']).toBeDefined();
      expect(await campaignRows()).toHaveLength(1);

      const other = await t.team();
      expect((await t.campaign(other)).campaign.shopId).toBe(other.shop.id); // another shop has its own budget
    });

    it('a limiter store that is down refuses the mutation with 503 rate_limiter_unavailable and writes nothing', async () => {
      const product = await t.product(team.shop.id);
      t.redisProxy!.mode = 'refuse';
      try {
        const res = await t.create(team.owner, team.shop.id, {
          productId: product.id,
          cpcMinor: 25,
          dailyBudgetMinor: 1000,
        });
        expect(res.status).toBe(503);
        expect(problem(res).code).toBe('rate_limiter_unavailable');
      } finally {
        t.redisProxy!.mode = 'pass';
      }
      expect(await campaignRows()).toEqual([]);
    });
  });
});

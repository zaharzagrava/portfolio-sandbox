import { v4 as uuidv4 } from 'uuid';
import {
  adCampaignEventPayloadSchema,
  eventEnvelopeSchema,
  productSponsorshipChangedPayloadSchema,
  sponsoredSlotsResponseSchema,
  type ProductSnapshot,
} from '@marketplace-sandbox/contracts';
import {
  ProductArchived,
  ProductCreated,
  ProductDeleted,
  ProductRestored,
  ProductUpdated,
} from '@app/domains/catalog';
import {
  ShopDeleted,
  ShopOffboardingStarted,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createTopics,
  deleteTopicsMatching,
  readTopic,
  testKafka,
} from '@app/test/utils/kafka-test';
import { AdsProjectorModule } from './ads-projector.module';
import { AdsProductSnapshotProjector } from './infra/product-snapshot.projector';
import { AdsShopSnapshotProjector } from './infra/shop-snapshot.projector';
import {
  createAdsApp,
  type AdsTestApp,
  type Team,
} from './testing/ads.fixtures';

describe('Sponsored listings: product and shop read models', () => {
  let t: AdsTestApp;
  let team: Team;

  beforeAll(async () => {
    // A history to replay must not exist: both source topics and the consumers' dead-letter topics start empty.
    await deleteTopicsMatching(
      /^(products\.events|tenancy\.events|ads-product-snapshot\.dlq|ads-shop-snapshot\.dlq)$/,
    );
    await createTopics([
      { topic: 'products.events', numPartitions: 3 },
      { topic: 'tenancy.events' },
    ]);
    t = await createAdsApp({
      spyProducer: false,
      extraImports: [
        AdsProjectorModule,
        ProjectionsModule.forProjectors(AdsProjectorModule.projectors, [
          AdsProjectorModule,
        ]),
      ],
    });
  });
  afterAll(async () => {
    await t.close();
    await deleteTopicsMatching(
      /^(ads-product-snapshot\.dlq|ads-shop-snapshot\.dlq)$/,
    );
  });
  beforeEach(async () => {
    await t.reset();
    team = await t.team();
  });

  // ---- events -------------------------------------------------------------------------------------------------------

  const snapshot = (
    campaign: { productId: string; shopId: string },
    over: Partial<ProductSnapshot> = {},
  ): ProductSnapshot => ({
    productId: campaign.productId,
    shopId: campaign.shopId,
    title: 'Promoted earbuds',
    description: '',
    brand: 'Acme',
    category: 'audio',
    priceMinor: 1_000,
    currency: 'USD',
    rating: 0,
    tags: [],
    quantity: 5,
    inStock: true,
    status: 'ACTIVE',
    isSandbox: false,
    externalSku: null,
    productVersion: 2,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    changedFields: [],
    ...over,
  });
  const DEFINITIONS = {
    created: ProductCreated,
    updated: ProductUpdated,
    archived: ProductArchived,
    restored: ProductRestored,
  } as const;
  const productEvent = (kind: keyof typeof DEFINITIONS, s: ProductSnapshot) =>
    DEFINITIONS[kind].create(s.productId, s.productVersion, s);
  const productDeleted = (
    campaign: { productId: string; shopId: string },
    version: number,
  ) =>
    ProductDeleted.create(campaign.productId, version, {
      productId: campaign.productId,
      shopId: campaign.shopId,
      productVersion: version,
    });
  const shopStatus = (
    shopId: string,
    to: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED',
    version: number,
  ) =>
    ShopStatusChanged.create(shopId, version, {
      shopId,
      from: 'ACTIVE',
      to,
      shopVersion: version,
    });

  /** Hands real envelopes to the real consumers' entry points, as the framework does after it validated them. */
  const deliver = {
    products: (...events: EventEnvelope[]) =>
      t.app.get(AdsProductSnapshotProjector).project(events),
    shops: (...events: EventEnvelope[]) =>
      t.app.get(AdsShopSnapshotProjector).project(events),
  };
  /** Publishes raw messages to a real topic, for the consumers to process (the framework validates them first). */
  const publish = async (
    topic: string,
    key: string,
    values: Array<object | string>,
  ) => {
    const producer = testKafka().producer();
    await producer.connect();
    try {
      await producer.send({
        topic,
        messages: values.map((v) => ({
          key,
          value: typeof v === 'string' ? v : JSON.stringify(v),
        })),
      });
    } finally {
      await producer.disconnect();
    }
  };

  const serve = async () =>
    sponsoredSlotsResponseSchema.parse(
      (await t.http().get('/api/ads/sponsored?category=audio')).body,
    ).items;
  const campaignRow = async (id: string) =>
    (
      await t.sql<{
        status: string;
        statusReason: string | null;
        campaignVersion: number;
      }>(
        `SELECT "status", "statusReason", "campaignVersion" FROM "AdCampaign" WHERE "id" = :id`,
        { id },
      )
    )[0];
  const productRow = async (productId: string) =>
    (
      await t.sql<{
        productVersion: number;
        title: string;
        status: string;
        inStock: boolean;
      }>(
        `SELECT "productVersion", "title", "status", "inStock" FROM "AdProductSnapshot" WHERE "productId" = :productId`,
        { productId },
      )
    )[0];
  const shopRow = async (shopId: string) =>
    (
      await t.sql<{
        shopVersion: number;
        status: string;
        offboarding: boolean;
        deleted: boolean;
      }>(
        `SELECT "shopVersion", "status", "offboarding", "deleted" FROM "AdShopSnapshot" WHERE "shopId" = :shopId`,
        { shopId },
      )
    )[0];
  const types = async (aggregateId: string) =>
    (await t.events(aggregateId)).map((e) => e.type);

  // ---- scenarios ----------------------------------------------------------------------------------------------------

  describe('S36 AS-70: product events: guard, order, duplicates, invalid', () => {
    it('a late older version is ignored and a repeated version has no second effect', async () => {
      const { campaign } = await t.campaign(team, { product: { version: 1 } });
      const v3 = snapshot(campaign, {
        title: 'Version three',
        productVersion: 3,
      });

      expect(await deliver.products(productEvent('updated', v3))).toMatchObject(
        { applied: 1 },
      );
      expect(await productRow(campaign.productId)).toMatchObject({
        productVersion: 3,
        title: 'Version three',
      });

      const late = await deliver.products(
        productEvent(
          'updated',
          snapshot(campaign, { title: 'Version two', productVersion: 2 }),
        ),
      );
      expect(late).toMatchObject({ applied: 0 });
      expect(await productRow(campaign.productId)).toMatchObject({
        productVersion: 3,
        title: 'Version three',
      });

      const again = await deliver.products(productEvent('updated', v3));
      expect(again).toMatchObject({ applied: 0 });
      expect(await productRow(campaign.productId)).toMatchObject({
        productVersion: 3,
      });
    });

    it('invalid payloads are dead-lettered with no effect and the consumer carries on', async () => {
      const { campaign } = await t.campaign(team, { product: { version: 1 } });
      const good = productEvent(
        'updated',
        snapshot(campaign, { title: 'After the poison', productVersion: 5 }),
      );
      const missing = {
        ...good,
        payload: { ...good.payload, productId: undefined },
        eventId: uuidv4(),
      };
      const notUuid = {
        ...good,
        payload: { ...good.payload, productId: 'nope' },
        eventId: uuidv4(),
      };
      const negative = {
        ...good,
        payload: { ...good.payload, productVersion: -1 },
        eventId: uuidv4(),
      };

      await publish('products.events', campaign.productId, [
        missing,
        notUuid,
        negative,
        good,
      ]);

      await waitFor(
        async () =>
          (await productRow(campaign.productId))?.productVersion === 5,
        {
          description: 'the valid event after the poison is applied',
          timeoutMs: 40_000,
        },
      );
      expect(await productRow(campaign.productId)).toMatchObject({
        title: 'After the poison',
      });
      await waitFor(
        async () => (await readTopic('ads-product-snapshot.dlq')).length >= 3,
        {
          description: 'three dead letters',
          timeoutMs: 40_000,
        },
      );
    }, 90_000);
  });

  it('S36 AS-71: archive pauses the campaign, restore does not resume it, delete ends it, out of stock only stops serving', async () => {
    const { campaign } = await t.campaign(team, { product: { version: 1 } });
    const served = async () => (await serve()).map((i) => i.campaignId);
    expect(await served()).toEqual([campaign.id]);

    await deliver.products(
      productEvent(
        'updated',
        snapshot(campaign, { inStock: false, productVersion: 2 }),
      ),
    );
    expect(await campaignRow(campaign.id)).toMatchObject({ status: 'ACTIVE' });
    expect(await served()).toEqual([]);
    await deliver.products(
      productEvent(
        'updated',
        snapshot(campaign, { inStock: true, productVersion: 3 }),
      ),
    );
    expect(await served()).toEqual([campaign.id]);

    await deliver.products(
      productEvent(
        'archived',
        snapshot(campaign, { status: 'ARCHIVED', productVersion: 4 }),
      ),
    );
    expect(await campaignRow(campaign.id)).toMatchObject({
      status: 'PAUSED',
      statusReason: 'product_unavailable',
      campaignVersion: 2,
    });
    expect(await served()).toEqual([]);
    expect(await types(campaign.id)).toContain('marketing.campaign_paused');
    const sponsorship = (await t.events(campaign.productId)).map(
      (e) => e.payload.sponsored,
    );
    expect(sponsorship).toEqual([true, false]);

    await deliver.products(
      productEvent(
        'restored',
        snapshot(campaign, { status: 'ACTIVE', productVersion: 5 }),
      ),
    );
    expect(await campaignRow(campaign.id)).toMatchObject({
      status: 'PAUSED',
      statusReason: 'product_unavailable',
    });
    expect(await served()).toEqual([]); // restoring never resumes spending by itself

    await deliver.products(productDeleted(campaign, 6));
    expect(await campaignRow(campaign.id)).toMatchObject({ status: 'ENDED' });
    expect(await types(campaign.id)).toContain('marketing.campaign_ended');
    expect(await productRow(campaign.productId)).toMatchObject({
      status: 'DELETED',
      productVersion: 6,
    });
    const [quota] = await t.sql<{ openCount: number }>(
      `SELECT "openCount" FROM "AdShopQuota" WHERE "shopId" = :shopId`,
      { shopId: team.shop.id },
    );
    expect(quota.openCount).toBe(0);
  });

  it('S36 AS-72: a campaign paused for an unavailable product or a shop that is not active cannot be resumed', async () => {
    const { campaign } = await t.campaign(team, { product: { version: 1 } });
    await deliver.products(
      productEvent(
        'archived',
        snapshot(campaign, { status: 'ARCHIVED', productVersion: 2 }),
      ),
    );
    const before = await campaignRow(campaign.id);

    const unavailable = await t.act(
      team.owner,
      team.shop.id,
      campaign.id,
      'resume',
    );
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.code).toBe('product_unavailable');
    expect(await campaignRow(campaign.id)).toEqual(before);

    await deliver.products(
      productEvent(
        'restored',
        snapshot(campaign, { status: 'ACTIVE', productVersion: 3 }),
      ),
    );
    await deliver.shops(shopStatus(team.shop.id, 'SUSPENDED', 5));
    const inactive = await t.act(
      team.owner,
      team.shop.id,
      campaign.id,
      'resume',
    );
    expect(inactive.status).toBe(409);
    expect(inactive.body.code).toBe('shop_inactive');
    expect(await campaignRow(campaign.id)).toEqual(before);

    await deliver.shops(shopStatus(team.shop.id, 'ACTIVE', 6));
    expect(
      (await t.act(team.owner, team.shop.id, campaign.id, 'resume')).status,
    ).toBe(200);
  });

  describe('S36 AS-73: shop events', () => {
    it('suspend and reinstate stop and restore serving, a late version is ignored, offboarding stops serving, deletion ends the campaigns and keeps the billing records', async () => {
      const first = await t.campaign(team, { product: { version: 1 } });
      const second = await t.campaign(team, { product: { version: 1 } });
      const served = async () => (await serve()).length;
      await t.sql(
        `INSERT INTO "AdBillingRun" ("campaignId", "hour", "state", "source", "clicks", "billableClicks", "cappedClicks", "amountMinor", "ledgerReference", "chargedAt")
         VALUES (:id, '2026-10-05T10:00:00Z', 'CHARGED', 'stream', 4, 4, 0, 100, :ref, now()) RETURNING 1`,
        { id: first.campaign.id, ref: `ad:${first.campaign.id}:2026-10-05T10` },
      );
      expect(await served()).toBe(1); // one slot per shop

      await deliver.shops(shopStatus(team.shop.id, 'SUSPENDED', 5));
      expect(await shopRow(team.shop.id)).toMatchObject({
        status: 'SUSPENDED',
        shopVersion: 5,
      });
      expect(await served()).toBe(0);
      expect(await campaignRow(first.campaign.id)).toMatchObject({
        status: 'ACTIVE',
      });

      await deliver.shops(shopStatus(team.shop.id, 'ACTIVE', 6));
      expect(await served()).toBe(1);

      const late = await deliver.shops(
        shopStatus(team.shop.id, 'SUSPENDED', 5),
      ); // arrives after version 6
      expect(late).toMatchObject({ applied: 0 });
      expect(await shopRow(team.shop.id)).toMatchObject({
        status: 'ACTIVE',
        shopVersion: 6,
      });
      expect(await served()).toBe(1);

      await deliver.shops(
        ShopOffboardingStarted.create(team.shop.id, 7, {
          shopId: team.shop.id,
          purgeAt: '2026-11-12T00:00:00.000Z',
          shopVersion: 7,
        }),
      );
      expect(await shopRow(team.shop.id)).toMatchObject({
        offboarding: true,
        shopVersion: 7,
      });
      expect(await served()).toBe(0);

      const deleted = ShopDeleted.create(team.shop.id, 8, {
        shopId: team.shop.id,
        shopVersion: 8,
      });
      await deliver.shops(deleted);
      await deliver.shops(deleted); // delivered twice
      for (const c of [first.campaign, second.campaign])
        expect(await campaignRow(c.id)).toMatchObject({ status: 'ENDED' });
      expect(
        (await types(first.campaign.id)).filter(
          (x) => x === 'marketing.campaign_ended',
        ),
      ).toHaveLength(1);
      expect(
        await t.sql(`SELECT 1 FROM "AdBillingRun" WHERE "campaignId" = :id`, {
          id: first.campaign.id,
        }),
      ).toHaveLength(1); // financial records stay
    });

    it('an invalid shop event is dead-lettered with no effect and the consumer carries on', async () => {
      await t.campaign(team);
      const good = shopStatus(team.shop.id, 'SUSPENDED', 9);
      const bad = {
        ...good,
        eventId: uuidv4(),
        payload: { shopId: team.shop.id, to: 'SUSPENDED' },
      };

      await publish('tenancy.events', team.shop.id, [bad, good]);

      await waitFor(
        async () => (await shopRow(team.shop.id))?.shopVersion === 9,
        {
          description: 'the valid event after the invalid one is applied',
          timeoutMs: 40_000,
        },
      );
      await waitFor(
        async () => (await readTopic('ads-shop-snapshot.dlq')).length >= 1,
        {
          description: 'a dead letter',
          timeoutMs: 40_000,
        },
      );
    }, 90_000);
  });

  it('S36 AS-74: a campaign is served at once from the read model seeded at creation, and an event with a lower version is ignored', async () => {
    const { campaign, product } = await t.campaign(team, {
      product: { version: 3, title: 'Seeded title' },
    });

    expect((await serve()).map((i) => i.campaignId)).toEqual([campaign.id]);
    expect(await productRow(campaign.productId)).toMatchObject({
      productVersion: 3,
      title: 'Seeded title',
      status: 'ACTIVE',
    });
    expect(await shopRow(team.shop.id)).toMatchObject({
      status: 'ACTIVE',
      shopVersion: 1,
    });

    const stale = await deliver.products(
      productEvent(
        'updated',
        snapshot(
          { productId: product.id, shopId: team.shop.id },
          { title: 'Older', productVersion: 2 },
        ),
      ),
    );
    expect(stale).toMatchObject({ applied: 0 });
    expect(await productRow(campaign.productId)).toMatchObject({
      title: 'Seeded title',
      productVersion: 3,
    });
  });

  describe('S36 AS-75: event contract and atomicity', () => {
    it('every campaign event and the sponsorship event parse with their contract schema and carry the envelope', async () => {
      const { campaign } = await t.campaign(team);
      await t.act(team.owner, team.shop.id, campaign.id, 'pause');
      await t.act(team.owner, team.shop.id, campaign.id, 'resume');
      await t.act(team.owner, team.shop.id, campaign.id, 'end');

      const campaignEvents = await t.events(campaign.id);
      expect(campaignEvents.map((e) => e.type)).toEqual([
        'marketing.campaign_created',
        'marketing.campaign_paused',
        'marketing.campaign_resumed',
        'marketing.campaign_ended',
      ]);
      for (const event of campaignEvents) {
        expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
        expect(event).toMatchObject({ version: 1, aggregateId: campaign.id });
        expect(event.eventId).toBeTruthy();
        expect(Date.parse(event.occurredAt)).not.toBeNaN();
        expect(
          adCampaignEventPayloadSchema.parse(event.payload).campaignId,
        ).toBe(campaign.id);
      }
      const sponsorship = await t.events(campaign.productId);
      expect(sponsorship).toHaveLength(4);
      for (const event of sponsorship) {
        expect(eventEnvelopeSchema.safeParse(event).success).toBe(true);
        expect(event).toMatchObject({
          type: 'marketing.product_sponsorship_changed',
          version: 1,
        });
        productSponsorshipChangedPayloadSchema.parse(event.payload);
      }
    });

    it('a create whose transaction fails after the campaign insert leaves no campaign, history, sponsorship row or event', async () => {
      const product = await t.product(team.shop.id);
      t.faults.set('campaigns.appendHistory', { kind: 'down' });

      const res = await t.create(team.owner, team.shop.id, {
        productId: product.id,
        cpcMinor: 25,
        dailyBudgetMinor: 1_000,
      });

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(
        await t.sql(`SELECT 1 FROM "AdCampaign" WHERE "productId" = :id`, {
          id: product.id,
        }),
      ).toEqual([]);
      expect(await t.sql(`SELECT 1 FROM "AdCampaignHistory"`)).toEqual([]);
      expect(
        await t.sql(
          `SELECT 1 FROM "AdProductSponsorship" WHERE "productId" = :id`,
          { id: product.id },
        ),
      ).toEqual([]);
      expect(
        await t.sql(
          `SELECT 1 FROM "AdProductSnapshot" WHERE "productId" = :id`,
          { id: product.id },
        ),
      ).toEqual([]);
      expect(await t.events(product.id)).toEqual([]);
      expect(
        await t.sql(
          `SELECT 1 FROM "AdShopQuota" WHERE "shopId" = :id AND "openCount" > 0`,
          { id: team.shop.id },
        ),
      ).toEqual([]);
    });
  });
});

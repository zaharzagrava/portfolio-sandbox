import { INestApplication, Module } from '@nestjs/common';
import { getConnectionToken, getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { createHmac } from 'node:crypto';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { IntegrationsModule } from './integrations.module';
import { IntegrationSyncService } from './application/integration-sync.service';
import { FakeProduct } from './infra/fake.provider';

@Module({ imports: [IntegrationsModule, SequelizeModule.forFeature([Shop])] })
class SpecModule {}

/** SD-36 against real Postgres + Redis with the fake provider (different shape, page size 2) as the remote store. */
describe('Shop integrations sync (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let sync: IntegrationSyncService;
  let db: Sequelize;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], { stores: ['redis', 'sqs'] });
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    sync = app.get(IntegrationSyncService);
    db = app.get(getConnectionToken());
    jest.spyOn(app.get(TaskQueue), 'enqueue').mockResolvedValue('m');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const product = (id: string, qty: number, modified: string, extra: Partial<FakeProduct> = {}): FakeProduct => ({ id, name: `Remote ${id}`, price_cents: 1999, qty, type: 'audio', modified, ...extra });

  const connect = async () => {
    const shop = await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'Synced', slug: `sy-${v4().slice(0, 8)}` });
    const { integrationId } = await sync.connect(shop.id, 'fake', 'remote-store', { secret: 'hook-secret' });
    const remote = await sync.fakeFor(integrationId);
    return { shopId: shop.id, integrationId, remote };
  };
  const local = async (integrationId: string, externalId: string) =>
    (
      await db.query<{ id: string; quantity: number; title: string }>(
        `SELECT p.id, p.quantity, p.title FROM "Product" p JOIN "ExternalLink" l ON l."localId" = p.id WHERE l."integrationId" = :integrationId AND l."externalId" = :externalId`,
        { type: QueryTypes.SELECT, replacements: { integrationId, externalId } },
      )
    )[0];

  it('initial sync pages through everything; a malformed product is quarantined, not fatal', async () => {
    const { integrationId, remote } = await connect();
    for (let i = 1; i <= 4; i++) remote.upsert(product(`p${i}`, i * 10, minutesAgo(60 - i)));
    remote.upsert({ id: 'bad', name: 'Broken', price_cents: 'free', qty: 1, type: 'audio', modified: minutesAgo(30) }); // schema drift

    expect(await sync.syncIncremental(integrationId)).toEqual({ applied: 4, skipped: 0, quarantined: 1 });
    expect(await local(integrationId, 'p3')).toMatchObject({ quantity: 30, title: 'Remote p3' });
    const [q] = await db.query<{ reason: string }>(`SELECT reason FROM "SyncQuarantine" WHERE "integrationId" = :integrationId`, { type: QueryTypes.SELECT, replacements: { integrationId } });
    expect(q.reason).toMatch(/^schema: priceMinor/);
  });

  it('incremental: only changes since the watermark (with a re-read overlap that applies nothing twice)', async () => {
    const { integrationId, remote } = await connect();
    remote.upsert(product('old', 5, minutesAgo(120)));
    remote.upsert(product('recent', 5, minutesAgo(2)));
    await sync.syncIncremental(integrationId);

    remote.upsert(product('recent', 7, new Date().toISOString())); // changed at the provider
    const second = await sync.syncIncremental(integrationId);
    expect(second.applied).toBe(1);
    expect(second.skipped).toBe(0); // 'old' is outside watermark − 5 min; 'recent' changed
    expect(await local(integrationId, 'recent')).toMatchObject({ quantity: 7 });
    expect((await sync.syncIncremental(integrationId)).applied).toBe(0); // overlap re-read of 'recent' → hash equal → skipped
  });

  it('bidirectional stock without ping-pong: our change is pushed once; the provider echo is ignored', async () => {
    const { integrationId, remote } = await connect();
    remote.upsert(product('sku-1', 10, minutesAgo(10)));
    await sync.syncIncremental(integrationId);
    const mine = await local(integrationId, 'sku-1');

    expect(await sync.pushStock(mine.id)).toBe(0); // inbound apply already in sync → nothing to push
    await db.query(`UPDATE "Product" SET quantity = 8 WHERE id = :id`, { replacements: { id: mine.id } }); // sold 2 on the marketplace
    expect(await sync.pushStock(mine.id)).toBe(1);
    expect(remote.stockWrites).toEqual([{ id: 'sku-1', qty: 8 }]);

    expect((await sync.syncIncremental(integrationId)).applied).toBe(0); // the provider's updated_at moved: the echo comes back, hash says "already have it"
    expect(await sync.pushStock(mine.id)).toBe(0);
    expect(remote.stockWrites).toHaveLength(1);
  });

  it('webhooks: HMAC over the raw body; then the CURRENT state is fetched', async () => {
    const { integrationId, remote } = await connect();
    remote.upsert(product('hooked', 3, minutesAgo(1)));
    const body = Buffer.from(JSON.stringify({ id: 'hooked' }));
    expect(await sync.verifyWebhook(integrationId, body, { 'x-fake-signature': createHmac('sha256', 'hook-secret').update(body).digest('hex') })).toBe(true);
    expect(await sync.verifyWebhook(integrationId, body, { 'x-fake-signature': 'forged' })).toBe(false);
    expect(await sync.syncOne(integrationId, 'hooked')).toMatchObject({ result: 'applied' });
  });

  it('nightly reconciliation zeroes products deleted at the provider and reports them', async () => {
    const { integrationId, remote } = await connect();
    remote.upsert(product('keep', 4, minutesAgo(10)));
    remote.upsert(product('gone', 4, minutesAgo(10)));
    await sync.syncIncremental(integrationId);
    remote.products.delete('gone');
    expect(await sync.reconcile(integrationId)).toEqual({ deletedAtProvider: 1, missingLocally: 0 });
    expect(await local(integrationId, 'gone')).toMatchObject({ quantity: 0 });
  });
});

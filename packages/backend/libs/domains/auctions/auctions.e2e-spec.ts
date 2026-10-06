import { INestApplication, Module } from '@nestjs/common';
import { getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { v4 } from 'uuid';
import { QueryTypes } from 'sequelize';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { TenancyModule, ShopModel as Shop, ShopMembershipModel as ShopMembership } from '@app/domains/tenancy';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { UserModel as User } from '@app/domains/identity';
import Auction from './infra/models/auction.model';
import { BisOrderModel as BisOrder, FlashStockService, OrderService, ORDER_MODELS } from '@app/domains/orders';
import { AuctionsModule } from './auctions.module';
import { AuctionService, bidStreamKey, BID_RELAY_GROUP, stateKey } from './application/auction.service';
import { AuctionJobs } from './infra/auction.jobs';
import { BidRelay } from './infra/bid-relay.service';
import { EventsModule } from '@app/infrastructure/events/events.module';

@Module({
  imports: [EventsModule, SequelizeModule.forFeature([Auction, ...ORDER_MODELS])],
  providers: [AuctionJobs, BidRelay, OrderService, FlashStockService],
})
class AuctionsWorkerSpecModule {}

/** SD-22 against real Redis (Lua) + Postgres. */
describe('Auctions (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let auctions: AuctionService;
  let redis: RedisService;
  let shop: Shop;
  let productId: string;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([AuctionsModule, AuctionsWorkerSpecModule, TenancyModule, CacheModule, SeedsModule], { stores: ['redis', 'dynamo'] });
    app = moduleRef.createNestApplication();
    await app.init();
    await app.get(BidRelay).stop(); // flushed by hand in specs
    seeds = app.get(SeedsService);
    auctions = app.get(AuctionService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    shop = await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'Sneakers', slug: `s-${v4().slice(0, 8)}` });
    const [product] = await seeds.createTreelike([{ __type__: TableName.Product, quantity: 1, shopId: shop.id }]);
    productId = product.id;
  });

  const users = (n: number) => app.get<typeof User>(getModelToken(User)).bulkCreate(Array.from({ length: n }, () => ({ email: `u-${v4()}@mail.com` })), { returning: true });
  const open = (endsInMs = 3_600_000, reservePrice?: number) =>
    auctions.create(shop.id, { productId, title: 'Signed #001/100', startingPrice: 10, minIncrement: 5, reservePrice, startsAt: new Date(), endsAt: new Date(Date.now() + endsInMs) });

  it('proxy bidding: the visible price is second-highest max + increment, capped by the leader max', async () => {
    const auction = await open();
    const [a, b, c] = await users(3);

    expect(await auctions.placeBid(auction.id, a.id, 100)).toMatchObject({ outcome: 'leading', price: 10, leaderId: a.id });
    expect(await auctions.placeBid(auction.id, b.id, 50)).toMatchObject({ outcome: 'outbid', price: 55, leaderId: a.id });
    expect(await auctions.placeBid(auction.id, c.id, 120)).toMatchObject({ outcome: 'leading', price: 105, leaderId: c.id });
    expect(await auctions.placeBid(auction.id, a.id, 104)).toMatchObject({ outcome: 'too_low' });
  });

  it('50 concurrent bids: the highest max wins at (second max + increment), state never regresses', async () => {
    const auction = await open();
    const bidders = await users(50);
    await inParallel(50, (i) => auctions.placeBid(auction.id, bidders[i].id, 100 + i * 10)); // maxima 100..590

    const view = await auctions.view(auction.id);
    expect(view.leaderId).toBe(bidders[49].id);
    expect(view.price).toBe(585); // 580 + 5
  });

  it('anti-sniping: a bid in the final 2 minutes extends the end', async () => {
    const auction = await open(30_000);
    const [a] = await users(1);
    const result = await auctions.placeBid(auction.id, a.id, 50);
    expect(result.endsAt).toBeGreaterThanOrEqual(Date.now() + 110_000);
  });

  it("the selling shop's members can't bid (shill bidding)", async () => {
    const auction = await open();
    const [staff] = await users(1);
    await app.get<typeof ShopMembership>(getModelToken(ShopMembership)).create({ shopId: shop.id, userId: staff.id, role: 'STAFF' });
    await expect(auctions.placeBid(auction.id, staff.id, 50)).rejects.toMatchObject({ status: 403 });
  });

  it('bid relay: stream → Postgres in batches, idempotent on redelivery', async () => {
    const auction = await open();
    const bidders = await users(5);
    for (let i = 0; i < 5; i++) await auctions.placeBid(auction.id, bidders[i].id, 100 + i * 10);

    const res = (await redis.client.xreadgroup('GROUP', BID_RELAY_GROUP, 'spec', 'COUNT', 100, 'STREAMS', bidStreamKey(auction.id), '>')) as [string, [string, string[]][]][];
    const relay = app.get(BidRelay);
    await relay.flush(bidStreamKey(auction.id), res[0][1]);
    await relay.flush(bidStreamKey(auction.id), res[0][1]); // crash-before-ack redelivery

    const [{ count }] = await app.get<typeof Auction>(getModelToken(Auction)).sequelize!.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "Bid" WHERE "auctionId" = :id`,
      { replacements: { id: auction.id }, type: QueryTypes.SELECT },
    );
    expect(count).toBe(5);
    const row = await app.get<typeof Auction>(getModelToken(Auction)).findByPk(auction.id);
    expect(row!.leaderId).toBe(bidders[4].id);
    expect(row!.version).toBe(5);
  });

  it('close: exactly once, winner gets a RESERVED order; an extended auction is re-scheduled instead of closed', async () => {
    const auction = await open(60_000);
    const [a] = await users(1);
    await auctions.placeBid(auction.id, a.id, 80);

    const jobs = app.get(AuctionJobs);
    await jobs.close({ auctionId: auction.id }); // not yet ended (and extended by anti-snipe)
    expect((await app.get<typeof Auction>(getModelToken(Auction)).findByPk(auction.id))!.status).toBe('OPEN');

    await redis.client.hset(stateKey(auction.id), 'endsAt', Date.now() - 1);
    await inParallel(3, () => jobs.close({ auctionId: auction.id }));

    const closed = await app.get<typeof Auction>(getModelToken(Auction)).findByPk(auction.id);
    expect(closed).toMatchObject({ status: 'CLOSED', winnerId: a.id });
    const orders = await app.get<typeof BisOrder>(getModelToken(BisOrder)).findAll({ where: { userId: a.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ status: 'RESERVED', idempotencyKey: `auction:${auction.id}` });
  });
});

import { INestApplication } from '@nestjs/common';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { FeedModule } from './feed.module';
import { FeedService, CELEBRITIES, activeKey } from './application/feed.service';
import { FeedPublisher } from './application/feed-publisher.service';
import { FeedFanoutConsumer } from './infra/fanout.consumer';

/** SD-09 against real ScyllaDB + Redis; the Kafka hop is replaced by calling the fan-out consumer directly. */
describe('Follow feed (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let feed: FeedService;
  let publisher: FeedPublisher;
  let fanout: FeedFanoutConsumer;
  let redis: RedisService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([FeedModule, SeedsModule, { module: class FanoutSpec {}, providers: [FeedFanoutConsumer] }], {
      stores: ['redis', 'cassandra'],
    });
    app = moduleRef.createNestApplication();
    await app.init();
    seeds = app.get(SeedsService);
    feed = app.get(FeedService);
    publisher = app.get(FeedPublisher);
    fanout = app.get(FeedFanoutConsumer);
    redis = app.get(RedisService);
    jest.spyOn(app.get(KafkaProducerService), 'send').mockResolvedValue(undefined as never);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  const shop = () => `shop:${v4()}`;
  const publishAndFanOut = async (author: string, title: string) => {
    const itemId = await publisher.publish(author, 'new_product', title, {});
    return fanout.fanOut(author, itemId, Date.now());
  };

  it('push: an active follower sees a normal shop\'s new item via their Redis timeline', async () => {
    const reader = v4();
    const s = shop();
    await feed.follow(reader, s);
    await feed.timeline(reader); // becomes active

    const result = await publishAndFanOut(s, 'AirPods Pro 3');
    expect(result).toEqual({ pushed: 1, celebrity: false });
    expect((await feed.timeline(reader)).items.map((i) => i.title)).toEqual(['AirPods Pro 3']);
  });

  it('pull: celebrity items are not fanned out but merged in at read time', async () => {
    const reader = v4();
    const apple = shop();
    await feed.follow(reader, apple);
    await feed.timeline(reader);
    await redis.client.sadd(CELEBRITIES, apple); // as if it crossed the follower threshold

    expect(await publishAndFanOut(apple, 'iPhone 18 announced')).toEqual({ pushed: 0, celebrity: true });
    expect((await feed.timeline(reader)).items.map((i) => i.title)).toEqual(['iPhone 18 announced']);
  });

  it('inactive followers get nothing pushed; on return their timeline is rebuilt by pull, newest first', async () => {
    const reader = v4();
    const [a, b] = [shop(), shop()];
    await feed.follow(reader, a);
    await feed.follow(reader, b);

    expect((await publishAndFanOut(a, 'first')).pushed).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    expect((await publishAndFanOut(b, 'second')).pushed).toBe(0);
    expect(await redis.client.exists(activeKey(reader))).toBe(0);

    expect((await feed.timeline(reader)).items.map((i) => i.title)).toEqual(['second', 'first']);
  });

  it('unfollow hides already-delivered items at hydration', async () => {
    const reader = v4();
    const s = shop();
    await feed.follow(reader, s);
    await feed.timeline(reader);
    await publishAndFanOut(s, 'gone soon');

    await feed.unfollow(reader, s);
    expect((await feed.timeline(reader)).items).toEqual([]);
  });
});

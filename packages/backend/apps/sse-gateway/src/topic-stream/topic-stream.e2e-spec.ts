import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'node:net';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { readSse } from '@app/test/utils/sse-client';
import { RealtimePublisher } from '@app/infrastructure/realtime/realtime-publisher.service';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { AuthService, IdentityTopicsModule } from '@app/domains/identity';
import { AuctionTopicsModule } from '@app/domains/auctions';
import { LaunchEventTopicsModule } from '@app/domains/launch-events';
import { TopicStreamModule } from './topic-stream.module';

/** F-03 against the real test Redis: replay after reconnect, per-topic authorization. */
describe('Topic streams (e2e, real Redis)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let publisher: RealtimePublisher;
  let seedsService: SeedsService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      // The topics these tests subscribe to are defined by their owning domains (auction:, stream:, user:; debt D-3).
      [
        TopicStreamModule,
        IdentityTopicsModule,
        AuctionTopicsModule,
        LaunchEventTopicsModule,
        SeedsModule,
      ],
      { stores: ['redis'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api`;
    publisher = app.get(RealtimePublisher);
    seedsService = app.get(SeedsService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedsService.clean();
  });

  it('replays exactly the events missed since Last-Event-ID, then continues live', async () => {
    const topic = `auction:${v4().slice(0, 8)}` as const;
    const ids: string[] = [];
    for (let price = 1; price <= 5; price++)
      ids.push(await publisher.publish(topic, 'price', { price }));

    // Client saw up to event #2, reconnects.
    const { events } = await readSse(`${baseUrl}/streams?topics=${topic}`, {
      headers: { 'last-event-id': `${topic}~${ids[1]}` },
      count: 3,
    });

    expect(events.map((e) => JSON.parse(e.data!).data.price)).toEqual([
      3, 4, 5,
    ]);
    expect(events.every((e) => e.event === 'price')).toBe(true);
    // The cursor in `id:` lets the next reconnect resume after #5.
    expect(events[2].id).toBe(`${topic}~${ids[4]}`);
  });

  it('delivers live events published after connecting', async () => {
    const topic = `stream:${v4().slice(0, 8)}` as const;
    const reading = readSse(`${baseUrl}/streams?topics=${topic}`, { count: 2 });
    await new Promise((r) => setTimeout(r, 300)); // let the subscription register
    await publisher.publish(topic, 'comment', { text: 'first' });
    await publisher.publish(topic, 'comment', { text: 'second' });

    const { events } = await reading;
    expect(events.map((e) => JSON.parse(e.data!).data.text)).toEqual([
      'first',
      'second',
    ]);
  });

  it('private user topics: owner allowed, others 403, anonymous 403', async () => {
    const [alice] = await seedsService.createTreelike([
      { __type__: TableName.User, email: `alice-${v4()}@mail.com` },
    ]);
    const [bob] = await seedsService.createTreelike([
      { __type__: TableName.User, email: `bob-${v4()}@mail.com` },
    ]);
    const auth = app.get(AuthService);
    const bobToken = auth.issueTokensFor(bob).accessToken.token;
    const aliceToken = auth.issueTokensFor(alice).accessToken.token;

    const asBob = await readSse(`${baseUrl}/streams?topics=user:${alice.id}`, {
      headers: { authorization: `Bearer ${bobToken}` },
      count: 1,
      timeoutMs: 2_000,
    });
    expect(asBob.status).toBe(403);

    const anonymous = await readSse(
      `${baseUrl}/streams?topics=user:${alice.id}`,
      { count: 1, timeoutMs: 2_000 },
    );
    expect(anonymous.status).toBe(403);

    const reading = readSse(`${baseUrl}/streams?topics=user:${alice.id}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
      count: 1,
    });
    await new Promise((r) => setTimeout(r, 300));
    await publisher.publish(`user:${alice.id}`, 'notification', {
      title: 'Your order shipped',
    });
    const asAlice = await reading;
    expect(asAlice.status).toBe(200);
    expect(JSON.parse(asAlice.events[0].data!).data.title).toBe(
      'Your order shipped',
    );
  });
});

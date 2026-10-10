import { Injectable, Module, OnModuleInit } from '@nestjs/common';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import {
  createRealtimeApp,
  freshId,
  type RealtimeTestApp,
} from '@app/test/utils/realtime-app';
import { readSse } from '@app/test/utils/sse-client';
import { RealtimeModule } from './realtime.module';
import { TopicRegistry } from './topic-registry';

@Injectable()
class SecondAuctionOwner implements OnModuleInit {
  constructor(private readonly registry: TopicRegistry) {}
  onModuleInit() {
    this.registry.define({
      prefix: 'auction',
      owner: 'second-owner',
      policy: () => true,
    });
  }
}
@Module({ imports: [RealtimeModule], providers: [SecondAuctionOwner] })
class SecondAuctionModule {}

/** S51 US10 (AS-62, AS-63): routes are (prefix, suffix) pairs; a duplicate fails the boot. */
describe('S51 registry (REG)', () => {
  let rt: RealtimeTestApp;

  beforeAll(async () => {
    rt = await createRealtimeApp();
  });
  afterAll(async () => {
    await rt.close();
  });

  it('S51 AS-62: a hyphenated prefix is valid, suffixes of one prefix coexist with their own rule, and bare or unknown shapes are 400', async () => {
    const user = await rt.newUser();
    const shop = freshId();
    rt.fixtures.member(shop, user.id); // may follow live, not assets
    const ask = (topic: string) =>
      readSse(rt.url(topic), {
        headers: { authorization: user.bearer },
        count: 1,
        timeoutMs: 600,
      });

    expect((await ask(`order-export:${user.id}`)).status).toBe(200);
    expect((await ask(`shop:${shop}:live`)).status).toBe(200);
    expect((await ask(`shop:${shop}:assets`)).status).toBe(403); // the assets rule, not the live rule, decides it
    rt.fixtures.assetMembers.add(`${shop}:${user.id}`);
    expect((await ask(`shop:${shop}:assets`)).status).toBe(200);

    for (const topic of [`shop:${shop}`, `shop:${shop}:other`]) {
      const res = await ask(topic);
      expect(res.status).toBe(400);
      expect(problemDetailsSchema.parse(res.body).code).toBe('invalid_topics');
    }
  });

  it('S51 AS-63: a route defined twice fails the boot and names the route', async () => {
    await expect(
      createRealtimeApp({
        keepStore: true,
        extraImports: [SecondAuctionModule],
      }),
    ).rejects.toThrow(/realtime route "auction" is defined twice/);
  });
});

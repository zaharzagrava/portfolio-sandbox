import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { inParallel } from '@app/test/utils/async-helpers';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { ApiConfigService } from '@app/common/config';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ShareLinksModule } from './share-links.module';
import { ShareLinkService } from './application/share-link.service';

/** SD-08 against real DynamoDB Local + Redis (Kafka produce spied). */
describe('Share links (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let links: ShareLinkService;
  let send: jest.SpyInstance;
  let front: string;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [ShareLinksModule, CacheModule, RateLimitModule, SeedsModule],
      { stores: ['redis', 'dynamo'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    seeds = app.get(SeedsService);
    links = app.get(ShareLinkService);
    front = app.get(ApiConfigService).get('front_host');
    send = jest
      .spyOn(app.get(KafkaProducerService), 'send')
      .mockResolvedValue(undefined as never);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
    send.mockClear();
  });

  it('create → 302 to the destination with ?ref=<code>; the click is recorded asynchronously', async () => {
    const link = await links.create(v4(), `${front}/p/iphone-17?color=blue`);
    expect(link.code).toMatch(/^[0-9A-Za-z]{7}$/);

    const res = await request(app.getHttpServer())
      .get(`/api/l/${link.code}`)
      .expect(302);
    expect(res.headers.location).toBe(
      `${front}/p/iphone-17?color=blue&ref=${link.code}`,
    );
    expect(res.headers['cache-control']).toBe('public, s-maxage=10');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'links.events', key: link.code }),
    );
  });

  it('edge-served clicks are not double counted', async () => {
    const link = await links.create(v4(), `${front}/p/x`);
    await request(app.getHttpServer())
      .get(`/api/l/${link.code}`)
      .set('x-edge-click-recorded', '1')
      .expect(302);
    expect(send).not.toHaveBeenCalled();
  });

  it('custom alias: concurrent claims → exactly one owner', async () => {
    const alias = `drop-${v4().slice(0, 6)}`;
    const results = await inParallel(10, () =>
      links.create(v4(), `${front}/drops/sneakers`, alias),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('unknown codes 404 (Bloom filter short-circuit); off-marketplace destinations are rejected (no open redirect)', async () => {
    await request(app.getHttpServer()).get('/api/l/Zz9Zz9Z').expect(404);
    await expect(
      links.create(v4(), 'https://evil.example/phish'),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      links.create(v4(), 'javascript:alert(1)'),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('a just-claimed alias is not shadowed by a cached "not found"', async () => {
    const alias = `late-${v4().slice(0, 6)}`;
    expect(await links.resolve(alias)).toBeNull(); // negative-cached
    await links.create(v4(), `${front}/p/y`, alias);
    expect(await links.resolve(alias)).toMatchObject({ code: alias });
  });
});

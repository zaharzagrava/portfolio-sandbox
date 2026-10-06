import { INestApplication, Module } from '@nestjs/common';
import { getConnectionToken, getModelToken, SequelizeModule } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { ShopModel as Shop } from '@app/domains/tenancy';
import Outbox from '@app/infrastructure/outbox/outbox.model';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { StoriesModule, StoryCacheModule, StoryCacheInvalidator } from './stories.module';
import { StoriesService } from './application/stories.service';
import { CdnPurger, LoggingPurger } from './infra/cache-invalidation';

@Module({ imports: [StoriesModule, StoryCacheModule, SequelizeModule.forFeature([Shop, Outbox])], providers: [StoryCacheInvalidator] })
class SpecModule {}

/** SD-05 against real Postgres + Redis. */
describe('Brand stories CMS (e2e)', () => {
  let app: INestApplication;
  let seeds: SeedsService;
  let stories: StoriesService;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([SpecModule, SeedsModule], { stores: ['redis'] });
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    seeds = app.get(SeedsService);
    stories = app.get(StoriesService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seeds.clean();
  });

  const story = async () => {
    const shop = await app.get<typeof Shop>(getModelToken(Shop)).create({ name: 'Apple', slug: `apple-${v4().slice(0, 6)}` });
    const s = (await stories.create(shop.id, 'inside-iphone-18')) as { id: string };
    return { shopId: shop.id, shopSlug: shop.slug, storyId: s.id };
  };

  const blocks = (text: string) => [
    { type: 'heading', level: 2, text },
    { type: 'richText', html: '<p>Titanium. <script>alert(1)</script><a href="javascript:x()">x</a><a href="https://apple.com" onclick="steal()">site</a></p>' },
  ];

  it('drafts are sanitized at write time and invisible until published; publish freezes a version with ETag + cache tags', async () => {
    const s = await story();
    const saved = await stories.saveDraft(s.shopId, s.storyId, 'en', { title: 'Inside iPhone 18', blocks: blocks('Design') });
    const html = (saved.blocks[1] as { html: string }).html;
    expect(html).not.toMatch(/script|javascript:|onclick/);
    expect(html).toContain('<a href="https://apple.com" rel="noopener">site</a>');

    await http().get(`/api/stories/${s.shopSlug}/inside-iphone-18`).expect(404);
    await stories.publish(s.shopId, s.storyId);
    const res = await http().get(`/api/stories/${s.shopSlug}/inside-iphone-18`).expect(200);
    expect(res.body).toMatchObject({ version: 1, locale: 'en', title: 'Inside iPhone 18' });
    expect(res.headers['cache-control']).toContain('stale-while-revalidate=86400');
    expect(res.headers['cache-tag']).toBe(`story:${s.storyId},shop:${s.shopId}`);
    await http().get(`/api/stories/${s.shopSlug}/inside-iphone-18`).set('If-None-Match', res.headers.etag).expect(304);
  });

  it('locale fallback chain and hreflang alternates', async () => {
    const s = await story();
    await stories.saveDraft(s.shopId, s.storyId, 'en', { title: 'Hello', blocks: blocks('EN') });
    await stories.saveDraft(s.shopId, s.storyId, 'uk', { title: 'Привіт', blocks: blocks('UK') });
    await stories.publish(s.shopId, s.storyId);
    expect((await http().get(`/api/stories/${s.shopSlug}/inside-iphone-18?locale=uk-UA`).expect(200)).body).toMatchObject({ locale: 'uk', title: 'Привіт' });
    const fr = (await http().get(`/api/stories/${s.shopSlug}/inside-iphone-18?locale=fr`).expect(200)).body;
    expect(fr.locale).toBe('en');
    expect(fr.alternates.map((a: { locale: string }) => a.locale).sort()).toEqual(['en', 'uk']);
  });

  it('scheduled publish goes live only when its job runs; a reschedule makes the old job a no-op', async () => {
    const s = await story();
    await stories.saveDraft(s.shopId, s.storyId, 'en', { title: 'Reveal', blocks: blocks('Soon') });
    const first = new Date(Date.now() + 3_600_000);
    await stories.publish(s.shopId, s.storyId, first);
    await http().get(`/api/stories/${s.shopSlug}/inside-iphone-18`).expect(404);

    const second = new Date(Date.now() + 7_200_000);
    await stories.publish(s.shopId, s.storyId, second);
    expect(await stories.publishScheduled({ storyId: s.storyId, scheduledAt: first.toISOString() })).toBeNull(); // stale job
    expect(await stories.publishScheduled({ storyId: s.storyId, scheduledAt: second.toISOString() })).toMatchObject({ status: 'PUBLISHED', version: 1 });
    await http().get(`/api/stories/${s.shopSlug}/inside-iphone-18`).expect(200);
  });

  it('publish emits an event that purges the CDN by tags; republish serves the new version (read model refreshed)', async () => {
    const s = await story();
    await stories.saveDraft(s.shopId, s.storyId, 'en', { title: 'v1', blocks: blocks('1') });
    await stories.publish(s.shopId, s.storyId);
    await http().get(`/api/stories/${s.shopSlug}/inside-iphone-18`).expect(200); // warms Redis
    await stories.saveDraft(s.shopId, s.storyId, 'en', { title: 'v2', blocks: blocks('2') });
    await stories.publish(s.shopId, s.storyId);
    expect((await http().get(`/api/stories/${s.shopSlug}/inside-iphone-18`).expect(200)).body).toMatchObject({ title: 'v2', version: 2 });

    const rows = await app.get<Sequelize>(getConnectionToken()).query<{ payload: EventEnvelope }>(`SELECT payload FROM "Outbox" WHERE "eventName" = 'story.published' AND "aggregateId" = :id`, {
      type: QueryTypes.SELECT,
      replacements: { id: s.storyId },
    });
    await app.get(StoryCacheInvalidator).project(rows.map((r) => r.payload));
    expect((app.get(CdnPurger) as LoggingPurger).purged.at(-1)).toEqual([`story:${s.storyId}`, `shop:${s.shopId}`]);
  });

  it('preview tokens show drafts with no-store; the sitemap streams published URLs with hreflang', async () => {
    const s = await story();
    await stories.saveDraft(s.shopId, s.storyId, 'en', { title: 'Draft only', blocks: blocks('d') });
    const { token } = await stories.previewToken(s.shopId, s.storyId, 'en');
    const preview = await http().get(`/api/stories/preview?token=${token}`).expect(200);
    expect(preview.body.title).toBe('Draft only');
    expect(preview.headers['cache-control']).toBe('private, no-store');
    await http().get('/api/stories/preview?token=forged').expect(404);

    await stories.publish(s.shopId, s.storyId);
    const sitemap = await http().get('/api/sitemaps/stories-0.xml').expect(200);
    expect(sitemap.text).toContain(`/en/brands/${s.shopSlug}/stories/inside-iphone-18</loc>`);
    expect(sitemap.text).toContain('hreflang="en"');
    expect((await http().get('/api/sitemaps/stories.xml').expect(200)).text).toContain('stories-0.xml');
  });
});

import { INestApplication, Module } from '@nestjs/common';
import request from 'supertest';
import { v4 } from 'uuid';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { applyClickHouseDdl } from '@app/test/utils/clickhouse-ddl';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { JobsModule } from '@app/infrastructure/jobs/jobs.module';
import { AutocompleteModule } from './autocomplete.module';
import { AutocompleteService } from './application/autocomplete.service';
import { AutocompleteBuilderJobs } from './infra/autocomplete-builder.jobs';

@Module({
  imports: [ClickHouseModule, JobsModule],
  providers: [AutocompleteBuilderJobs],
})
class BuilderSpecModule {}

/** SD-12 end to end against real ClickHouse + MinIO + Redis: logs → build job → snapshot → hot-swap → /suggest. */
describe('Autocomplete (e2e)', () => {
  let app: INestApplication;
  let clickhouse: ClickHouseService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [AutocompleteModule, BuilderSpecModule, SeedsModule],
      { stores: ['redis', 'storage'] },
    );
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    clickhouse = app.get(ClickHouseService);
    await applyClickHouseDdl(clickhouse, '030_search_queries.sql');
    await clickhouse
      .getClient()
      .command({ query: 'TRUNCATE TABLE search_queries' });
  });

  afterAll(async () => {
    await app.close();
  });

  const searches = (query: string, searchers: number, results = 10) =>
    Array.from({ length: searchers }, () => ({
      event_id: v4(),
      query,
      results,
      user_hash: v4().slice(0, 16),
      ts: new Date().toISOString().replace('Z', ''),
    }));

  it('popular, successful queries become suggestions; rare, failed and blocklisted ones do not', async () => {
    await clickhouse.getClient().insert({
      table: 'search_queries',
      format: 'JSONEachRow',
      values: [
        ...searches('iphone 17', 50),
        ...searches('iphone charger', 20),
        ...searches('iphne 17', 2), // typo: too rare
        ...searches('iphone xyz9000', 30, 0), // returns nothing
        ...searches('iphone hacked', 40), // blocklisted
      ],
    });

    expect(await app.get(AutocompleteBuilderJobs).build()).toBe(2);
    expect(await app.get(AutocompleteService).refresh()).toBe(true);

    jest
      .spyOn(app.get(ElasticsearchService), 'suggestTitles')
      .mockResolvedValue(['Apple iPhone 17 Pro 256GB']);
    const res = await request(app.getHttpServer())
      .get('/api/suggest?q=IPH')
      .expect(200);
    expect(res.body).toEqual({
      queries: ['iphone 17', 'iphone charger'],
      products: ['Apple iPhone 17 Pro 256GB'],
      partial: false,
    });
    expect(res.headers['cache-control']).toContain('s-maxage=60');
  });

  it('a slow product index degrades to query suggestions within the budget', async () => {
    jest
      .spyOn(app.get(ElasticsearchService), 'suggestTitles')
      .mockImplementation(
        (_q, _s, signal) =>
          new Promise((_, reject) =>
            signal!.addEventListener('abort', () =>
              reject(new Error('aborted')),
            ),
          ),
      );
    const started = Date.now();
    const result = await app.get(AutocompleteService).suggest('iph');
    expect(result.partial).toBe(true);
    expect(result.queries.length).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

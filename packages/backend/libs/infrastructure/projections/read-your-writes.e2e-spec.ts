import { INestApplication, Module } from '@nestjs/common';
import Redis from 'ioredis';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createValidationPipe } from '@app/common/exceptions-filter/validation-pipe';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import {
  FIXTURE_READ_CONFIG,
  FixtureReadController,
} from '@app/infrastructure/events/testing/fixture-read.controller';
import { FixtureService } from '@app/infrastructure/events/testing/fixture.service';
import { FixturesModule } from '@app/infrastructure/events/testing/fixtures.module';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ProjectionsModule } from './projections.module';
import { ProjectionRunner } from './projection-runner.service';
import { ProjectionCheckpoints } from './read-your-writes';

const TENANT_A = '00000000-0000-7000-8000-00000000000a';
const TENANT_B = '00000000-0000-7000-8000-00000000000b';
const kit = new ConsumerKit();

describe('A writer sees their own write', () => {
  beforeAll(() => kit.start());
  afterAll(() => kit.stopAll());

  /**
   * One scenario: a version-guarded consumer builds the read model of the fixture aggregate from the log, the write
   * model is the `S53Fixture` table, and real routes serve it behind the production pipe, filter and `/api` prefix.
   */
  const boot = async (
    options: { checkpoints?: ProjectionCheckpoints } = {},
  ) => {
    const s = await kit.scenario();
    const Guard = s.make('versionGuard');
    const consumerName = `fx-versionGuard-${s.id}`;
    const projections = ProjectionsModule.forProjectors([Guard]);
    @Module({
      imports: [FixturesModule, projections],
      controllers: [FixtureReadController],
      providers: [
        {
          provide: FIXTURE_READ_CONFIG,
          useValue: { consumer: consumerName, aggregateType: s.agg },
        },
      ],
    })
    class ReadRoutesModule {}
    const moduleRef = await generateTestingModule(
      [projections, ReadRoutesModule],
      {
        stores: ['redis'],
        customize: (b) => {
          return options.checkpoints
            ? b
                .overrideProvider(ProjectionCheckpoints)
                .useValue(options.checkpoints)
            : b;
        },
      },
    );
    const app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(createValidationPipe());
    const config = app.get(ApiConfigService) as MockApiConfigService;
    config.set('consumer_backoff_min_ms', 10);
    config.set('consumer_backoff_max_ms', 50);
    await app.init();
    kit.sequelize = app.get(FixtureService)['sequelize'];
    const fixtures = app.get(FixtureService);
    const get = (id: string, query = '', tenant = TENANT_A) =>
      request(app.getHttpServer())
        .get(`/api/fixtures/${id}${query}`)
        .set('x-tenant', tenant);
    const getPending = (id: string, query = '', tenant = TENANT_A) =>
      request(app.getHttpServer())
        .get(`/api/fixtures-pending/${id}${query}`)
        .set('x-tenant', tenant);
    return { s, app, fixtures, consumerName, get, getPending, config };
  };

  const applyVersion = async (
    s: Awaited<ReturnType<typeof boot>>['s'],
    id: string,
    version: number,
  ) => s.publish([s.ItemChanged.create(id, version, { name: `v${version}` })]);

  const metric = (outcome: string, reason: string) =>
    MetricsRegistry.value('read_your_writes_total', { outcome, reason }) ?? 0;

  /** Seeds the write model at `version` (the "Given the write model is at version N" of the scenarios). */
  const seedAt = async (
    fixtures: FixtureService,
    tenant: string,
    version: number,
  ) => {
    const id = await fixtures.seed(tenant, `write-v${version}`, version);
    return id;
  };

  it('S53 AS-73: with the read model already at the version the route answers 200 from it at once, with X-Read-Source read-model', async () => {
    const { s, get, fixtures, consumerName } = await boot();
    const id = await seedAt(fixtures, TENANT_A, 7);
    await applyVersion(s, id, 7);
    await waitFor(
      async () => (await kit.doc(consumerName, id))?.version === '7',
      { description: 'read model at 7' },
    );
    const before = metric('read_model', 'caught_up');

    const started = Date.now();
    const res = await get(id, '?minVersion=7').expect(200);

    expect(Date.now() - started).toBeLessThan(300);
    expect(res.headers['x-read-source']).toBe('read-model');
    expect(res.body).toMatchObject({ id, version: 7, name: 'v7' });
    expect(metric('read_model', 'caught_up')).toBe(before + 1);
  });

  it('S53 AS-74: the projection applies version 7 after 200 ms: the route answers 200 from the read model after about 200 ms, within the 500 ms budget', async () => {
    const { s, get, fixtures, consumerName } = await boot();
    const id = await seedAt(fixtures, TENANT_A, 7);
    await applyVersion(s, id, 6);
    await waitFor(
      async () => (await kit.doc(consumerName, id))?.version === '6',
      { description: 'read model at 6' },
    );
    setTimeout(() => void applyVersion(s, id, 7), 200);

    const started = Date.now();
    const res = await get(id, '?minVersion=7').expect(200);
    const took = Date.now() - started;

    expect(res.headers['x-read-source']).toBe('read-model');
    expect(res.body).toMatchObject({ version: 7, name: 'v7' });
    expect(took).toBeGreaterThanOrEqual(150);
    expect(took).toBeLessThan(900);
  });

  it('S53 AS-75: with the projection stopped at version 6 the route waits the 500 ms budget, then answers 200 from the write model (version 7) with X-Read-Source write-model', async () => {
    const { s, app, get, fixtures, consumerName } = await boot();
    const id = await seedAt(fixtures, TENANT_A, 7);
    await applyVersion(s, id, 6);
    await waitFor(
      async () => (await kit.doc(consumerName, id))?.version === '6',
      { description: 'read model at 6' },
    );
    await app.get(ProjectionRunner, { strict: false }).stopAll();
    const before = metric('fallback', 'timeout');

    const started = Date.now();
    const res = await get(id, '?minVersion=7').expect(200);
    const took = Date.now() - started;

    expect(res.headers['x-read-source']).toBe('write-model');
    expect(res.body).toMatchObject({ id, version: 7, name: 'write-v7' });
    expect(took).toBeGreaterThanOrEqual(450);
    expect(took).toBeLessThan(1_500);
    expect(metric('fallback', 'timeout')).toBe(before + 1);
  });

  it('S53 AS-76: a route that answers pending instead of falling back replies 202 with Retry-After 1 and the required version', async () => {
    const { s, app, getPending, fixtures, consumerName } = await boot();
    const id = await seedAt(fixtures, TENANT_A, 7);
    await applyVersion(s, id, 6);
    await waitFor(
      async () => (await kit.doc(consumerName, id))?.version === '6',
      { description: 'read model at 6' },
    );
    await app.get(ProjectionRunner, { strict: false }).stopAll();

    const res = await getPending(id, '?minVersion=7').expect(202);

    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toEqual({ status: 'pending', requiredVersion: 7 });
  });

  it.each([
    ['negative', '?minVersion=-1'],
    ['fractional', '?minVersion=1.5'],
    ['not a number', '?minVersion=abc'],
    ['empty', '?minVersion='],
    ['repeated', '?minVersion=1&minVersion=2'],
    ['above 2^53-1', '?minVersion=9007199254740992'],
    ['with an exponent', '?minVersion=1e3'],
    ['with a sign', '?minVersion=%2B5'],
  ])(
    'S53 AS-77: a %s minVersion answers 400 problem+json naming the parameter and does not wait',
    async (_label, query) => {
      const { get, fixtures } = await boot();
      const id = await seedAt(fixtures, TENANT_A, 1);
      const redis = new Redis({ host: 'localhost', port: 6400 });
      const gets = async () =>
        Number(
          /cmdstat_get:calls=(\d+)/.exec(
            await redis.info('commandstats'),
          )?.[1] ?? 0,
        );
      const before = await gets();

      const started = Date.now();
      const res = await get(id, query).expect(400);

      expect(Date.now() - started).toBeLessThan(300);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(JSON.stringify(res.body)).toContain('minVersion');
      expect(await gets()).toBe(before); // the checkpoint store was never consulted
      redis.disconnect();
    },
  );

  it('S53 AS-77: without minVersion nothing waits and the read model is served', async () => {
    const { s, get, fixtures, consumerName } = await boot();
    const id = await seedAt(fixtures, TENANT_A, 3);
    await applyVersion(s, id, 3);
    await waitFor(
      async () => (await kit.doc(consumerName, id))?.version === '3',
      { description: 'read model at 3' },
    );
    const started = Date.now();
    const res = await get(id).expect(200);
    expect(Date.now() - started).toBeLessThan(300);
    expect(res.headers['x-read-source']).toBe('read-model');
  });

  it('S53 AS-78: another tenant gets the same 404 as for an id that does not exist, the checkpoint store is not consulted, and it does not wait', async () => {
    const { get, fixtures } = await boot();
    const id = await seedAt(fixtures, TENANT_A, 5);
    const missing = uuidv7();
    const redis = new Redis({ host: 'localhost', port: 6400 });
    const gets = async () =>
      Number(
        /cmdstat_get:calls=(\d+)/.exec(await redis.info('commandstats'))?.[1] ??
          0,
      );
    const before = await gets();

    const started = Date.now();
    const foreign = await get(id, '?minVersion=1', TENANT_B).expect(404);
    const absent = await get(missing, '?minVersion=1', TENANT_B).expect(404);

    expect(Date.now() - started).toBeLessThan(500);
    expect(Object.keys(foreign.body).sort()).toEqual(
      Object.keys(absent.body).sort(),
    );
    expect(foreign.body.status).toBe(absent.body.status);
    expect(foreign.body.code).toBe(absent.body.code);
    expect(foreign.body.detail.replace(id, '<id>')).toBe(
      absent.body.detail.replace(missing, '<id>'),
    );
    expect(JSON.stringify(foreign.body)).not.toContain('version');
    expect(await gets()).toBe(before);
    redis.disconnect();
  });

  it('S53 AS-79: with the checkpoint store down the route answers from the write model at once, without an error, and counts the fallback', async () => {
    const sink = await TcpFaultProxy.start({ host: 'localhost', port: 6400 });
    const client = new Redis({
      host: '127.0.0.1',
      port: sink.port,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => 100,
    });
    const { get, fixtures } = await boot({
      checkpoints: new ProjectionCheckpoints(
        { client } as unknown as RedisService,
        { get: () => 86_400 } as unknown as ApiConfigService,
      ),
    });
    const id = await seedAt(fixtures, TENANT_A, 7);
    await client.connect();
    sink.mode = 'refuse';
    sink.sever();
    const before = metric('fallback', 'checkpoint_unavailable');

    const started = Date.now();
    const res = await get(id, '?minVersion=7').expect(200);

    expect(Date.now() - started).toBeLessThan(400);
    expect(res.headers['x-read-source']).toBe('write-model');
    expect(res.body).toMatchObject({ id, version: 7, name: 'write-v7' });
    expect(metric('fallback', 'checkpoint_unavailable')).toBe(before + 1);
    client.disconnect();
    await sink.close();
  }, 60_000);

  it('S53 AS-80: events with versions 7, 5, 9 leave the checkpoint at 9, recorded for stale and duplicate outcomes too, and it expires 24 h after its last update', async () => {
    const { s, app, fixtures, consumerName } = await boot();
    const id = await seedAt(fixtures, TENANT_A, 9);
    const checkpoints = app.get(ProjectionCheckpoints, { strict: false });

    await s.publish(
      [7, 5, 9].map((v) => s.ItemChanged.create(id, v, { name: `v${v}` })),
    );
    await waitFor(
      async () =>
        (await checkpoints.projectedVersion(consumerName, s.agg, id)) === 9,
      { description: 'checkpoint at 9' },
    );
    expect(await checkpoints.projectedVersion(consumerName, s.agg, id)).toBe(9);

    // a duplicate and a stale event change nothing and still refresh the entry
    const redis = app.get(RedisService, { strict: false }).client;
    const key = `ryw:${consumerName}:${s.agg}:${id}`;
    await redis.expire(key, 100);
    await s.publish([
      s.ItemChanged.create(id, 9, { name: 'again' }),
      s.ItemChanged.create(id, 1, { name: 'old' }),
    ]);
    await waitFor(async () => (await redis.ttl(key)) > 1_000, {
      description: 'entry refreshed by duplicate and stale events',
    });
    expect(await checkpoints.projectedVersion(consumerName, s.agg, id)).toBe(9);
    const ttl = await redis.ttl(key);
    expect(ttl).toBeGreaterThan(86_300);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  it('S53 AS-73: the read model of one aggregate is not confused with another: checkpoints are per aggregate', async () => {
    const { s, get, fixtures, consumerName } = await boot();
    const a = await seedAt(fixtures, TENANT_A, 7);
    const b = await seedAt(fixtures, TENANT_A, 7);
    await applyVersion(s, a, 7);
    await waitFor(
      async () => (await kit.doc(consumerName, a))?.version === '7',
      { description: 'a at 7' },
    );

    const res = await get(b, '?minVersion=7').expect(200);

    expect(res.headers['x-read-source']).toBe('write-model'); // b never reached the read model
    expect(res.body.id).toBe(b);
  });
});

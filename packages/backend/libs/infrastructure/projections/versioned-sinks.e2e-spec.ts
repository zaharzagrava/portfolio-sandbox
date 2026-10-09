import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'cassandra-driver';
import { INestApplication, Injectable, Module } from '@nestjs/common';
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import { CassandraModule } from '@app/infrastructure/cassandra/cassandra.module';
import { CassandraService } from '@app/infrastructure/cassandra/cassandra.service';
import { ClickHouseModule } from '@app/infrastructure/clickhouse/clickhouse.module';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { DynamoModule } from '@app/infrastructure/dynamo/dynamo.module';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { ElasticsearchModule } from '@app/infrastructure/elasticsearch/elasticsearch.module';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { Projector, SinkCounts } from './projector';
import { TransientError } from './errors';
import { CassandraVersionedSink } from './sinks/cassandra-versioned.sink';
import { ClickHouseSink } from './sinks/clickhouse.sink';
import { DynamoVersionedSink } from './sinks/dynamo-versioned.sink';
import { EsVersionedSink } from './sinks/es-versioned.sink';
import { RedisDocSink } from './sinks/redis-doc.sink';

const runId = uuidv7().slice(-8);

@Module({
  imports: [
    ElasticsearchModule,
    DynamoModule,
    CassandraModule,
    ClickHouseModule,
  ],
  providers: [
    RedisDocSink,
    EsVersionedSink,
    DynamoVersionedSink,
    CassandraVersionedSink,
    ClickHouseSink,
  ],
  exports: [
    RedisDocSink,
    EsVersionedSink,
    DynamoVersionedSink,
    CassandraVersionedSink,
    ClickHouseSink,
  ],
})
class SinksTestModule {}

/**
 * The Cassandra module connects with the `marketplace` keyspace, so a fresh
 * test Scylla must have it before the app starts. Applies only the keyspace
 * file (idempotent: IF NOT EXISTS); the other cql/ files are not needed here.
 */
async function ensureCassandraKeyspace(): Promise<void> {
  const client = new Client({
    contactPoints: (
      process.env.CASSANDRA_CONTACT_POINTS ?? 'localhost:9042'
    ).split(','),
    localDataCenter: process.env.CASSANDRA_LOCAL_DC ?? 'datacenter1',
  });
  try {
    await client.connect();
    const statements = readFileSync(
      join(__dirname, '../../../cql/000_keyspace.cql'),
      'utf8',
    )
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) await client.execute(statement);
  } finally {
    await client.shutdown();
  }
}

describe('Versioned sinks never make a read model older', () => {
  let app: INestApplication;
  let redis: RedisDocSink;
  let es: EsVersionedSink;
  let dynamo: DynamoVersionedSink;
  let cassandra: CassandraVersionedSink;
  let clickhouse: ClickHouseSink;
  let esClient: ElasticsearchService;
  let dynamoService: DynamoService;
  let cassandraService: CassandraService;
  let clickhouseService: ClickHouseService;
  const kit = new ConsumerKit();

  beforeAll(async () => {
    await ensureCassandraKeyspace();
    const moduleRef = await generateTestingModule([SinksTestModule], {
      stores: ['redis', 'elasticsearch', 'dynamo', 'cassandra'],
    });
    app = moduleRef.createNestApplication();
    await app.init();
    redis = app.get(RedisDocSink);
    es = app.get(EsVersionedSink);
    dynamo = app.get(DynamoVersionedSink);
    cassandra = app.get(CassandraVersionedSink);
    clickhouse = app.get(ClickHouseSink);
    esClient = app.get(ElasticsearchService);
    dynamoService = app.get(DynamoService);
    cassandraService = app.get(CassandraService);
    clickhouseService = app.get(ClickHouseService);

    // Dynamo: a table keyed by `id`, created here (test code, no migration).
    const config = app.get(ApiConfigService);
    const raw = new DynamoDBClient({
      region: 'eu-central-1',
      endpoint: config.get('dynamo_endpoint'),
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    });
    await raw
      .send(
        new DescribeTableCommand({
          TableName: dynamoService.table('S53Versioned'),
        }),
      )
      .catch(() =>
        raw.send(
          new CreateTableCommand({
            TableName: dynamoService.table('S53Versioned'),
            BillingMode: 'PAY_PER_REQUEST',
            AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
          }),
        ),
      );
    // Scylla: a table written only with version timestamps.
    await cassandraService.client.execute(
      'CREATE TABLE IF NOT EXISTS s53_versioned (id text PRIMARY KEY, version bigint, name text)',
    );
    // ClickHouse: ReplacingMergeTree by version; the window lets the server drop a repeated batch by token.
    await clickhouseService.getClient().command({
      query: `CREATE TABLE IF NOT EXISTS s53_versioned (id String, version UInt64, name String)
              ENGINE = ReplacingMergeTree(version) ORDER BY id SETTINGS non_replicated_deduplication_window = 1000`,
    });
  }, 90_000);

  afterAll(async () => {
    await esClient
      .getClient()
      .indices.delete({ index: `s53-vs-${runId}*`, ignore_unavailable: true })
      .catch(() => undefined);
    await app.close();
  });

  const key = (name: string) => `s53:vs:${runId}:${name}`;

  it('S53 AS-66: racing writers of versions 5 and 6 and then a 4 always leave version 6, and a repeated 6 is a duplicate (200 repetitions)', async () => {
    let lastCounts: SinkCounts[] = [];
    for (let i = 0; i < 200; i++) {
      const k = key(`race-${i}`);
      lastCounts = await Promise.all([
        redis.upsertMany([{ key: k, version: 5, doc: { v: 5 } }]),
        redis.upsertMany([{ key: k, version: 6, doc: { v: 6 } }]),
      ]);
      await redis.upsertMany([{ key: k, version: 4, doc: { v: 4 } }]);
      const again = await redis.upsertMany([
        { key: k, version: 6, doc: { v: 6 } },
      ]);
      expect(await redis.get(k)).toEqual({
        version: 6,
        doc: { v: 6 },
        deleted: false,
      });
      expect(again).toEqual({ applied: 0, duplicate: 1, stale: 0 });
    }
    // exactly one of the racers wrote last: 6 applied, and 5 either applied first or was stale
    const total = lastCounts.reduce(
      (sum, c) => sum + c.applied + c.duplicate + c.stale,
      0,
    );
    expect(total).toBe(2);
  });

  it('S53 AS-66: a delete keeps a versioned tombstone: a late older write is stale, a newer one brings the document back', async () => {
    const k = key('tombstone');
    await redis.upsertMany([{ key: k, version: 4, doc: { v: 4 } }]);
    expect(await redis.deleteMany([{ key: k, version: 5 }])).toEqual({
      applied: 1,
      duplicate: 0,
      stale: 0,
    });
    expect(await redis.get(k)).toEqual({
      version: 5,
      doc: null,
      deleted: true,
    });

    expect(
      await redis.upsertMany([{ key: k, version: 4, doc: { v: 'late' } }]),
    ).toEqual({ applied: 0, duplicate: 0, stale: 1 });
    expect((await redis.get(k))?.deleted).toBe(true);
    expect(await redis.deleteMany([{ key: k, version: 5 }])).toEqual({
      applied: 0,
      duplicate: 1,
      stale: 0,
    });

    expect(
      await redis.upsertMany([{ key: k, version: 6, doc: { v: 6 } }]),
    ).toEqual({ applied: 1, duplicate: 0, stale: 0 });
    expect(await redis.get(k)).toEqual({
      version: 6,
      doc: { v: 6 },
      deleted: false,
    });
  });

  it('S53 AS-67: indexing versions 3, 2, 3 keeps version 3; the stale and the equal write are skipped outcomes, not errors', async () => {
    const index = `s53-vs-${runId}-a`;
    const write = (version: number) =>
      es.bulkIfNewer(index, [
        { id: 'doc-1', version, doc: { title: `v${version}` } },
      ]);

    const first = await write(3);
    const second = await write(2);
    const third = await write(3);

    expect(first).toEqual({ applied: 1, duplicate: 0, stale: 0 });
    expect(second).toEqual({ applied: 0, duplicate: 0, stale: 1 });
    expect(third).toEqual({ applied: 0, duplicate: 1, stale: 0 });
    const got = await esClient.getClient().get({ index, id: 'doc-1' });
    expect(got._version).toBe(3);
    expect((got._source as { title: string }).title).toBe('v3');
  });

  it('S53 AS-67: a bulk of 100 mixed versions applies exactly the newest per id', async () => {
    const index = `s53-vs-${runId}-b`;
    const docs = Array.from({ length: 20 }, (_, i) => `id-${i}`).flatMap((id) =>
      [1, 2, 3, 4, 5].map((version) => ({
        id,
        version,
        doc: { title: `${id}@${version}` },
      })),
    );
    const shuffled = docs
      .map((d) => ({ d, r: Math.sin(docs.indexOf(d) * 12.9898) }))
      .sort((a, b) => a.r - b.r)
      .map((x) => x.d);

    const counts = await es.bulkIfNewer(index, shuffled);

    expect(counts.applied + counts.duplicate + counts.stale).toBe(100);
    for (let i = 0; i < 20; i++) {
      const got = await esClient.getClient().get({ index, id: `id-${i}` });
      expect(got._version).toBe(5);
      expect((got._source as { title: string }).title).toBe(`id-${i}@5`);
    }
  });

  it('S53 AS-67: a delete is versioned too: an older write after it does not bring the document back', async () => {
    const index = `s53-vs-${runId}-c`;
    await es.bulkIfNewer(index, [
      { id: 'gone', version: 4, doc: { title: 'x' } },
    ]);
    expect(await es.deleteIfNewer(index, [{ id: 'gone', version: 5 }])).toEqual(
      { applied: 1, duplicate: 0, stale: 0 },
    );
    expect(
      await es.bulkIfNewer(index, [
        { id: 'gone', version: 3, doc: { title: 'late' } },
      ]),
    ).toEqual({
      applied: 0,
      duplicate: 0,
      stale: 1,
    });
    await expect(
      esClient.getClient().get({ index, id: 'gone' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('S53 AS-68: putting versions 3, 1 and 3 leaves version 3; a stale or equal put is not applied and not an error', async () => {
    const id = `item-${runId}`;
    const item = (version: number) => ({ id, version, name: `v${version}` });

    expect(await dynamo.putIfNewer('S53Versioned', item(3))).toBe('applied');
    expect(await dynamo.putIfNewer('S53Versioned', item(1))).toBe('stale');
    expect(await dynamo.putIfNewer('S53Versioned', item(3))).toBe('duplicate');

    const stored = await dynamoService.doc.send(
      new GetCommand({
        TableName: dynamoService.table('S53Versioned'),
        Key: { id },
      }),
    );
    expect(stored.Item).toMatchObject({ version: 3, name: 'v3' });
  });

  it('S53 AS-68: putManyIfNewer reports the three outcomes together', async () => {
    const id = `many-${runId}`;
    const counts = await dynamo.putManyIfNewer(
      'S53Versioned',
      [2, 1, 2, 3].map((version) => ({ id, version, name: `v${version}` })),
      1,
    );
    expect(counts).toEqual({ applied: 2, duplicate: 1, stale: 1 });
  });

  it('S53 AS-69: writing version 3 then 1 with the version as the write timestamp leaves version 3; equal versions with different values converge by value', async () => {
    const id = `scylla-${runId}`;
    const write = (version: number, name: string) => ({
      query: 'INSERT INTO s53_versioned (id, version, name) VALUES (?, ?, ?)',
      params: [id, version, name],
      version,
      probe: {
        query: 'SELECT writetime(name) AS wt FROM s53_versioned WHERE id = ?',
        params: [id],
      },
    });
    const read = async (rowId: string) =>
      (
        await cassandraService.client.execute(
          'SELECT version, name FROM s53_versioned WHERE id = ?',
          [rowId],
          { prepare: true },
        )
      ).rows[0];

    expect(await cassandra.writeAll([write(3, 'three')])).toEqual({
      applied: 1,
      duplicate: 0,
      stale: 0,
    });
    expect(await cassandra.writeAll([write(1, 'one')])).toEqual({
      applied: 0,
      duplicate: 0,
      stale: 1,
    });
    expect(await cassandra.writeAll([write(3, 'three')])).toEqual({
      applied: 0,
      duplicate: 1,
      stale: 0,
    });
    expect(Number((await read(id)).get('version'))).toBe(3);
    expect((await read(id)).get('name')).toBe('three');

    // tie rule: the same version with two values, in either arrival order, ends on the greater value
    const [a, b] = [`tie-a-${runId}`, `tie-b-${runId}`];
    const tie = (rowId: string, name: string) => ({
      query: 'INSERT INTO s53_versioned (id, version, name) VALUES (?, ?, ?)',
      params: [rowId, 7, name],
      version: 7,
    });
    await cassandra.writeAll([tie(a, 'alpha')]);
    await cassandra.writeAll([tie(a, 'omega')]);
    await cassandra.writeAll([tie(b, 'omega')]);
    await cassandra.writeAll([tie(b, 'alpha')]);
    expect((await read(a)).get('name')).toBe('omega');
    expect((await read(b)).get('name')).toBe('omega');
  });

  it('S53 AS-70: the same batch inserted twice adds no rows with a dedupe token, and an older version after a newer one collapses at FINAL', async () => {
    const id = (n: number) => `ch-${runId}-${n}`;
    const batch = [1, 2, 3].map((n) => ({
      id: id(n),
      version: 1,
      name: `v1-${n}`,
    }));
    const count = async () =>
      Number(
        (
          (await (
            await clickhouseService.getClient().query({
              query: `SELECT count() AS n FROM s53_versioned WHERE id LIKE 'ch-${runId}-%'`,
              format: 'JSONEachRow',
            })
          ).json()) as { n: string }[]
        )[0].n,
      );

    await clickhouse.insert('s53_versioned', batch, {
      dedupeToken: `batch-${runId}`,
    });
    await clickhouse.insert('s53_versioned', batch, {
      dedupeToken: `batch-${runId}`,
    });
    expect(await count()).toBe(3);

    await clickhouse.insert(
      's53_versioned',
      [{ id: id(1), version: 2, name: 'v2' }],
      { dedupeToken: `v2-${runId}` },
    );
    await clickhouse.insert(
      's53_versioned',
      [{ id: id(1), version: 1, name: 'late v1' }],
      { dedupeToken: `late-${runId}` },
    );
    const final = (await (
      await clickhouseService.getClient().query({
        query: `SELECT version, name FROM s53_versioned FINAL WHERE id = '${id(1)}'`,
        format: 'JSONEachRow',
      })
    ).json()) as { version: string; name: string }[];
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ version: '2', name: 'v2' });
  });

  it('S53 AS-70: a ClickHouse outage surfaces as a TransientError, not as a bad message', async () => {
    const broken = new ClickHouseSink({
      getClient: () => ({
        insert: async () => {
          throw Object.assign(
            new Error('connect ECONNREFUSED 127.0.0.1:8123'),
            { code: 'ECONNREFUSED' },
          );
        },
      }),
    } as unknown as ClickHouseService);
    await expect(
      broken.insert('s53_versioned', [{ id: 'x', version: 1, name: 'x' }]),
    ).rejects.toBeInstanceOf(TransientError);
  });

  describe('S53 AS-72: a batch that fails partway is retried as a whole and converges', () => {
    it('S53 AS-72: a sink that fails on the 4th write once leaves the same state as applying all ten once, and no duplicate effect', async () => {
      await kit.start();
      const s = await kit.scenario();
      const events = Array.from({ length: 10 }, (_, i) =>
        s.ItemChanged.create(uuidv7(), i + 1, { name: `n${i}` }),
      );
      let failed = false;

      @Injectable()
      class PartialFailureConsumer implements Projector {
        readonly name = `fx-partial-${s.id}`;
        readonly topics = [s.topic];
        readonly idempotency = 'versionGuard' as const;
        readonly handles = [{ event: s.ItemChanged }];
        constructor(private readonly sink: RedisDocSink) {}
        async project(batch: EventEnvelope[]): Promise<SinkCounts> {
          const total: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
          for (const [i, e] of batch.entries()) {
            if (i === 3 && !failed) {
              failed = true;
              throw new TransientError('the sink failed on the 4th write');
            }
            const c = await this.sink.upsertMany([
              {
                key: `s53:partial:${s.id}:${e.aggregateId}`,
                version: e.aggregateVersion,
                doc: e.payload,
              },
            ]);
            total.applied += c.applied;
            total.duplicate += c.duplicate;
            total.stale += c.stale;
          }
          return total;
        }
      }
      await s.publish(events); // one batch of ten, published before the consumer starts
      await s.boot([PartialFailureConsumer]);

      await waitFor(
        async () =>
          (await redis.get(`s53:partial:${s.id}:${events[9].aggregateId}`)) !==
          null,
        { description: 'all ten applied after the retry', timeoutMs: 30_000 },
      );
      for (const e of events)
        expect(await redis.get(`s53:partial:${s.id}:${e.aggregateId}`)).toEqual(
          {
            version: e.aggregateVersion,
            doc: e.payload,
            deleted: false,
          },
        );
      expect(failed).toBe(true);
      expect(
        MetricsRegistry.value('consumer_paused_total', {
          consumer: `fx-partial-${s.id}`,
          reason: 'transient',
        }),
      ).toBeGreaterThanOrEqual(1);
      // the first three writes of the failed attempt come back as duplicates, the other seven are applied
      expect(
        MetricsRegistry.value('consumer_events_total', {
          consumer: `fx-partial-${s.id}`,
          outcome: 'applied',
        }),
      ).toBe(7);
      expect(
        MetricsRegistry.value('consumer_events_total', {
          consumer: `fx-partial-${s.id}`,
          outcome: 'duplicate',
        }),
      ).toBe(3);
      await kit.stopAll();
    }, 90_000);
  });
});

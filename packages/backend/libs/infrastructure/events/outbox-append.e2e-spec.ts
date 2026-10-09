import { INestApplication, Global, Module } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { Client } from 'pg';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { NoActiveTransactionError } from '@app/infrastructure/outbox/outbox-errors';
import { appendWithExecutor } from '@app/infrastructure/outbox/append-with-executor';
import { defineEvent, useEventClock } from './define-event';
import { EventTooLargeError, InvalidEventPayloadError } from './event-errors';
import { UnregisteredAggregateTypeError } from './topic-errors';
import { TopicRegistry } from './topic-registry';
import { eventEnvelopeSchema } from './event-envelope';
import { FixturesModule } from './testing/fixtures.module';
import {
  FixtureService,
  FixtureConflictError,
} from './testing/fixture.service';
import {
  FixtureItemChanged,
  FixtureReindexCompleted,
} from './testing/fixture-events';
import { installTestTracing } from './testing/test-tracing';

const clock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));
const TENANT = '00000000-0000-7000-8000-0000000000aa';

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: clock }],
  exports: [CLOCK],
})
class TestClockModule {}

interface OutboxRow {
  id: string;
  kind: string;
  status: string;
  topic: string;
  aggregateId: string;
  aggregateType: string | null;
  type: string | null;
  eventName: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  nextAttemptAt: Date;
}

describe('Events appended to the outbox in the caller transaction', () => {
  let app: INestApplication;
  let sequelize: Sequelize;
  let fixtures: FixtureService;
  let outbox: OutboxService;
  let topics: TopicRegistry;
  const tracing = installTestTracing();

  beforeAll(async () => {
    const moduleRef = await generateTestingModule(
      [TestClockModule, FixturesModule],
      { customize: (b) => b.overrideProvider(CLOCK).useValue(clock) },
    );
    app = moduleRef.createNestApplication();
    await app.init();
    useEventClock(clock);
    sequelize = app.get(Sequelize);
    fixtures = app.get(FixtureService);
    outbox = app.get(OutboxService);
    topics = app.get(TopicRegistry);
  });

  afterAll(async () => {
    await app.close();
    await tracing.shutdown();
  });

  beforeEach(async () => {
    await sequelize.query(
      `DELETE FROM "Outbox" WHERE "topic" LIKE 'fixtures.%' OR "topic" LIKE 'tappend%'`,
    );
  });

  const rowsFor = async (aggregateId: string): Promise<OutboxRow[]> => {
    const [rows] = await sequelize.query(
      `SELECT * FROM "Outbox" WHERE "aggregateId" = $1 ORDER BY "id"`,
      { bind: [aggregateId] },
    );
    return rows as OutboxRow[];
  };

  it('S53 AS-01: a committed change leaves one pending row with the full envelope', async () => {
    const id = await fixtures.seed(TENANT, 'a', 3);

    const traceparent = await tracing.tracer.startActiveSpan(
      'test',
      async (span) => {
        const version = await fixtures.rename(id, 3, 'renamed');
        expect(version).toBe(4);
        span.end();
        return `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`;
      },
    );

    expect(await fixtures.get(id)).toMatchObject({
      name: 'renamed',
      version: 4,
    });
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'event',
      status: 'pending',
      topic: 'fixtures.events',
      aggregateId: id,
      aggregateType: 'fixtures',
      type: 'fixtures.item_changed',
      eventName: 'fixtures.item_changed',
      attempts: 0,
    });
    expect(new Date(rows[0].nextAttemptAt).toISOString()).toBe(
      '2026-10-09T10:00:00.000Z',
    );
    const envelope = eventEnvelopeSchema.parse(rows[0].payload);
    expect(envelope).toMatchObject({
      type: 'fixtures.item_changed',
      version: 1,
      aggregateType: 'fixtures',
      aggregateId: id,
      aggregateVersion: 4,
      occurredAt: '2026-10-09T10:00:00.000Z',
      traceparent,
      payload: { name: 'renamed' },
    });
  });

  it('S53 AS-02: a rolled-back change leaves no row and the old state', async () => {
    const id = await fixtures.seed(TENANT, 'a', 3);

    await expect(
      fixtures.rename(id, 3, 'renamed', { failAfterAppend: true }),
    ).rejects.toThrow('boom after append');

    expect(await fixtures.get(id)).toMatchObject({ name: 'a', version: 3 });
    expect(await rowsFor(id)).toHaveLength(0);
  });

  it('S53 AS-03: append without a transaction is refused and names the event type; standalone writes one row', async () => {
    const id = uuidv7();
    const event = FixtureReindexCompleted.create(id, 0, { count: 5 });

    await expect(fixtures.appendWithoutTransaction([event])).rejects.toThrow(
      NoActiveTransactionError,
    );
    await expect(fixtures.appendWithoutTransaction([event])).rejects.toThrow(
      /fixtures\.reindex_completed/,
    );
    expect(await rowsFor(id)).toHaveLength(0);

    await outbox.appendStandalone(event);

    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      topic: 'fixtures.events',
      type: 'fixtures.reindex_completed',
    });
    expect(rows[0].payload).toMatchObject({ eventId: event.eventId });
  });

  it('S53 AS-03: appendStandalone with several events writes all or none', async () => {
    const id = uuidv7();
    const ok = FixtureReindexCompleted.create(id, 0, { count: 1 });
    const unregistered = {
      ...ok,
      eventId: uuidv7(),
      aggregateType: 'tappendghost',
    };

    await expect(outbox.appendStandalone([ok, unregistered])).rejects.toThrow(
      UnregisteredAggregateTypeError,
    );
    expect(await rowsFor(id)).toHaveLength(0);
  });

  it('S53 AS-04: an invalid payload throws InvalidEventPayloadError naming the path, appends nothing and rolls the change back', async () => {
    const id = await fixtures.seed(TENANT, 'a', 3);

    const attempt = fixtures.changeWith(id, 3, 'renamed', (version) =>
      FixtureItemChanged.create(id, version, { name: 42 } as never),
    );

    await expect(attempt).rejects.toThrow(InvalidEventPayloadError);
    await expect(attempt).rejects.toThrow(/name/);
    await expect(attempt).rejects.not.toThrow(/42/);
    expect(await rowsFor(id)).toHaveLength(0);
    expect(await fixtures.get(id)).toMatchObject({ name: 'a', version: 3 });
  });

  it('S53 AS-05: three events for two aggregates are written by one statement, in append order', async () => {
    const a = uuidv7();
    const b = uuidv7();
    const events = [
      FixtureItemChanged.create(a, 1, { name: 'a1' }),
      FixtureItemChanged.create(b, 1, { name: 'b1' }),
      FixtureItemChanged.create(a, 2, { name: 'a2' }),
    ];
    const statements: string[] = [];
    const previous = sequelize.options.logging;
    sequelize.options.logging = (sql: string) => statements.push(sql);
    try {
      await fixtures.appendInTransaction(events);
    } finally {
      sequelize.options.logging = previous;
    }

    expect(
      statements.filter((s) => /INSERT INTO "Outbox"/.test(s)),
    ).toHaveLength(1);
    const [all] = await sequelize.query(
      `SELECT "aggregateId", "payload"->>'eventId' AS "eventId" FROM "Outbox" WHERE "aggregateId" = ANY($1) ORDER BY "id"`,
      { bind: [[a, b]] },
    );
    expect((all as { eventId: string }[]).map((r) => r.eventId)).toEqual(
      events.map((e) => e.eventId),
    );
  });

  it('S53 AS-06: two concurrent conditional updates produce exactly one row', async () => {
    const id = await fixtures.seed(TENANT, 'a', 3);

    const results = await Promise.allSettled([
      fixtures.rename(id, 3, 'first'),
      fixtures.rename(id, 3, 'second'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(FixtureConflictError);
    const rows = await rowsFor(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ aggregateVersion: 4 });
    expect((await fixtures.get(id))?.version).toBe(4);
  });

  describe('S53 AS-07: size limit', () => {
    const Big = defineEvent(
      'tappendbig.blob',
      'tappendbig',
      1,
      z.object({ blob: z.string() }),
    );

    it('S53 AS-07: an envelope above 256 KiB cannot be created and nothing is appended', async () => {
      const id = uuidv7();
      expect(() =>
        Big.create(id, 0, { blob: 'x'.repeat(256 * 1024 + 1) }),
      ).toThrow(EventTooLargeError);
      expect(await rowsFor(id)).toHaveLength(0);
    });

    it('S53 AS-07: a hand-built oversized envelope is refused by append too, naming limit and size', async () => {
      topics.register({
        aggregateType: 'tappendbig',
        retention: 'full-history',
      });
      const id = uuidv7();
      const small = Big.create(id, 0, { blob: 'x' });
      const huge = { ...small, payload: { blob: 'x'.repeat(256 * 1024 + 1) } };

      await expect(outbox.appendStandalone(huge)).rejects.toThrow(
        EventTooLargeError,
      );
      await expect(outbox.appendStandalone(huge)).rejects.toThrow(/262144/);
      expect(await rowsFor(id)).toHaveLength(0);
    });
  });

  describe('S53 AS-08: writers without the framework', () => {
    let client: Client;
    beforeAll(async () => {
      client = new Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        user: process.env.DB_USERNAME,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
      });
      await client.connect();
    });
    afterAll(async () => {
      await client.end();
    });

    const insert = (over: Record<string, unknown> = {}) => {
      const eventId = uuidv7();
      const row = {
        kind: 'event',
        topic: 'fixtures.events',
        aggregateId: uuidv7(),
        aggregateType: 'fixtures',
        type: 'fixtures.item_changed',
        payload: { eventId },
        status: 'pending',
        ...over,
      };
      return client.query(
        `INSERT INTO "Outbox" ("id", "kind", "topic", "aggregateId", "aggregateType", "type", "payload", "status", "attempts", "nextAttemptAt", "createdAt")
         VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, $7, 0, now(), now())`,
        [
          row.kind,
          row.topic,
          row.aggregateId,
          row.aggregateType,
          row.type,
          row.payload,
          row.status,
        ],
      );
    };

    it('S53 AS-08: appendWithExecutor over a plain connection writes a conforming pending row', async () => {
      const id = uuidv7();
      const event = FixtureItemChanged.create(id, 1, { name: 'lambda' });

      await client.query('BEGIN');
      await appendWithExecutor(client, event);
      await client.query('COMMIT');

      const rows = await rowsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: 'event',
        status: 'pending',
        topic: 'fixtures.events',
        aggregateId: id,
        type: 'fixtures.item_changed',
      });
      expect(eventEnvelopeSchema.parse(rows[0].payload).eventId).toBe(
        event.eventId,
      );
    });

    it('S53 AS-08: appendWithExecutor inside a rolled-back transaction leaves nothing', async () => {
      const id = uuidv7();
      await client.query('BEGIN');
      await appendWithExecutor(
        client,
        FixtureItemChanged.create(id, 1, { name: 'x' }),
      );
      await client.query('ROLLBACK');
      expect(await rowsFor(id)).toHaveLength(0);
    });

    it('S53 AS-08: a raw insert that follows the row contract is accepted', async () => {
      const aggregateId = uuidv7();
      await insert({ aggregateId });
      expect(await rowsFor(aggregateId)).toHaveLength(1);
    });

    it.each([
      ['null aggregateId', { aggregateId: null }],
      ['empty aggregateId', { aggregateId: '' }],
      ['unknown kind', { kind: 'command' }],
      ['unknown status', { status: 'done' }],
      ['payload without eventId', { payload: { name: 'no id' } }],
      ['event without aggregateType', { aggregateType: null }],
      ['event with a malformed type', { type: 'Not Dotted' }],
    ])('S53 AS-08: the database rejects %s', async (_label, over) => {
      await expect(insert(over)).rejects.toThrow(
        /violates check constraint|not-null/,
      );
    });
  });

  describe('S53 AS-11: topic registry', () => {
    const Ghost = defineEvent(
      'tappendghost.thing',
      'tappendghost',
      1,
      z.object({ a: z.string() }),
    );
    const Regd = defineEvent(
      'tappendregd.thing',
      'tappendregd',
      1,
      z.object({ a: z.string() }),
    );

    it('S53 AS-11: an unregistered aggregate type is rejected and nothing is written', async () => {
      const id = uuidv7();
      await expect(
        outbox.appendStandalone(Ghost.create(id, 0, { a: 'x' })),
      ).rejects.toThrow(UnregisteredAggregateTypeError);
      expect(await rowsFor(id)).toHaveLength(0);
    });

    it('S53 AS-11: a registered aggregate type goes to <aggregateType>.events', async () => {
      topics.register({
        aggregateType: 'tappendregd',
        retention: 'full-history',
      });
      const id = uuidv7();
      await outbox.appendStandalone(Regd.create(id, 0, { a: 'x' }));
      const rows = await rowsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].topic).toBe('tappendregd.events');
    });
  });

  it('S53 AS-05: appending an empty list writes nothing and needs no transaction', async () => {
    await expect(outbox.append([])).resolves.toBeUndefined();
  });
});

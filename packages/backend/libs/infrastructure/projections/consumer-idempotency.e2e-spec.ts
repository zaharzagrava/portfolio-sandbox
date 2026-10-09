import { INestApplication, Global, Module, Type } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { waitFor } from '@app/test/utils/async-helpers';
import {
  createTopics,
  deleteTopicsMatching,
  testKafka,
} from '@app/test/utils/kafka-test';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import {
  defineEvent,
  useEventClock,
} from '@app/infrastructure/events/define-event';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  KAFKA_CLIENT_OVERRIDES,
  KAFKA_CONSUMER_OVERRIDES,
} from '@app/infrastructure/kafka/kafka-client.options';
import {
  fixtureConsumer,
  ConsumerProbe,
} from '@app/infrastructure/events/testing/fixture-consumers';
import { ProjectionsModule } from './projections.module';
import { Projector } from './projector';
import { ProjectionCheckpoints } from './read-your-writes';

const clock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: clock }],
  exports: [CLOCK],
})
class TestClockModule {}

type Consumer = Projector & { probe: ConsumerProbe };

describe('Consumers apply an event once, whatever the delivery', () => {
  let proxy: TcpFaultProxy;
  const apps: INestApplication[] = [];
  let sequelize: Sequelize;

  beforeAll(async () => {
    proxy = await TcpFaultProxy.start({ host: 'localhost', port: 9192 });
  });

  const scenarioIds: string[] = [];

  afterAll(async () => {
    for (const app of apps) await app.close();
    await proxy.close();
    if (scenarioIds.length > 0)
      await deleteTopicsMatching(new RegExp(scenarioIds.join('|')));
  });

  /** One isolated scenario: its own aggregate type, topic, event definitions and consumer groups. */
  const scenario = async (partitions = 1) => {
    const id = uuidv7().slice(-8);
    scenarioIds.push(id);
    const agg = `idem${id}`;
    const ItemChanged = defineEvent(
      `${agg}.item_changed`,
      agg,
      1,
      z.object({ name: z.string() }),
      { carries: 'state' },
    );
    const ItemDeleted = defineEvent(
      `${agg}.item_deleted`,
      agg,
      1,
      z.object({ name: z.string() }),
      { carries: 'state' },
    );
    const topic = `${agg}.events`;
    await createTopics([{ topic, numPartitions: partitions }]);
    const kafka = testKafka();
    const producer = kafka.producer();
    await producer.connect();
    const publish = async (
      events: EventEnvelope[],
      options: { partition?: number; key?: (e: EventEnvelope) => string } = {},
    ) => {
      await producer.send({
        topic,
        messages: events.map((e) => ({
          key: options.key ? options.key(e) : e.aggregateId,
          value: JSON.stringify(e),
          ...(options.partition !== undefined && {
            partition: options.partition,
          }),
        })),
      });
    };
    const make = (
      kind: 'inbox' | 'versionGuard' | 'natural',
      suffix: string = kind,
      extra: Partial<Parameters<typeof fixtureConsumer>[0]> = {},
    ) =>
      fixtureConsumer({
        name: `fx-${suffix}-${id}`,
        topics: [topic],
        kind,
        handles: [{ event: ItemChanged }, { event: ItemDeleted }],
        deleteType: ItemDeleted.type,
        ...extra,
      });
    const boot = async (
      consumers: Type<Consumer>[],
      options: { consumerProxy?: boolean; sessionTimeoutMs?: number } = {},
    ) => {
      const moduleRef = await generateTestingModule(
        [
          TestClockModule,
          ProjectionsModule.forProjectors(consumers as Type<Projector>[]),
        ],
        {
          stores: ['redis'],
          customize: (b) => {
            let builder = b.overrideProvider(CLOCK).useValue(clock);
            if (options.consumerProxy)
              builder = builder
                .overrideProvider(KAFKA_CONSUMER_OVERRIDES)
                .useValue({ socketFactory: proxy.kafkaSocketFactory() });
            return builder;
          },
        },
      );
      const app = moduleRef.createNestApplication();
      const config = app.get(ApiConfigService) as MockApiConfigService;
      config.set('consumer_backoff_min_ms', 10);
      config.set('consumer_backoff_max_ms', 50);
      if (options.sessionTimeoutMs)
        config.set('consumer_session_timeout_ms', options.sessionTimeoutMs);
      await app.init();
      apps.push(app);
      useEventClock(clock);
      sequelize = app.get(Sequelize);
      return app;
    };
    const stop = async (app: INestApplication) => {
      apps.splice(apps.indexOf(app), 1);
      await app.close();
    };
    return {
      id,
      agg,
      topic,
      ItemChanged,
      ItemDeleted,
      publish,
      make,
      boot,
      stop,
      kafka,
    };
  };

  const count = async (sql: string, ...bind: unknown[]) =>
    Number(((await sequelize.query(sql, { bind }))[0] as { n: string }[])[0].n);
  const effects = (consumer: string) =>
    count(
      `SELECT count(*) AS n FROM "S53FixtureEffect" WHERE "consumer" = $1`,
      consumer,
    );
  const inboxRecords = (consumer: string) =>
    count(
      `SELECT count(*) AS n FROM "ProcessedWebhookEvent" WHERE "provider" = $1`,
      consumer,
    );
  const doc = async (consumer: string, aggregateId: string) =>
    (
      (
        await sequelize.query(
          `SELECT "version", "name", "deleted" FROM "S53FixtureDoc" WHERE "consumer" = $1 AND "aggregateId" = $2`,
          { bind: [consumer, aggregateId] },
        )
      )[0] as { version: string; name: string; deleted: boolean }[]
    )[0];
  const metric = (consumer: string, outcome: string) =>
    MetricsRegistry.value('consumer_events_total', { consumer, outcome }) ?? 0;
  const committed = async (
    kafka: ReturnType<typeof testKafka>,
    group: string,
    topic: string,
  ): Promise<number[]> => {
    const admin = kafka.admin();
    await admin.connect();
    try {
      const offsets = await admin.fetchOffsets({
        groupId: group,
        topics: [topic],
      });
      return offsets[0].partitions.map((p) => Number(p.offset));
    } finally {
      await admin.disconnect();
    }
  };

  /** Waits until the group is stable with `members` members, each holding at least one partition. */
  const awaitMembers = (
    kafka: ReturnType<typeof testKafka>,
    group: string,
    members: number,
  ) =>
    waitFor(
      async () => {
        const admin = kafka.admin();
        await admin.connect();
        try {
          const [description] = (await admin.describeGroups([group])).groups;
          return (
            description.state === 'Stable' &&
            description.members.length === members
          );
        } finally {
          await admin.disconnect();
        }
      },
      { description: `${members} members in ${group}`, timeoutMs: 60_000 },
    );

  it('S53 AS-28: an inbox consumer given the same event twice leaves one effect, one inbox record, and counts the second as duplicate', async () => {
    const s = await scenario();
    const Inbox = s.make('inbox');
    const app = await s.boot([Inbox]);
    const consumer = app.get(Inbox);
    const event = s.ItemChanged.create(uuidv7(), 1, { name: 'x' });

    await s.publish([event, event]);

    await waitFor(
      async () =>
        (await inboxRecords(consumer.name)) === 1 &&
        metric(consumer.name, 'duplicate') === 1,
      {
        description: 'duplicate counted',
      },
    );
    expect(await effects(consumer.name)).toBe(1);
    expect(await inboxRecords(consumer.name)).toBe(1);
    expect(metric(consumer.name, 'applied')).toBe(1);
  });

  it('S53 AS-29: a version-guarded consumer applies the first of two copies and of an equal-version event with another eventId, once', async () => {
    const s = await scenario();
    const Guard = s.make('versionGuard');
    const app = await s.boot([Guard]);
    const consumer = app.get(Guard);
    const aggregateId = uuidv7();
    const first = s.ItemChanged.create(aggregateId, 4, { name: 'same' });
    const sameVersionOtherId = s.ItemChanged.create(aggregateId, 4, {
      name: 'same',
    });

    await s.publish([first, first, sameVersionOtherId]);

    await waitFor(async () => metric(consumer.name, 'duplicate') === 2, {
      description: '2 duplicates',
    });
    expect(await doc(consumer.name, aggregateId)).toMatchObject({
      version: '4',
      name: 'same',
      deleted: false,
    });
    expect(metric(consumer.name, 'applied')).toBe(1);
  });

  it('S53 AS-30: a natural consumer given an event twice leaves one row', async () => {
    const s = await scenario();
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const event = s.ItemChanged.create(uuidv7(), 1, { name: 'natural' });

    await s.publish([event, event]);

    await waitFor(
      async () =>
        (consumer as Consumer).probe.calls.length > 0 &&
        metric(consumer.name, 'applied') === 2,
      {
        description: 'both deliveries handled',
      },
    );
    expect(
      await count(
        `SELECT count(*) AS n FROM "S53FixtureNatural" WHERE "consumer" = $1`,
        consumer.name,
      ),
    ).toBe(1);
  });

  it('S53 AS-31: an inbox handler that throws after its effect leaves neither effect nor record; the retry leaves both once', async () => {
    const s = await scenario();
    const Inbox = s.make('inbox');
    const app = await s.boot([Inbox]);
    const consumer = app.get(Inbox);
    const event = s.ItemChanged.create(uuidv7(), 1, { name: 'x' });
    consumer.probe.throwAfter.set(event.eventId, {
      times: 1,
      error: () => new Error('after the effect'),
    });

    await s.publish([event]);

    await waitFor(
      async () =>
        consumer.probe.invocationsOf(event.eventId) >= 2 &&
        (await effects(consumer.name)) === 1,
      {
        description: 'retry applied',
      },
    );
    expect(await effects(consumer.name)).toBe(1);
    expect(await inboxRecords(consumer.name)).toBe(1);
    expect(consumer.probe.invocationsOf(event.eventId)).toBe(2);
  });

  it('S53 AS-32: two instances handling the same eventId at the same moment leave one effect and one record, the loser counts a duplicate', async () => {
    const s = await scenario(2);
    const Inbox = s.make('inbox');
    const instance1 = await s.boot([Inbox]);
    const instance2 = await s.boot([Inbox]);
    const consumer = instance1.get(Inbox);
    const event = s.ItemChanged.create(uuidv7(), 1, { name: 'x' });
    // hold both handlers at the door (bounded: a rebalance must never wait on it) so they run at the same moment
    let arrived = 0;
    let release!: () => void;
    const door = new Promise<void>((resolve) => (release = resolve));
    for (const c of [instance1.get(Inbox), instance2.get(Inbox)])
      c.probe.gate = async () => {
        if (++arrived === 2) release();
        await Promise.race([
          door,
          new Promise((resolve) => setTimeout(resolve, 1_500)),
        ]);
      };
    await awaitMembers(s.kafka, consumer.name, 2);
    // the same envelope on both partitions, so each instance owns one of the two copies
    await Promise.all([
      s.publish([event], { partition: 0 }),
      s.publish([event], { partition: 1 }),
    ]);

    await waitFor(
      async () =>
        (await inboxRecords(consumer.name)) === 1 &&
        metric(consumer.name, 'duplicate') === 1,
      {
        description: 'one effect, one duplicate',
        timeoutMs: 30_000,
      },
    );
    expect(await effects(consumer.name)).toBe(1);
    expect(await inboxRecords(consumer.name)).toBe(1);
    await s.stop(instance2);
  });

  it('S53 AS-33: events with aggregateVersion 3, 1, 2 leave the read model at 3, count two stale, and the checkpoint is 3', async () => {
    const s = await scenario();
    const Guard = s.make('versionGuard');
    const app = await s.boot([Guard]);
    const consumer = app.get(Guard);
    const aggregateId = uuidv7();

    await s.publish(
      [3, 1, 2].map((v) =>
        s.ItemChanged.create(aggregateId, v, { name: `v${v}` }),
      ),
    );

    await waitFor(async () => metric(consumer.name, 'stale') === 2, {
      description: '2 stale',
    });
    expect(await doc(consumer.name, aggregateId)).toMatchObject({
      version: '3',
      name: 'v3',
    });
    expect(metric(consumer.name, 'applied')).toBe(1);
    const checkpoints = app.get(ProjectionCheckpoints);
    expect(
      await checkpoints.projectedVersion(consumer.name, s.agg, aggregateId),
    ).toBe(3);
  });

  it('S53 AS-34: an equal version is a duplicate: nothing is written and the checkpoint stays', async () => {
    const s = await scenario();
    const Guard = s.make('versionGuard');
    const app = await s.boot([Guard]);
    const consumer = app.get(Guard);
    const aggregateId = uuidv7();
    await s.publish([s.ItemChanged.create(aggregateId, 5, { name: 'five' })]);
    await waitFor(async () => metric(consumer.name, 'applied') === 1, {
      description: 'v5 applied',
    });

    await s.publish([
      s.ItemChanged.create(aggregateId, 5, { name: 'other five' }),
    ]);

    await waitFor(async () => metric(consumer.name, 'duplicate') === 1, {
      description: 'duplicate',
    });
    expect(await doc(consumer.name, aggregateId)).toMatchObject({
      version: '5',
      name: 'five',
    });
    expect(
      await app
        .get(ProjectionCheckpoints)
        .projectedVersion(consumer.name, s.agg, aggregateId),
    ).toBe(5);
  });

  it('S53 AS-35: 200 events over 10 aggregates in one partition never overlap per aggregate and follow log order', async () => {
    const s = await scenario(1);
    const Natural = s.make('natural', 'seq');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const aggregates = Array.from({ length: 10 }, () => uuidv7());
    const versions = new Map<string, number>();
    const events = Array.from({ length: 200 }, (_, i) => {
      const aggregateId = aggregates[i % 10];
      const v = (versions.get(aggregateId) ?? 0) + 1;
      versions.set(aggregateId, v);
      return s.ItemChanged.create(aggregateId, v, { name: `e${i}` });
    });

    await s.publish(events);

    await waitFor(
      async () => consumer.probe.calls.flatMap((c) => c.events).length >= 200,
      { description: '200 handled' },
    );
    const perAggregate = new Map<string, number[]>();
    for (const call of consumer.probe.calls)
      for (const e of call.events)
        perAggregate.set(e.aggregateId, [
          ...(perAggregate.get(e.aggregateId) ?? []),
          e.aggregateVersion,
        ]);
    for (const [, seen] of perAggregate)
      expect(seen).toEqual([...seen].sort((a, b) => a - b));
    // no two calls overlap in time at all within a partition
    const sorted = [...consumer.probe.calls].sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    for (let i = 1; i < sorted.length; i++)
      expect(sorted[i].startedAt).toBeGreaterThanOrEqual(
        sorted[i - 1].endedAt!,
      );
  });

  it('S53 AS-36: a handler that throws on the first delivery is retried, applied once, and the offset passes the event only after success', async () => {
    const s = await scenario();
    const Inbox = s.make('inbox');
    const app = await s.boot([Inbox]);
    const consumer = app.get(Inbox);
    const event = s.ItemChanged.create(uuidv7(), 1, { name: 'x' });
    consumer.probe.throwBefore.set(event.eventId, {
      times: 1,
      error: () => new Error('first delivery fails'),
    });
    let releaseSecond!: () => void;
    const second = new Promise<void>((resolve) => (releaseSecond = resolve));
    let calls = 0;
    consumer.probe.gate = async () => {
      if (++calls === 2) await second; // hold the retry open to look at the committed offset
    };

    await s.publish([event]);

    await waitFor(async () => calls === 2, { description: 'retry started' });
    expect(
      (await committed(s.kafka, consumer.name, s.topic))[0],
    ).toBeLessThanOrEqual(0);
    releaseSecond();
    await waitFor(async () => (await effects(consumer.name)) === 1, {
      description: 'applied',
    });
    await waitFor(
      async () => (await committed(s.kafka, consumer.name, s.topic))[0] === 1,
      { description: 'offset passed' },
    );
    expect(await inboxRecords(consumer.name)).toBe(1);
  });

  it('S53 AS-37: a connection cut while the handler runs leaves the offset before the batch; the batch is redelivered and applied once; a cut after the effect redelivers as duplicate', async () => {
    const s = await scenario();
    const Inbox = s.make('inbox');
    const app = await s.boot([Inbox], {
      consumerProxy: true,
      sessionTimeoutMs: 6_000,
    });
    const consumer = app.get(Inbox);
    const first = s.ItemChanged.create(uuidv7(), 1, {
      name: 'cut-before-effect',
    });
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    consumer.probe.gate = async () => {
      if (++calls === 1) await blocked; // the first delivery is stuck inside the handler
    };

    await s.publish([first]);
    await waitFor(async () => calls === 1, { description: 'handler entered' });
    proxy.sever(); // the consumer's connection is cut
    proxy.mode = 'refuse';
    release();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      (await committed(s.kafka, consumer.name, s.topic))[0],
    ).toBeLessThanOrEqual(0);

    proxy.mode = 'pass';
    await waitFor(
      async () =>
        (await effects(consumer.name)) === 1 &&
        (await committed(s.kafka, consumer.name, s.topic))[0] === 1,
      {
        description: 'redelivered and applied once',
        timeoutMs: 45_000,
      },
    );
    expect(await inboxRecords(consumer.name)).toBe(1);

    // a cut after the effect but before the commit: the event comes back and is a duplicate
    const second = s.ItemChanged.create(uuidv7(), 1, {
      name: 'cut-after-effect',
    });
    let armed = true;
    consumer.probe.gate = undefined;
    consumer.probe.afterEffect = async () => {
      if (armed) {
        armed = false;
        proxy.sever();
        proxy.mode = 'refuse';
        // longer than the 6 s group session: the member is evicted before its commit can go through
        setTimeout(() => (proxy.mode = 'pass'), 9_000);
      }
    };
    await s.publish([second]);
    await waitFor(async () => metric(consumer.name, 'duplicate') >= 1, {
      description: 'redelivered as duplicate',
      timeoutMs: 45_000,
    });
    expect(await effects(consumer.name)).toBe(2);
    expect(consumer.probe.invocationsOf(second.eventId)).toBeGreaterThanOrEqual(
      1,
    );
  }, 120_000);

  it('S53 AS-38: a second instance joining during traffic splits the partitions, no aggregate runs on both at once, and 1,000 events are applied once each', async () => {
    const s = await scenario(6);
    const Inbox = s.make('inbox');
    const instance1 = await s.boot([Inbox]);
    const first = instance1.get(Inbox);
    const active = new Map<string, number>();
    let overlapped = false;
    const track = (c: ConsumerProbe) => {
      // One handler call may hold many events of an aggregate (that is one call, in order): count calls, not events.
      c.gate = async (events) => {
        for (const aggregateId of new Set(events.map((e) => e.aggregateId))) {
          active.set(aggregateId, (active.get(aggregateId) ?? 0) + 1);
          if (active.get(aggregateId)! > 1) overlapped = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      };
      c.afterEffect = async (events) => {
        for (const aggregateId of new Set(events.map((e) => e.aggregateId)))
          active.set(aggregateId, active.get(aggregateId)! - 1);
      };
    };
    track(first.probe);
    const aggregates = Array.from({ length: 60 }, () => uuidv7());
    const all = Array.from({ length: 1_000 }, (_, i) =>
      s.ItemChanged.create(aggregates[i % 60], Math.floor(i / 60) + 1, {
        name: `e${i}`,
      }),
    );

    await s.publish(all.slice(0, 300));
    const instance2 = await s.boot([Inbox]);
    track(instance2.get(Inbox).probe);
    await s.publish(all.slice(300));

    await waitFor(async () => (await effects(first.name)) === 1_000, {
      description: '1000 effects',
      timeoutMs: 90_000,
    });
    expect(await inboxRecords(first.name)).toBe(1_000);
    expect(overlapped).toBe(false);
    expect(
      await count(
        `SELECT count(DISTINCT "eventId") AS n FROM "S53FixtureEffect" WHERE "consumer" = $1`,
        first.name,
      ),
    ).toBe(1_000);
    await s.stop(instance2);
  }, 150_000);

  it('S53 AS-39: two consumers with different groups both receive every event, and a stuck one does not delay the other', async () => {
    const s = await scenario();
    const Fast = s.make('natural', 'fast');
    const Slow = s.make('natural', 'slow');
    const app = await s.boot([Fast, Slow]);
    const fast = app.get(Fast);
    const slow = app.get(Slow);
    let release!: () => void;
    const stuck = new Promise<void>((resolve) => (release = resolve));
    slow.probe.gate = () => stuck;
    const events = Array.from({ length: 10 }, (_, i) =>
      s.ItemChanged.create(uuidv7(), 1, { name: `e${i}` }),
    );

    await s.publish(events);

    await waitFor(
      async () => fast.probe.calls.flatMap((c) => c.events).length === 10,
      { description: 'fast got all 10' },
    );
    await waitFor(async () => slow.probe.calls.length > 0, {
      description: 'slow consumer entered its handler',
    });
    expect(slow.probe.calls.every((c) => c.endedAt === undefined)).toBe(true); // still stuck
    release();
    await waitFor(
      async () =>
        (await count(
          `SELECT count(*) AS n FROM "S53FixtureNatural" WHERE "consumer" = $1`,
          slow.name,
        )) === 10,
      {
        description: 'slow got all 10 too',
      },
    );
  });

  it('S53 AS-40: a coalescing consumer gets one event (version 30) for thirty in a batch, counts 29 coalesced and every event in the lag; one without coalesce gets all 30 in order', async () => {
    const s = await scenario();
    const Coalescing = s.make('versionGuard', 'coalescing', { coalesce: true });
    const Plain = s.make('versionGuard', 'plain');
    const aggregateId = uuidv7();
    await s.publish(
      Array.from({ length: 30 }, (_, i) =>
        s.ItemChanged.create(aggregateId, i + 1, { name: `v${i + 1}` }),
      ),
    );
    const app = await s.boot([Coalescing, Plain]);
    const coalescing = app.get(Coalescing);
    const plain = app.get(Plain);

    await waitFor(
      async () =>
        plain.probe.calls.flatMap((c) => c.events).length === 30 &&
        coalescing.probe.calls.length > 0,
      {
        description: 'both consumed',
      },
    );
    const handled = coalescing.probe.calls.flatMap((c) => c.events);
    expect(handled).toHaveLength(1);
    expect(handled[0].aggregateVersion).toBe(30);
    expect(metric(coalescing.name, 'coalesced')).toBe(29);
    expect(
      MetricsRegistry.histogramValue('projection_lag_seconds', {
        consumer: coalescing.name,
      })?.count,
    ).toBe(30);
    expect(
      await app
        .get(ProjectionCheckpoints)
        .projectedVersion(coalescing.name, s.agg, aggregateId),
    ).toBe(30);
    expect(
      plain.probe.calls.flatMap((c) => c.events).map((e) => e.aggregateVersion),
    ).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(metric(plain.name, 'coalesced')).toBe(0);
  });

  it('S53 AS-42: a delete at version 5 followed by a late upsert at version 4 stays deleted; an upsert at version 6 revives it', async () => {
    const s = await scenario();
    const Guard = s.make('versionGuard');
    const app = await s.boot([Guard]);
    const consumer = app.get(Guard);
    const aggregateId = uuidv7();

    await s.publish([
      s.ItemDeleted.create(aggregateId, 5, { name: '' }),
      s.ItemChanged.create(aggregateId, 4, { name: 'late' }),
    ]);
    await waitFor(async () => metric(consumer.name, 'stale') === 1, {
      description: 'late upsert stale',
    });
    expect(await doc(consumer.name, aggregateId)).toMatchObject({
      version: '5',
      deleted: true,
    });

    await s.publish([s.ItemChanged.create(aggregateId, 6, { name: 'back' })]);
    await waitFor(
      async () => (await doc(consumer.name, aggregateId))?.version === '6',
      { description: 'v6' },
    );
    expect(await doc(consumer.name, aggregateId)).toMatchObject({
      version: '6',
      name: 'back',
      deleted: false,
    });
  });

  it('S53 AS-31: the dedupe record shares the transaction: inbox records are per consumer, not per event id', async () => {
    const s = await scenario();
    const A = s.make('inbox', 'inbox-a');
    const B = s.make('inbox', 'inbox-b');
    const app = await s.boot([A, B]);
    const a = app.get(A);
    const b = app.get(B);
    const event = s.ItemChanged.create(uuidv7(), 1, { name: 'x' });

    await s.publish([event]);

    await waitFor(
      async () =>
        (await effects(a.name)) === 1 && (await effects(b.name)) === 1,
      { description: 'both applied' },
    );
    expect(await inboxRecords(a.name)).toBe(1);
    expect(await inboxRecords(b.name)).toBe(1);
  });

  afterEach(() => {
    proxy.mode = 'pass';
  });
});

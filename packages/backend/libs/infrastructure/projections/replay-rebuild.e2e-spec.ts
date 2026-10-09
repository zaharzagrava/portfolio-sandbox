import { Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { waitFor } from '@app/test/utils/async-helpers';
import { createTopics } from '@app/test/utils/kafka-test';
import { ConsumerKit } from '@app/infrastructure/events/testing/consumer-kit';
import { ConsumerLag, UnknownConsumerGroupError } from './consumer-lag';
import {
  GroupActiveError,
  HistoryTruncatedError,
  NotCaughtUpError,
  NotReplayableError,
  ProjectionAdmin,
} from './projection-admin.service';
import { ProjectionActivation } from './projection-activation';
import { ProjectionRunner } from './projection-runner.service';

const kit = new ConsumerKit();

describe('Rebuilding or replacing a read model without downtime', () => {
  beforeAll(() => kit.start());
  afterAll(() => kit.stopAll());

  const hash = async (consumer: string) =>
    (
      (
        await kit.sequelize.query(
          `SELECT md5(coalesce(string_agg("aggregateId" || ':' || "version" || ':' || "name" || ':' || "deleted", ',' ORDER BY "aggregateId"), '')) AS h
         FROM "S53FixtureDoc" WHERE "consumer" = $1`,
          { bind: [consumer] },
        )
      )[0] as { h: string }[]
    )[0].h;

  const docCount = (consumer: string) =>
    kit.count(
      `SELECT count(*) AS n FROM "S53FixtureDoc" WHERE "consumer" = $1`,
      consumer,
    );

  /** `aggregates` aggregates with versions 1..`versions`, interleaved, as envelopes. */
  const history = (
    s: Awaited<ReturnType<typeof kit.scenario>>,
    aggregates: number,
    versions: number,
  ) => {
    const ids = Array.from({ length: aggregates }, () => uuidv7());
    return {
      ids,
      events: Array.from({ length: versions }, (_, v) =>
        ids.map((id) =>
          s.ItemChanged.create(id, v + 1, {
            name: `${id.slice(-4)}-v${v + 1}`,
          }),
        ),
      ).flat(),
    };
  };

  const publishInBatches = async (
    s: Awaited<ReturnType<typeof kit.scenario>>,
    events: ReturnType<typeof history>['events'],
    size = 250,
  ) => {
    for (let i = 0; i < events.length; i += size)
      await s.publish(events.slice(i, i + size));
  };

  it('S53 AS-82: resetting a stopped group to the earliest offset and restarting it rebuilds an identical read model (same content hash)', async () => {
    const s = await kit.scenario();
    const Guard = s.make('versionGuard');
    const first = await s.boot([Guard]);
    const consumer = first.get(Guard);
    const { events } = history(s, 100, 10);
    await publishInBatches(s, events);
    await waitFor(
      async () =>
        kit.metric(consumer.name, 'applied') +
          kit.metric(consumer.name, 'stale') >=
        1_000,
      {
        description: '1000 events applied',
        timeoutMs: 60_000,
      },
    );
    const before = await hash(consumer.name);
    await first.get(ProjectionRunner, { strict: false }).stopAll();
    await kit.sequelize.query(
      `DELETE FROM "S53FixtureDoc" WHERE "consumer" = $1`,
      { bind: [consumer.name] },
    );
    expect(await docCount(consumer.name)).toBe(0);

    const admin = first.get(ProjectionAdmin, { strict: false });
    await admin.rebuild({ consumer: consumer.name, topics: [s.topic] });
    expect((await kit.committed(s.kafka, consumer.name, s.topic))[0]).toBe(0);

    const second = await s.boot([Guard]);
    await waitFor(async () => (await docCount(consumer.name)) === 100, {
      description: 'rebuilt',
      timeoutMs: 60_000,
    });
    await waitFor(async () => (await hash(consumer.name)) === before, {
      description: 'identical hash',
      timeoutMs: 30_000,
    });
    expect(
      second.get(Guard).probe.calls.flatMap((c) => c.events).length,
    ).toBeGreaterThanOrEqual(1_000);
  }, 120_000);

  it('S53 AS-83: a group with a live member is refused with GROUP_ACTIVE and its offsets are untouched', async () => {
    const s = await kit.scenario();
    const Guard = s.make('versionGuard');
    const app = await s.boot([Guard]);
    const consumer = app.get(Guard);
    await s.publish(history(s, 5, 2).events);
    await waitFor(
      async () =>
        (await kit.doc(consumer.name, ''))?.version === undefined &&
        kit.metric(consumer.name, 'applied') === 10,
      {
        description: 'applied',
      },
    );
    await waitFor(
      async () =>
        (await kit.committed(s.kafka, consumer.name, s.topic))[0] === 10,
      { description: 'committed' },
    );
    await kit.awaitMembers(s.kafka, consumer.name, 1);
    const before = await kit.committed(s.kafka, consumer.name, s.topic);

    const attempt = app
      .get(ProjectionAdmin, { strict: false })
      .rebuild({ consumer: consumer.name, topics: [s.topic] });

    await expect(attempt).rejects.toBeInstanceOf(GroupActiveError);
    await expect(attempt).rejects.toMatchObject({ code: 'GROUP_ACTIVE' });
    expect(await kit.committed(s.kafka, consumer.name, s.topic)).toEqual(
      before,
    );
  }, 60_000);

  it('S53 AS-84: promotion is refused while the new version lags or its verification fails, then switches reads atomically once it has caught up; the old version is kept', async () => {
    const s = await kit.scenario();
    const V1 = s.make('versionGuard', 'live');
    const V2 = s.make('versionGuard', 'shadow');
    const app1 = await s.boot([V1]);
    const live = app1.get(V1);
    const shadowName = `fx-shadow-${s.id}`;
    await publishInBatches(s, history(s, 150, 10).events);
    await waitFor(
      async () =>
        (await docCount(live.name)) === 150 &&
        (await kit.committed(s.kafka, live.name, s.topic))[0] === 1_500,
      {
        description: 'live version built',
        timeoutMs: 60_000,
      },
    );
    // v2 exists as a group at the earliest offset, with nothing consumed yet: 1,500 events behind
    const admin = s.kafka.admin();
    await admin.connect();
    await admin.setOffsets({
      groupId: shadowName,
      topic: s.topic,
      partitions: [{ partition: 0, offset: '0' }],
    });
    await admin.disconnect();
    const activation = app1.get(ProjectionActivation, { strict: false });
    await activation.switchTo('docs', 'v1');
    const projections = app1.get(ProjectionAdmin, { strict: false });

    await expect(
      projections.promote({ name: 'docs', label: 'v2', group: shadowName }),
    ).rejects.toBeInstanceOf(NotCaughtUpError);
    await expect(
      projections.promote({ name: 'docs', label: 'v2', group: shadowName }),
    ).rejects.toMatchObject({ code: 'NOT_CAUGHT_UP' });
    expect(await activation.active('docs')).toBe('v1');

    const app2 = await s.boot([V2]);
    await waitFor(
      async () =>
        (await app2.get(ConsumerLag, { strict: false }).read(shadowName))
          .caughtUp,
      {
        description: 'shadow caught up',
        timeoutMs: 60_000,
      },
    );
    // caught up but the counts differ: refused
    await expect(
      projections.promote({
        name: 'docs',
        label: 'v2',
        group: shadowName,
        verify: async () => false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_CAUGHT_UP' });
    expect(await activation.active('docs')).toBe('v1');

    await projections.promote({
      name: 'docs',
      label: 'v2',
      group: shadowName,
      verify: async () =>
        (await docCount(live.name)) === (await docCount(shadowName)),
    });

    expect(await activation.active('docs')).toBe('v2');
    expect(await activation.previous('docs')).toBe('v1');
    expect(await docCount(live.name)).toBe(150); // v1 is kept, not dropped
  }, 150_000);

  it('S53 AS-85: a rollback after promotion makes reads use v1 again, and v1 kept applying events so it is not stale', async () => {
    const s = await kit.scenario();
    const V1 = s.make('versionGuard', 'live');
    const V2 = s.make('versionGuard', 'shadow');
    const app = await s.boot([V1, V2]);
    const live = app.get(V1);
    const shadow = app.get(V2);
    const { ids, events } = history(s, 10, 3);
    await s.publish(events);
    await waitFor(
      async () =>
        (await docCount(live.name)) === 10 &&
        (await docCount(shadow.name)) === 10,
      { description: 'both built' },
    );
    const projections = app.get(ProjectionAdmin, { strict: false });
    const activation = app.get(ProjectionActivation, { strict: false });
    await activation.switchTo('docs2', 'v1');
    await projections.promote({
      name: 'docs2',
      label: 'v2',
      group: shadow.name,
      maxLag: 0,
    });
    expect(await activation.active('docs2')).toBe('v2');

    await s.publish([
      s.ItemChanged.create(ids[0], 4, { name: 'while v2 is active' }),
    ]);
    await waitFor(
      async () => (await kit.doc(live.name, ids[0]))?.version === '4',
      { description: 'v1 kept applying' },
    );

    expect(await projections.rollback('docs2')).toBe('v1');
    expect(await activation.active('docs2')).toBe('v1');
    expect(await kit.doc(live.name, ids[0])).toMatchObject({
      version: '4',
      name: 'while v2 is active',
    });
  }, 90_000);

  it('S53 AS-86: a replay stopped partway continues from the committed offsets, not from zero, and every event is applied exactly once overall', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural', 'resume');
    const { events } = history(s, 100, 10);
    await publishInBatches(s, events.slice(0, 400));
    const first = await s.boot([Natural]);
    const run1 = first.get(Natural);
    await waitFor(
      async () => (await kit.committed(s.kafka, run1.name, s.topic))[0] === 400,
      { description: 'stopped after 400', timeoutMs: 60_000 },
    );
    await first.get(ProjectionRunner, { strict: false }).stopAll();
    await publishInBatches(s, events.slice(400));

    const second = await s.boot([Natural]);
    const run2 = second.get(Natural);
    await waitFor(
      async () =>
        (await kit.committed(s.kafka, run2.name, s.topic))[0] === 1_000,
      { description: 'finished', timeoutMs: 60_000 },
    );

    const handled1 = run1.probe.calls
      .flatMap((c) => c.events)
      .map((e) => e.eventId);
    const handled2 = run2.probe.calls
      .flatMap((c) => c.events)
      .map((e) => e.eventId);
    expect(handled1).toHaveLength(400);
    expect(handled2).toHaveLength(600); // it did not start from zero
    expect(new Set([...handled1, ...handled2]).size).toBe(1_000);
    expect(handled1.some((id) => handled2.includes(id))).toBe(false);
  }, 120_000);

  it('S53 AS-87: a consumer with side effects is not rewound without --allow-side-effects and a reason; with both it proceeds and one audit line names consumer, reason and operator', async () => {
    const s = await kit.scenario();
    const Effectful = s.make('natural', 'effects', { replayable: false });
    const app = await s.boot([Effectful]);
    const consumer = app.get(Effectful);
    await s.publish(history(s, 3, 1).events);
    await waitFor(
      async () =>
        (await kit.committed(s.kafka, consumer.name, s.topic))[0] === 3,
      { description: 'consumed' },
    );
    await app.get(ProjectionRunner, { strict: false }).stopAll();
    const admin = app.get(ProjectionAdmin, { strict: false });

    await expect(
      admin.rebuild({ consumer: consumer.name, topics: [s.topic] }),
    ).rejects.toBeInstanceOf(NotReplayableError);
    await expect(
      admin.rebuild({
        consumer: consumer.name,
        topics: [s.topic],
        allowSideEffects: true,
      }),
    ).rejects.toMatchObject({
      code: 'NOT_REPLAYABLE',
    }); // the flag alone is not enough: a reason is required too
    expect((await kit.committed(s.kafka, consumer.name, s.topic))[0]).toBe(3);

    const lines: string[] = [];
    Logger.overrideLogger({
      log: (m: unknown) => lines.push(String(m)),
      warn: (m: unknown) => lines.push(String(m)),
      error: () => undefined,
      debug: () => undefined,
      verbose: () => undefined,
      fatal: () => undefined,
    } as never);
    try {
      await admin.rebuild({
        consumer: consumer.name,
        topics: [s.topic],
        allowSideEffects: true,
        reason: 'backfill after a provider outage',
        operator: 'alice',
      });
    } finally {
      Logger.overrideLogger(['fatal']);
    }

    expect((await kit.committed(s.kafka, consumer.name, s.topic))[0]).toBe(0);
    const audit = lines.filter((l) =>
      l.includes('projection.rebuild.side_effects'),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toContain(consumer.name);
    expect(audit[0]).toContain('backfill after a provider outage');
    expect(audit[0]).toContain('alice');
  }, 60_000);

  it('S53 AS-88: a truncated, non-compacted topic is refused HISTORY_TRUNCATED unless --from-retained; a compacted topic proceeds and rebuilds the latest state including versioned deletes', async () => {
    const s = await kit.scenario();
    const admin = s.kafka.admin();
    await admin.connect();
    const group = `fx-truncated-${s.id}`;
    await s.publish(history(s, 10, 10).events); // 100 events on the plain topic
    await admin.fetchTopicMetadata({ topics: [s.topic] });
    await admin.deleteTopicRecords({
      topic: s.topic,
      partitions: [{ partition: 0, offset: '40' }],
    });
    const projections = (await s.boot([s.make('natural')])).get(
      ProjectionAdmin,
      { strict: false },
    );

    await expect(
      projections.rebuild({ consumer: group, topics: [s.topic] }),
    ).rejects.toBeInstanceOf(HistoryTruncatedError);
    await expect(
      projections.rebuild({ consumer: group, topics: [s.topic] }),
    ).rejects.toMatchObject({ code: 'HISTORY_TRUNCATED' });
    await expect(
      projections.rebuild({
        consumer: group,
        topics: [s.topic],
        fromRetained: true,
      }),
    ).resolves.toEqual({ topics: [s.topic] });
    expect((await kit.committed(s.kafka, group, s.topic))[0]).toBe(40);

    // a compacted (latest-per-key) topic: older versions may be gone, the latest of each aggregate is kept
    const compacted = await kit.scenario();
    const compactedTopic = `${compacted.agg}-c.events`;
    // `compact,delete`: compacted for the rebuild check, and the broker still lets the test cut the front off
    await createTopics([
      {
        topic: compactedTopic,
        configEntries: [{ name: 'cleanup.policy', value: 'compact,delete' }],
      },
    ]);
    const ids = Array.from({ length: 5 }, () => uuidv7());
    const older = ids.flatMap((id) =>
      [1, 2, 3].map((v) =>
        compacted.ItemChanged.create(id, v, { name: `old-${v}` }),
      ),
    );
    const latest = [
      ...ids
        .slice(0, 4)
        .map((id) => compacted.ItemChanged.create(id, 9, { name: 'latest' })),
      compacted.ItemDeleted.create(ids[4], 9, { name: '' }),
    ];
    const compactedProducer = compacted.kafka.producer();
    await compactedProducer.connect();
    await compactedProducer.send({
      topic: compactedTopic,
      messages: [...older, ...latest].map((e) => ({
        key: e.aggregateId,
        value: JSON.stringify(e),
      })),
    });
    await compactedProducer.disconnect();
    await admin.fetchTopicMetadata({ topics: [compactedTopic] });
    await admin.deleteTopicRecords({
      topic: compactedTopic,
      partitions: [{ partition: 0, offset: '15' }],
    });
    const Replayer = fixtureOnTopic(compacted, compactedTopic);
    const rebuilt = await compacted.boot([Replayer]);
    const replayer = rebuilt.get(Replayer);
    const stop = rebuilt.get(ProjectionRunner, { strict: false });
    await waitFor(async () => (await docCount(replayer.name)) === 5, {
      description: 'latest state of every aggregate',
      timeoutMs: 30_000,
    });
    await stop.stopAll();
    await kit.sequelize.query(
      `DELETE FROM "S53FixtureDoc" WHERE "consumer" = $1`,
      { bind: [replayer.name] },
    );

    await expect(
      rebuilt
        .get(ProjectionAdmin, { strict: false })
        .rebuild({ consumer: replayer.name, topics: [compactedTopic] }),
    ).resolves.toEqual({ topics: [compactedTopic] });
    const again = await compacted.boot([Replayer]);
    await waitFor(
      async () => (await docCount(again.get(Replayer).name)) === 5,
      { description: 'rebuilt from the compacted topic', timeoutMs: 30_000 },
    );
    for (const id of ids.slice(0, 4))
      expect(await kit.doc(replayer.name, id)).toMatchObject({
        version: '9',
        name: 'latest',
        deleted: false,
      });
    expect(await kit.doc(replayer.name, ids[4])).toMatchObject({
      version: '9',
      deleted: true,
    }); // a versioned delete
    await admin.disconnect();
  }, 120_000);

  it('S53 AS-89: lag is per partition and total, caughtUp turns true once the consumer has applied the rest, and an unknown group raises UnknownConsumerGroupError', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural', 'lag');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const lag = app.get(ConsumerLag, { strict: false });
    await s.publish(history(s, 60, 1).events);
    await waitFor(
      async () =>
        (await kit.committed(s.kafka, consumer.name, s.topic))[0] === 60,
      { description: '60 applied' },
    );
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    consumer.probe.gate = () => hold;

    await s.publish(history(s, 40, 1).events);
    await waitFor(
      async () =>
        consumer.probe.calls.length > 0 &&
        (await lag.read(consumer.name)).totalLag === 40,
      {
        description: 'lag 40',
      },
    );

    const behind = await lag.read(consumer.name);
    expect(behind).toEqual({
      partitions: [
        {
          topic: s.topic,
          partition: 0,
          committedOffset: 60,
          endOffset: 100,
          lag: 40,
        },
      ],
      totalLag: 40,
      caughtUp: false,
    });
    release();
    await waitFor(async () => (await lag.read(consumer.name)).caughtUp, {
      description: 'caught up',
    });
    expect((await lag.read(consumer.name)).totalLag).toBe(0);

    await expect(lag.read(`no-such-group-${uuidv7()}`)).rejects.toBeInstanceOf(
      UnknownConsumerGroupError,
    );
  }, 60_000);
});

/** A version-guard consumer reading a topic other than the scenario's (the compacted one). */
function fixtureOnTopic(
  s: Awaited<ReturnType<typeof kit.scenario>>,
  topic: string,
) {
  return s.make('versionGuard', 'compacted', { topics: [topic] });
}

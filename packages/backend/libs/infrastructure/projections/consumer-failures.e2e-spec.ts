import { Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { waitFor } from '@app/test/utils/async-helpers';
import { readTopic } from '@app/test/utils/kafka-test';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import { defineEvent } from '@app/infrastructure/events/define-event';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import {
  ConsumerKit,
  kitClock,
} from '@app/infrastructure/events/testing/consumer-kit';
import {
  SinkBackpressureError,
  PermanentError,
  TransientError,
} from './errors';
import { ProjectionRunner } from './projection-runner.service';
import { RedriveService } from './redrive.service';
import { Projector } from './projector';
import type { ConsumerProbe } from '@app/infrastructure/events/testing/fixture-consumers';

const kit = new ConsumerKit();
const dlqTotal = (consumer: string, code: string) =>
  MetricsRegistry.value('dlq_total', { consumer, reason: code }) ?? 0;
const dlq = (consumer: string) => readTopic(`${consumer}.dlq`);

describe('Bad messages and sick stores do not stop the line', () => {
  beforeAll(() => kit.start());
  afterAll(() => kit.stopAll());
  afterEach(() => kit.resetProxy());

  it('S53 AS-50: invalid JSON, an empty value and a non-envelope each go to the dead-letter topic, the rest of the batch is applied', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const [a, b] = [uuidv7(), uuidv7()];

    await s.publishRaw([
      {
        key: a,
        value: JSON.stringify(s.ItemChanged.create(a, 1, { name: 'good-1' })),
      },
      { key: 'k1', value: '{this is not json' },
      { key: 'k2', value: null },
      { key: 'k3', value: JSON.stringify({ hello: 'world' }) },
      {
        key: b,
        value: JSON.stringify(s.ItemChanged.create(b, 1, { name: 'good-2' })),
      },
    ]);

    await waitFor(
      async () =>
        (await dlq(consumer.name)).length === 3 &&
        (await kit.naturalRows(consumer.name)) === 2,
      {
        description: '3 dead letters, 2 applied',
      },
    );
    const letters = await dlq(consumer.name);
    expect(letters.map((l) => l.headers['x-dlq-reason-code'])).toEqual([
      'INVALID_ENVELOPE',
      'INVALID_ENVELOPE',
      'INVALID_ENVELOPE',
    ]);
    expect(
      consumer.probe.calls
        .flatMap((c) => c.events)
        .map((e) => e.aggregateId)
        .sort(),
    ).toEqual([a, b].sort());
    expect(dlqTotal(consumer.name, 'INVALID_ENVELOPE')).toBe(3);
  });

  it('S53 AS-51: the third of five events fails its payload schema: it is dead-lettered with the paths, never the values, and the other four are applied', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const ids = Array.from({ length: 5 }, () => uuidv7());
    const events = ids.map((id, i) =>
      s.ItemChanged.create(id, 1, { name: `n${i}` }),
    );
    const bad = { ...events[2], payload: { name: 987654 } };

    await s.publishRaw(
      events.map((e, i) => ({
        key: e.aggregateId,
        value: JSON.stringify(i === 2 ? bad : e),
      })),
    );

    await waitFor(
      async () =>
        (await dlq(consumer.name)).length === 1 &&
        (await kit.naturalRows(consumer.name)) === 4,
      {
        description: '1 dead letter, 4 applied',
      },
    );
    const [letter] = await dlq(consumer.name);
    expect(letter.headers['x-dlq-reason-code']).toBe('INVALID_PAYLOAD');
    expect(letter.headers['x-dlq-reason']).toContain('name');
    expect(letter.headers['x-dlq-reason']).not.toContain('987654');
    expect(letter.key).toBe(ids[2]);
  });

  it('S53 AS-52: an unknown event type is skipped and counted ignored, its offset is committed, nothing is dead-lettered', async () => {
    const s = await kit.scenario();
    const Other = defineEvent(
      `${s.agg}.something_else`,
      s.agg,
      1,
      z.object({ x: z.number() }),
    );
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);

    await s.publish([Other.create(uuidv7(), 1, { x: 1 })]);

    await waitFor(async () => kit.metric(consumer.name, 'ignored') === 1, {
      description: 'ignored',
    });
    await waitFor(
      async () =>
        (await kit.committed(s.kafka, consumer.name, s.topic))[0] === 1,
      { description: 'offset committed' },
    );
    expect(consumer.probe.calls).toHaveLength(0);
    expect(await dlq(consumer.name)).toHaveLength(0);
  });

  it('S53 AS-53: an event of a known type with a newer contract version is dead-lettered UNSUPPORTED_VERSION', async () => {
    const s = await kit.scenario();
    const V2 = defineEvent(
      s.ItemChanged.type,
      s.agg,
      2,
      z.object({ name: z.string() }),
    );
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);

    await s.publish([V2.create(uuidv7(), 1, { name: 'from the future' })]);

    await waitFor(async () => (await dlq(consumer.name)).length === 1, {
      description: 'dead letter',
    });
    expect((await dlq(consumer.name))[0].headers['x-dlq-reason-code']).toBe(
      'UNSUPPORTED_VERSION',
    );
    expect(consumer.probe.calls).toHaveLength(0);
  });

  it('S53 AS-54: a version 1 event is upgraded and applied with the same effect as a native version 2', async () => {
    const s = await kit.scenario();
    const R1 = defineEvent(
      `${s.agg}.renamed`,
      s.agg,
      1,
      z.object({ name: z.string() }),
      { carries: 'state' },
    );
    const R2 = defineEvent(
      `${s.agg}.renamed`,
      s.agg,
      2,
      z.object({ title: z.string() }),
      { carries: 'state' },
    );
    const Natural = s.make('natural', 'natural', {
      handles: [
        {
          event: R2,
          upgradeFrom: [
            {
              version: 1,
              upcast: (p) => ({ title: (p as { name: string }).name }),
            },
          ],
        },
      ],
    });
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const [old, native] = [uuidv7(), uuidv7()];

    await s.publish([
      R1.create(old, 1, { name: 'Same' }),
      R2.create(native, 1, { title: 'Same' }),
    ]);

    await waitFor(async () => (await kit.naturalRows(consumer.name)) === 2, {
      description: 'both applied',
    });
    const [rows] = await kit.sequelize.query(
      `SELECT "key", "value" FROM "S53FixtureNatural" WHERE "consumer" = $1`,
      { bind: [consumer.name] },
    );
    expect(
      (rows as { key: string; value: string }[]).map((r) => r.value),
    ).toEqual(['Same', 'Same']);
    const handled = consumer.probe.calls.flatMap((c) => c.events);
    expect(handled.map((e) => e.version)).toEqual([2, 2]);
    expect(handled.map((e) => e.payload)).toEqual([
      { title: 'Same' },
      { title: 'Same' },
    ]);
    expect(await dlq(consumer.name)).toHaveLength(0);
  });

  it('S53 AS-55: an aggregate id that is not a UUID is dead-lettered INVALID_AGGREGATE_ID and has no effect', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural', 'natural', {
      aggregateIdSchema: z.uuid(),
    });
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);

    await s.publish([
      s.ItemChanged.create('not-a-uuid', 1, { name: 'bad id' }),
      s.ItemChanged.create(uuidv7(), 1, { name: 'good id' }),
    ]);

    await waitFor(
      async () =>
        (await dlq(consumer.name)).length === 1 &&
        (await kit.naturalRows(consumer.name)) === 1,
      {
        description: '1 dead letter, 1 applied',
      },
    );
    expect((await dlq(consumer.name))[0].headers['x-dlq-reason-code']).toBe(
      'INVALID_AGGREGATE_ID',
    );
    expect((await dlq(consumer.name))[0].headers['x-dlq-reason']).not.toContain(
      'not-a-uuid',
    );
  });

  it('S53 AS-56: a dead letter keeps the original key and value bytes and carries the full header set', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const key = Buffer.from('raw-key-\u0001-bytes', 'latin1');
    const value = Buffer.from('{broken json é with bytes', 'latin1');

    const [meta] = await s.publishRaw([{ key, value }]);

    await waitFor(async () => (await dlq(consumer.name)).length === 1, {
      description: 'dead letter',
    });
    const [letter] = await dlq(consumer.name);
    const raw = await rawDlq(s.kafka, consumer.name);
    expect(Buffer.compare(raw.key!, key)).toBe(0);
    expect(Buffer.compare(raw.value!, value)).toBe(0);
    expect(Object.keys(letter.headers).sort()).toEqual([
      'x-attempts',
      'x-consumer',
      'x-dlq-reason',
      'x-dlq-reason-code',
      'x-failed-at',
      'x-source-offset',
      'x-source-partition',
      'x-source-topic',
    ]);
    expect(letter.headers).toMatchObject({
      'x-source-topic': s.topic,
      'x-source-partition': '0',
      'x-source-offset': String(meta.baseOffset),
      'x-consumer': consumer.name,
      'x-dlq-reason-code': 'INVALID_ENVELOPE',
      'x-attempts': '0',
      'x-failed-at': kitClock.now().toISOString(),
    });
    expect(letter.headers['x-dlq-reason'].length).toBeLessThanOrEqual(500);
  });

  it('S53 AS-57: a handler that always throws a permanent error is attempted 3 times, then dead-lettered HANDLER_FAILED, the others are applied and the offset passes it', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const [e1, poison, e3] = [uuidv7(), uuidv7(), uuidv7()].map((id, i) =>
      s.ItemChanged.create(id, 1, { name: `e${i}` }),
    );
    consumer.probe.throwBefore.set(poison.eventId, {
      times: -1,
      error: () => new PermanentError('cannot be applied'),
    });

    await s.publish([e1, poison, e3]);

    await waitFor(
      async () =>
        (await dlq(consumer.name)).length === 1 &&
        (await kit.naturalRows(consumer.name)) === 2,
      {
        description: 'poison dead-lettered, others applied',
      },
    );
    expect(consumer.probe.invocationsOf(poison.eventId)).toBe(3);
    const [letter] = await dlq(consumer.name);
    expect(letter.headers).toMatchObject({
      'x-dlq-reason-code': 'HANDLER_FAILED',
      'x-attempts': '3',
    });
    expect(letter.headers['x-dlq-reason']).toContain('PermanentError');
    expect(letter.headers['x-dlq-reason']).not.toContain('cannot be applied');
    expect(letter.json<EventEnvelope>().eventId).toBe(poison.eventId);
    await waitFor(
      async () =>
        (await kit.committed(s.kafka, consumer.name, s.topic))[0] === 3,
      { description: 'offset passed the poison' },
    );
  });

  it('S53 AS-58: a consumer configured for 6 attempts invokes the handler exactly 6 times before dead-lettering', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural', 'six', { attempts: 6 });
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const poison = s.ItemChanged.create(uuidv7(), 1, { name: 'poison' });
    consumer.probe.throwBefore.set(poison.eventId, {
      times: -1,
      error: () => new Error('always'),
    });

    await s.publish([poison]);

    await waitFor(async () => (await dlq(consumer.name)).length === 1, {
      description: 'dead letter',
    });
    expect(consumer.probe.invocationsOf(poison.eventId)).toBe(6);
    expect((await dlq(consumer.name))[0].headers['x-attempts']).toBe('6');
  });

  it('S53 AS-59: a sink that is unreachable for 30 s pauses the partition: nothing is dead-lettered, and after the sink returns every event is applied in order', async () => {
    const s = await kit.scenario();
    const sinkProxy = await TcpFaultProxy.start({
      host: 'localhost',
      port: 6400,
    });
    const direct = new Redis({ host: 'localhost', port: 6400 });
    const listKey = `s53:outage:${s.id}`;

    @Injectable()
    class OutageConsumer implements Projector {
      readonly name = `fx-outage-${s.id}`;
      readonly topics = [s.topic];
      readonly idempotency = 'natural' as const;
      readonly handles = [{ event: s.ItemChanged }];
      private readonly sink = new Redis({
        host: '127.0.0.1',
        port: sinkProxy.port,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        retryStrategy: () => 200,
      });
      async project(events: EventEnvelope[]): Promise<void> {
        try {
          if (this.sink.status === 'wait' || this.sink.status === 'end')
            await this.sink.connect().catch(() => undefined);
          for (const e of events) await this.sink.rpush(listKey, e.eventId);
        } catch (error) {
          throw new TransientError('sink unreachable', { cause: error });
        }
      }
    }
    const app = await s.boot([OutageConsumer]);
    const consumer = app.get(OutageConsumer);
    const before = Array.from({ length: 3 }, (_, i) =>
      s.ItemChanged.create(uuidv7(), 1, { name: `b${i}` }),
    );
    await s.publish(before);
    await waitFor(async () => (await direct.llen(listKey)) === 3, {
      description: 'first three applied',
    });

    sinkProxy.mode = 'refuse';
    sinkProxy.sever();
    const during = Array.from({ length: 6 }, (_, i) =>
      s.ItemChanged.create(uuidv7(), 1, { name: `d${i}` }),
    );
    await s.publish(during);
    await new Promise((resolve) => setTimeout(resolve, 30_000));

    expect(dlqTotal(consumer.name, 'HANDLER_FAILED')).toBe(0);
    expect(await direct.llen(listKey)).toBe(3);
    expect(
      MetricsRegistry.value('consumer_paused_total', {
        consumer: consumer.name,
        reason: 'transient',
      }) ?? 0,
    ).toBeGreaterThan(0);

    sinkProxy.mode = 'pass';
    await waitFor(async () => (await direct.llen(listKey)) === 9, {
      description: 'all applied after the outage',
      timeoutMs: 30_000,
    });
    expect(await direct.lrange(listKey, 0, -1)).toEqual(
      [...before, ...during].map((e) => e.eventId),
    );
    expect(await dlq(consumer.name)).toHaveLength(0);
    await direct.del(listKey);
    direct.disconnect();
    await sinkProxy.close();
  }, 120_000);

  it('S53 AS-60: a backpressure error pauses that partition for at least its delay, other partitions keep flowing, and it is not a failure', async () => {
    const s = await kit.scenario(2);
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const slowOne = s.ItemChanged.create(uuidv7(), 1, {
      name: 'on-partition-0',
    });
    consumer.probe.throwBefore.set(slowOne.eventId, {
      times: 1,
      error: () => new SinkBackpressureError('saturated', 2_000),
    });

    await s.publish([slowOne], { partition: 0 });
    await waitFor(
      async () => consumer.probe.invocationsOf(slowOne.eventId) === 1,
      { description: 'first attempt' },
    );
    const others = Array.from({ length: 5 }, (_, i) =>
      s.ItemChanged.create(uuidv7(), 1, { name: `p1-${i}` }),
    );
    await s.publish(others, { partition: 1 });

    await waitFor(async () => (await kit.naturalRows(consumer.name)) >= 5, {
      description: 'partition 1 flows during the pause',
      timeoutMs: 1_900,
    });
    expect(consumer.probe.invocationsOf(slowOne.eventId)).toBe(1); // still paused
    await waitFor(
      async () => consumer.probe.invocationsOf(slowOne.eventId) === 2,
      { description: 'second attempt after the pause' },
    );
    const attempts = consumer.probe.calls.filter((c) =>
      c.events.some((e) => e.eventId === slowOne.eventId),
    );
    expect(
      attempts[1].startedAt - attempts[0].startedAt,
    ).toBeGreaterThanOrEqual(2_000);
    expect(
      MetricsRegistry.value('consumer_paused_total', {
        consumer: consumer.name,
        reason: 'backpressure',
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(await dlq(consumer.name)).toHaveLength(0);
    await waitFor(async () => (await kit.naturalRows(consumer.name)) === 6, {
      description: 'the paused event applied',
    });
  });

  it('S53 AS-61: 5,000 events on one partition and a slow handler never put more than 500 events inside the handler', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural');
    const app = await s.boot([Natural], {
      config: { consumer_batch: 2_000, consumer_in_flight: 500 },
    });
    const consumer = app.get(Natural);
    consumer.probe.gate = () =>
      new Promise((resolve) => setTimeout(resolve, 20));
    const events = Array.from({ length: 5_000 }, (_, i) =>
      s.ItemChanged.create(uuidv7(), 1, { name: `e${i}` }),
    );
    for (let i = 0; i < events.length; i += 1_000)
      await s.publish(events.slice(i, i + 1_000));

    await waitFor(
      async () => (await kit.naturalRows(consumer.name)) === 5_000,
      { description: '5000 applied', timeoutMs: 90_000 },
    );

    expect(consumer.probe.maxInHandler).toBeLessThanOrEqual(500);
    expect(consumer.probe.maxInHandler).toBeGreaterThan(1);
  }, 120_000);

  it('S53 AS-62: when the dead-letter topic cannot be written the offset is held, nothing is dropped, and dlq_write_failures_total rises; after recovery the letter is written and the batch committed', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural');
    const app = await s.boot([Natural], { producerProxy: true });
    const consumer = app.get(Natural);
    const good = s.ItemChanged.create(uuidv7(), 1, {
      name: 'after the poison',
    });
    const failuresBefore =
      MetricsRegistry.value('dlq_write_failures_total', {
        consumer: consumer.name,
      }) ?? 0;
    kit.proxy.mode = 'refuse';
    kit.proxy.sever();

    await s.publishRaw([
      { key: 'k', value: '{poison' },
      { key: good.aggregateId, value: JSON.stringify(good) },
    ]);

    await waitFor(
      async () =>
        (MetricsRegistry.value('dlq_write_failures_total', {
          consumer: consumer.name,
        }) ?? 0) > failuresBefore,
      { description: 'a write failure is counted', timeoutMs: 30_000 },
    );
    expect(
      (await kit.committed(s.kafka, consumer.name, s.topic))[0],
    ).toBeLessThanOrEqual(0);

    kit.proxy.mode = 'pass';
    await waitFor(
      async () =>
        (await dlq(consumer.name)).length >= 1 &&
        (await kit.naturalRows(consumer.name)) === 1,
      {
        description: 'letter written and the good event applied',
        timeoutMs: 60_000,
      },
    );
    await waitFor(
      async () =>
        (await kit.committed(s.kafka, consumer.name, s.topic))[0] === 2,
      { description: 'committed after recovery' },
    );
    expect((await dlq(consumer.name))[0].headers['x-dlq-reason-code']).toBe(
      'INVALID_ENVELOPE',
    );
  }, 120_000);

  it('S53 AS-63: redrive republishes dead letters to the source topic with the original key and a higher count, refuses one already redriven three times, and each is applied once after the fix', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural', 'natural', { attempts: 1 });
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    const events = Array.from({ length: 3 }, (_, i) =>
      s.ItemChanged.create(uuidv7(), 1, { name: `r${i}` }),
    );
    const exhausted = s.ItemChanged.create(uuidv7(), 1, {
      name: 'already redriven 3 times',
    });
    for (const e of [...events, exhausted])
      consumer.probe.throwBefore.set(e.eventId, {
        times: -1,
        error: () => new PermanentError('fix pending'),
      });

    await s.publish(events);
    await s.publishRaw([
      {
        key: exhausted.aggregateId,
        value: JSON.stringify(exhausted),
        headers: { 'x-redrive-count': '3' },
      },
    ]);
    await waitFor(async () => (await dlq(consumer.name)).length === 4, {
      description: '4 dead letters',
    });
    expect(
      (await dlq(consumer.name)).find((l) => l.key === exhausted.aggregateId)!
        .headers['x-redrive-count'],
    ).toBe('3');

    consumer.probe.throwBefore.clear(); // the cause is fixed
    const result = await app
      .get(RedriveService, { strict: false })
      .redrive(consumer.name);

    expect(result).toEqual({ redriven: 3, refused: 1 });
    await waitFor(async () => (await kit.naturalRows(consumer.name)) === 3, {
      description: 'three applied after redrive',
    });
    expect(
      consumer.probe.calls
        .flatMap((c) => c.events)
        .filter((e) => e.eventId === exhausted.eventId).length,
    ).toBe(1); // only the original try
    const source = await readTopic(s.topic);
    const redriven = source.filter((m) => m.headers['x-redrive-count'] === '1');
    expect(redriven.map((m) => m.key).sort()).toEqual(
      events.map((e) => e.aggregateId).sort(),
    );
    // a second run finds nothing new
    expect(
      await app.get(RedriveService, { strict: false }).redrive(consumer.name),
    ).toEqual({ redriven: 0, refused: 0 });
  }, 90_000);

  it('S53 AS-64: stopping during a batch lets it finish, commits the last applied offset plus one, and closes within 20 s', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural');
    const app = await s.boot([Natural]);
    const consumer = app.get(Natural);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    consumer.probe.gate = () => hold;
    const events = Array.from({ length: 4 }, (_, i) =>
      s.ItemChanged.create(uuidv7(), 1, { name: `e${i}` }),
    );
    await s.publish(events);
    await waitFor(async () => consumer.probe.calls.length > 0, {
      description: 'handler entered',
    });
    const started = Date.now();

    const stopping = app.get(ProjectionRunner, { strict: false }).stopAll();
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    await stopping;

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(await kit.naturalRows(consumer.name)).toBe(4);
    expect((await kit.committed(s.kafka, consumer.name, s.topic))[0]).toBe(4);
    // nothing new is fetched after the stop
    const late = s.ItemChanged.create(uuidv7(), 1, { name: 'after stop' });
    await s.publish([late]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await kit.naturalRows(consumer.name)).toBe(4);
  }, 60_000);

  it('S53 AS-65: a handler that hangs hits the handler timeout as a transient failure that spends an attempt, and the group session stays alive', async () => {
    const s = await kit.scenario();
    const Natural = s.make('natural', 'natural', { attempts: 2 });
    const app = await s.boot([Natural], {
      sessionTimeoutMs: 6_000,
      config: { consumer_handler_timeout_ms: 8_000 },
    });
    const consumer = app.get(Natural);
    const hung = s.ItemChanged.create(uuidv7(), 1, { name: 'hangs' });
    consumer.probe.gate = (events) =>
      events.some((e) => e.eventId === hung.eventId)
        ? new Promise(() => undefined)
        : Promise.resolve();
    await kit.awaitMembers(s.kafka, consumer.name, 1);
    const admin = s.kafka.admin();
    await admin.connect();
    const memberBefore = (await admin.describeGroups([consumer.name])).groups[0]
      .members[0].memberId;

    await s.publish([hung]);

    await waitFor(
      async () => consumer.probe.invocationsOf(hung.eventId) === 1,
      { description: 'handler hangs' },
    );
    await waitFor(
      async () => consumer.probe.invocationsOf(hung.eventId) === 2,
      { description: 'timeout, then the second attempt', timeoutMs: 30_000 },
    );
    await waitFor(async () => (await dlq(consumer.name)).length === 1, {
      description: 'second timeout dead-letters',
      timeoutMs: 30_000,
    });
    expect((await dlq(consumer.name))[0].headers).toMatchObject({
      'x-dlq-reason-code': 'HANDLER_FAILED',
      'x-attempts': '2',
    });
    expect((await dlq(consumer.name))[0].headers['x-dlq-reason']).toContain(
      'HandlerTimeoutError',
    );
    const group = (await admin.describeGroups([consumer.name])).groups[0];
    await admin.disconnect();
    expect(group.members).toHaveLength(1);
    expect(group.members[0].memberId).toBe(memberBefore); // no eviction, no rebalance caused by the hang
  }, 90_000);
});

/** The dead-letter record with its key and value as bytes. */
async function rawDlq(
  kafka: ReturnType<typeof import('@app/test/utils/kafka-test').testKafka>,
  consumer: string,
) {
  const reader = kafka.consumer({ groupId: `raw-${uuidv7()}` });
  await reader.connect();
  await reader.subscribe({ topic: `${consumer}.dlq`, fromBeginning: true });
  const found = new Promise<{ key: Buffer | null; value: Buffer | null }>(
    (resolve) => {
      void reader.run({
        eachMessage: async ({ message }) =>
          resolve({ key: message.key, value: message.value }),
      });
    },
  );
  const record = await found;
  await reader.disconnect();
  return record;
}

export type { ConsumerProbe };

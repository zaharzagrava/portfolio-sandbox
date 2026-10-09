import { INestApplication, Global, Logger, Module } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { CLOCK, FakeClock } from '@app/common/core/clock';
import { ApiConfigService } from '@app/common/config';
import { MockApiConfigService } from '@app/common/config/api-config.service.mock';
import { generateTestingModule } from '@app/test/utils/global-modules';
import {
  createTopics,
  deleteTopicsMatching,
  readTopic,
} from '@app/test/utils/kafka-test';
import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';
import {
  defineEvent,
  useEventClock,
} from '@app/infrastructure/events/define-event';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { EventsModule } from '@app/infrastructure/events/events.module';
import { TopicRegistry } from '@app/infrastructure/events/topic-registry';
import { KAFKA_CLIENT_OVERRIDES } from '@app/infrastructure/kafka/kafka-client.options';
import { installTestTracing } from '@app/infrastructure/events/testing/test-tracing';
import { OutboxService } from './outbox.service';
import { OutboxPublisherModule } from './outbox-publisher.module';
import { OutboxPublisherService } from './outbox-publisher.service';
import { RELAY_RANDOM } from './relay-random';

const runId = uuidv7().slice(-8);
const AGG = `rly${runId}`;
const BIG_AGG = `rlybig${runId}`;
const clock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));
let nextRandom = 0.5;

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: clock }],
  exports: [CLOCK],
})
class TestClockModule {}

const Changed = defineEvent(
  `${AGG}.item_changed`,
  AGG,
  1,
  z.object({ name: z.string() }),
);
const Big = defineEvent(
  `${BIG_AGG}.blob`,
  BIG_AGG,
  1,
  z.object({ blob: z.string() }),
);

describe('Outbox relay (poller) publishing to the log', () => {
  let app: INestApplication;
  let proxy: TcpFaultProxy;
  let sequelize: Sequelize;
  let outbox: OutboxService;
  let relay: OutboxPublisherService;
  let config: MockApiConfigService;
  const tracing = installTestTracing();

  /** One application instance of the relay (a "process"); the proxy sits between it and the broker. */
  const boot = async (): Promise<INestApplication> => {
    const moduleRef = await generateTestingModule(
      [
        TestClockModule,
        EventsModule,
        OutboxPublisherModule.register({ ticker: false }),
      ],
      {
        customize: (b) =>
          b
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(KAFKA_CLIENT_OVERRIDES)
            .useValue({ socketFactory: proxy.kafkaSocketFactory() })
            .overrideProvider(RELAY_RANDOM)
            .useValue(() => nextRandom),
      },
    );
    const instance = moduleRef.createNestApplication();
    await instance.init();
    return instance;
  };

  beforeAll(async () => {
    proxy = await TcpFaultProxy.start({ host: 'localhost', port: 9192 });
    await createTopics([
      { topic: `${AGG}.events` },
      {
        topic: `${BIG_AGG}.events`,
        configEntries: [{ name: 'max.message.bytes', value: '2000' }],
      },
    ]);
    app = await boot();
    useEventClock(clock);
    sequelize = app.get(Sequelize);
    outbox = app.get(OutboxService);
    relay = app.get(OutboxPublisherService);
    config = app.get(ApiConfigService) as MockApiConfigService;
    const topics = app.get(TopicRegistry);
    topics.register({ aggregateType: AGG, retention: 'full-history' });
    topics.register({ aggregateType: BIG_AGG, retention: 'full-history' });
  });

  afterAll(async () => {
    await app.close();
    await proxy.close();
    await tracing.shutdown();
    await deleteTopicsMatching(new RegExp(runId));
  });

  beforeEach(async () => {
    proxy.mode = 'pass';
    proxy.delayMs = 0;
    nextRandom = 0.5;
    clock.set(new Date('2026-10-09T10:00:00.000Z'));
    await sequelize.query(`DELETE FROM "Outbox" WHERE "topic" LIKE 'rly%'`);
    config.set('outbox_relay_batch', 100);
    config.set('outbox_relay_max_attempts', 10);
  });

  type Row = {
    id: string;
    status: string;
    attempts: number;
    nextAttemptAt: Date;
    leaseUntil: Date | null;
    publishedAt: Date | null;
    parkedReason: string | null;
    aggregateId: string;
    payload: EventEnvelope;
  };
  const rows = async (aggregateIds: string[]): Promise<Row[]> => {
    const [r] = await sequelize.query(
      `SELECT * FROM "Outbox" WHERE "aggregateId" = ANY($1) ORDER BY "id"`,
      { bind: [aggregateIds] },
    );
    return r as Row[];
  };
  const onLog = async (aggregateIds: string[]) =>
    (await readTopic(`${AGG}.events`)).filter((m) =>
      aggregateIds.includes(m.key ?? ''),
    );
  const append = async (
    aggregateId: string,
    version: number,
    name = `n${version}`,
  ) => {
    const event = Changed.create(aggregateId, version, { name });
    await outbox.appendStandalone(event);
    return event;
  };

  it('S53 AS-13: each message is on the row topic, keyed by aggregateId, value = the envelope, headers set, row marked published', async () => {
    const [a, b] = [uuidv7(), uuidv7()];
    const events = await tracing.tracer.startActiveSpan('t', async (span) => {
      const list = [await append(a, 1), await append(a, 2), await append(b, 1)];
      span.end();
      return list;
    });

    const result = await relay.drain();

    expect(result).toMatchObject({ claimed: 3, published: 3, failed: 0 });
    const log = await onLog([a, b]);
    expect(log).toHaveLength(3);
    for (const event of events) {
      const message = log.find(
        (m) => m.json<EventEnvelope>().eventId === event.eventId,
      )!;
      expect(message.key).toBe(event.aggregateId);
      // the value is the envelope itself (no wrapper); jsonb keeps no key order, so compare as JSON
      expect(message.json()).toEqual(event);
      expect(message.headers).toEqual({
        eventId: event.eventId,
        type: event.type,
        version: '1',
        traceparent: event.traceparent!,
      });
    }
    const persisted = await rows([a, b]);
    expect(persisted.every((r) => r.status === 'published')).toBe(true);
    expect(
      persisted.every((r) => r.publishedAt !== null && r.leaseUntil === null),
    ).toBe(true);
    // Order on the log per key.
    expect(
      log
        .filter((m) => m.key === a)
        .map((m) => m.json<EventEnvelope>().aggregateVersion),
    ).toEqual([1, 2]);
  });

  it('S53 AS-13: a message without a trace context carries no traceparent header', async () => {
    const a = uuidv7();
    const event = await append(a, 1);
    await relay.drain();
    const [message] = await onLog([a]);
    expect(message.json()).toEqual(event);
    expect(Object.keys(message.headers).sort()).toEqual([
      'eventId',
      'type',
      'version',
    ]);
  });

  it('S53 AS-14: with the broker unreachable both rows stay pending with attempts 1 and a full-jitter delay; after recovery each is published once', async () => {
    const [a, b] = [uuidv7(), uuidv7()];
    await append(a, 1);
    await append(b, 1);
    proxy.mode = 'refuse';
    proxy.sever();
    nextRandom = 0.5;

    const result = await relay.drain();

    expect(result).toMatchObject({ claimed: 2, published: 0, failed: 2 });
    const failed = await rows([a, b]);
    for (const row of failed) {
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
      expect(row.leaseUntil).toBeNull();
      // full jitter: floor(0.5 x min(60 s, 1 s x 2^1)) = 1000 ms
      expect(new Date(row.nextAttemptAt).getTime() - clock.nowMs()).toBe(1_000);
    }
    expect(await onLog([a, b])).toHaveLength(0);

    proxy.mode = 'pass';
    clock.advance(1_000);
    const recovered = await relay.drain();

    expect(recovered).toMatchObject({ claimed: 2, published: 2, failed: 0 });
    expect(await onLog([a, b])).toHaveLength(2);
    expect((await rows([a, b])).every((r) => r.status === 'published')).toBe(
      true,
    );
  });

  it('S53 AS-14: the delay window follows min(60 s, 1 s x 2^attempts) at the extremes of the jitter', async () => {
    const a = uuidv7();
    await append(a, 1);
    proxy.mode = 'refuse';
    proxy.sever();
    nextRandom = 0.999999;
    await relay.drain();
    const [first] = await rows([a]);
    expect(new Date(first.nextAttemptAt).getTime() - clock.nowMs()).toBe(1_999);

    clock.advance(2_000);
    nextRandom = 0;
    await relay.drain();
    const [second] = await rows([a]);
    expect(second.attempts).toBe(2);
    expect(new Date(second.nextAttemptAt).getTime() - clock.nowMs()).toBe(0);
  });

  it('S53 AS-15: a crash between send and mark yields two messages with the same eventId, key and partition, and the row ends published', async () => {
    const a = uuidv7();
    const event = await append(a, 1);
    await sequelize.query(`
      CREATE OR REPLACE FUNCTION s53_block_publish() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 's53 simulated crash before mark'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER s53_block_publish BEFORE UPDATE OF "status" ON "Outbox"
        FOR EACH ROW WHEN (NEW."status" = 'published' AND NEW."aggregateId" = '${a}')
        EXECUTE FUNCTION s53_block_publish();`);
    try {
      const crashed = await relay.drain();
      expect(crashed).toMatchObject({ claimed: 1, published: 0 });
    } finally {
      await sequelize.query(
        `DROP TRIGGER IF EXISTS s53_block_publish ON "Outbox"`,
      );
    }
    expect((await rows([a]))[0].status).toBe('pending');
    expect(await onLog([a])).toHaveLength(1);

    clock.advance(31_000); // lease over
    const again = await relay.drain();

    expect(again).toMatchObject({ claimed: 1, published: 1 });
    const log = await onLog([a]);
    expect(log).toHaveLength(2);
    expect(log.map((m) => m.json<EventEnvelope>().eventId)).toEqual([
      event.eventId,
      event.eventId,
    ]);
    expect(new Set(log.map((m) => m.key)).size).toBe(1);
    expect(new Set(log.map((m) => m.partition)).size).toBe(1);
    expect((await rows([a]))[0].status).toBe('published');
  });

  it('S53 AS-16: two relays draining at once claim each row exactly once; the log holds 100 messages and no duplicate eventId', async () => {
    const ids = Array.from({ length: 100 }, () => uuidv7());
    for (const id of ids) await append(id, 1);
    config.set('outbox_relay_batch', 60);
    const app2 = await boot();
    const second = app2.get(OutboxPublisherService);
    (app2.get(ApiConfigService) as MockApiConfigService).set(
      'outbox_relay_batch',
      60,
    );

    const [r1, r2] = await Promise.all([relay.drain(), second.drain()]);

    // no row was claimed twice: the two claims add up to at most the 100 rows (and at least one full batch)
    expect(r1.claimed + r2.claimed).toBeLessThanOrEqual(100);
    expect(r1.claimed + r2.claimed).toBeGreaterThanOrEqual(60);
    // whatever is left after the first round is published by a follow-up drain
    await relay.drain();
    await second.drain();
    await app2.close();
    const log = await onLog(ids);
    expect(log).toHaveLength(100);
    expect(new Set(log.map((m) => m.json<EventEnvelope>().eventId)).size).toBe(
      100,
    );
    expect((await rows(ids)).every((r) => r.status === 'published')).toBe(true);
  });

  it('S53 AS-17: a failing A1 holds A2 and A3 in that drain while B1 is published; later A1, A2, A3 follow in order', async () => {
    await append(uuidv7(), 1);
    await relay.drain(); // connects the producer, so the next request is the produce request
    const [c, d] = [uuidv7(), uuidv7()];
    await append(c, 1);
    await append(c, 2);
    await append(c, 3);
    await append(d, 1);
    proxy.failNextRequests(1, 'close'); // the first produce request (C's group) dies

    const result = await relay.drain();

    expect(result).toMatchObject({
      claimed: 4,
      published: 1,
      failed: 1,
      held: 2,
    });
    const during = await rows([c, d]);
    const byAgg = (agg: string) => during.filter((r) => r.aggregateId === agg);
    expect(byAgg(d)[0].status).toBe('published');
    expect(byAgg(c).map((r) => r.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(byAgg(c).map((r) => r.attempts)).toEqual([1, 0, 0]);
    expect(byAgg(c).every((r) => r.leaseUntil === null)).toBe(true);
    expect((await onLog([c])).length).toBe(0);

    clock.advance(2_000);
    const next = await relay.drain();

    expect(next).toMatchObject({ claimed: 3, published: 3 });
    const log = await onLog([c]);
    expect(log.map((m) => m.json<EventEnvelope>().aggregateVersion)).toEqual([
      1, 2, 3,
    ]);
  });

  it('S53 AS-17: while A1 waits out its backoff, a due A2 of the same aggregate is not claimed', async () => {
    const a = uuidv7();
    await append(a, 1);
    proxy.mode = 'refuse';
    proxy.sever();
    await relay.drain(); // A1 fails, backoff 1 s
    proxy.mode = 'pass';
    await append(a, 2); // due now, but behind A1

    const result = await relay.drain();

    expect(result.claimed).toBe(0);
    expect(await onLog([a])).toHaveLength(0);
  });

  it('S53 AS-18: a row that fails ten times is parked, logged once without payload, stops blocking its aggregate and can be requeued', async () => {
    const a = uuidv7();
    const first = await append(a, 1, 'secret-name-xyz');
    await append(a, 2);
    proxy.mode = 'refuse';
    proxy.sever();
    const lines: string[] = [];
    const errorLines: string[] = [];
    Logger.overrideLogger({
      log: (m: string) => lines.push(String(m)),
      warn: (m: string) => lines.push(String(m)),
      error: (m: string) => {
        lines.push(String(m));
        errorLines.push(String(m));
      },
      debug: () => undefined,
      verbose: () => undefined,
      fatal: (m: string) => lines.push(String(m)),
    } as never);
    try {
      for (let i = 0; i < 10; i++) {
        await relay.drain();
        clock.advance(61_000);
      }
    } finally {
      Logger.overrideLogger(['fatal']);
    }

    const [a1, a2] = await rows([a]);
    expect(a1).toMatchObject({
      status: 'parked',
      attempts: 10,
      parkedReason: 'MAX_ATTEMPTS',
    });
    expect(a2.status).toBe('pending');
    // one error-level line names the row and the error class; the nine retries before it are warnings
    const parkedLines = errorLines.filter((l) => l.includes(a1.id));
    expect(parkedLines).toHaveLength(1);
    expect(parkedLines[0]).toMatch(
      /parked reasonCode=MAX_ATTEMPTS topic=\S+ attempts=10 error=KafkaJS\w+/,
    );
    expect(lines.join('\n')).not.toContain('secret-name-xyz');
    expect(lines.join('\n')).not.toContain(first.eventId);

    // a parked row no longer blocks: A2 goes out once the broker is back
    proxy.mode = 'pass';
    const result = await relay.drain();
    expect(result).toMatchObject({ claimed: 1, published: 1 });
    expect((await rows([a]))[1].status).toBe('published');
    // and a parked row gets no further attempts
    expect((await rows([a]))[0]).toMatchObject({
      status: 'parked',
      attempts: 10,
    });

    expect(await outbox.requeueParked(a1.id)).toBe(1);
    expect((await rows([a]))[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      parkedReason: null,
    });
    await relay.drain();
    expect((await rows([a]))[0].status).toBe('published');
  });

  it('S53 AS-19: a message the broker rejects as too large is parked at once as NON_RETRYABLE, a connection reset is not', async () => {
    const big = uuidv7();
    const ok = uuidv7();
    await outbox.appendStandalone(
      Big.create(big, 1, { blob: 'x'.repeat(10_000) }),
    );
    await append(ok, 1);

    const result = await relay.drain();

    const [row] = await rows([big]);
    expect(row).toMatchObject({
      status: 'parked',
      attempts: 1,
      parkedReason: 'NON_RETRYABLE',
    });
    expect(result).toMatchObject({ claimed: 2, published: 1, parked: 1 });
    expect((await rows([ok]))[0].status).toBe('published');
    expect(
      await readTopic(`${BIG_AGG}.events`).then((m) =>
        m.filter((x) => x.key === big),
      ),
    ).toHaveLength(0);
  });

  it('S53 AS-20: rows claimed by a crashed relay are invisible for 29 s and claimable again after 31 s', async () => {
    const ids = Array.from({ length: 50 }, () => uuidv7());
    for (const id of ids) await append(id, 1);
    const claimed = await relay.claim();
    expect(claimed).toHaveLength(50); // …and the relay crashes before publishing

    clock.advance(29_000);
    const early = await relay.drain();
    expect(early.claimed).toBe(0);
    expect(await onLog(ids)).toHaveLength(0);

    clock.advance(2_000);
    const late = await relay.drain();
    expect(late).toMatchObject({ claimed: 50, published: 50 });
    expect(await onLog(ids)).toHaveLength(50);
  });

  it('S53 AS-23: in poller mode exactly one ticker runs per process; cdc mode starts none', async () => {
    expect(relay.isTicking()).toBe(false);
    expect(relay.startTicker()).toBe(true);
    expect(relay.isTicking()).toBe(true);
    expect(relay.startTicker()).toBe(false); // already running
    relay.stopTicker();
    expect(relay.isTicking()).toBe(false);

    config.set('outbox_relay', 'cdc');
    try {
      expect(relay.startTicker()).toBe(false);
    } finally {
      config.set('outbox_relay', 'poller');
    }
  });

  it('S53 AS-13: the row model is untouched by the relay beyond status, attempts, lease and publish time', async () => {
    const a = uuidv7();
    const event = await append(a, 1);
    await relay.drain();
    const [row] = await rows([a]);
    expect(row.payload).toEqual(event);
    const [{ topic, type, kind }] = (
      await sequelize.query(
        `SELECT "topic", "type", "kind" FROM "Outbox" WHERE "aggregateId" = $1`,
        { bind: [a] },
      )
    )[0] as { topic: string; type: string; kind: string }[];
    expect({ topic, type, kind }).toEqual({
      topic: `${AGG}.events`,
      type: event.type,
      kind: 'event',
    });
  });
});

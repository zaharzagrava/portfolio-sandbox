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
import { defineEvent, useEventClock } from '../define-event';
import type { EventEnvelope } from '../event-envelope';
import {
  KAFKA_CLIENT_OVERRIDES,
  KAFKA_CONSUMER_OVERRIDES,
} from '@app/infrastructure/kafka/kafka-client.options';
import { ProjectionsModule } from '@app/infrastructure/projections/projections.module';
import type { Projector } from '@app/infrastructure/projections/projector';
import { fixtureConsumer, type ConsumerProbe } from './fixture-consumers';

export type Consumer = Projector & { probe: ConsumerProbe };

export const kitClock = new FakeClock(new Date('2026-10-09T10:00:00.000Z'));

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: kitClock }],
  exports: [CLOCK],
})
class KitClockModule {}

export interface BootOptions {
  /** Route the consumers' connections through the fault proxy. */
  consumerProxy?: boolean;
  /** Route the producers' connections (dead letters, redrive) through the fault proxy. */
  producerProxy?: boolean;
  sessionTimeoutMs?: number;
  /** Extra settings applied before the application starts. */
  config?: Record<string, number | string>;
  /** Extra modules the consumers inject. */
  imports?: unknown[];
}

/**
 * Test scaffolding for the consumer-framework specs (S53 test plan): an isolated scenario per test (its own
 * aggregate type, topic, event definitions and consumer groups), real Redpanda, Postgres and Redis, a fault proxy
 * in front of the broker, and readers for the persisted state (effects, inbox records, documents, metrics, offsets).
 */
export class ConsumerKit {
  proxy!: TcpFaultProxy;
  sequelize!: Sequelize;
  private readonly apps: INestApplication[] = [];

  async start(): Promise<void> {
    this.proxy = await TcpFaultProxy.start({ host: 'localhost', port: 9192 });
  }

  async stopAll(): Promise<void> {
    for (const app of this.apps.splice(0)) await app.close();
    await this.proxy.close();
    // The scenarios' topics and dead-letter topics go with them: the test broker caps its total partitions.
    if (this.scenarioIds.length > 0)
      await deleteTopicsMatching(new RegExp(this.scenarioIds.join('|')));
  }

  private readonly scenarioIds: string[] = [];

  resetProxy(): void {
    this.proxy.mode = 'pass';
    this.proxy.delayMs = 0;
  }

  async scenario(partitions = 1) {
    const id = uuidv7().slice(-8);
    this.scenarioIds.push(id);
    const agg = `kit${id}`;
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
    /** Raw bytes, exactly as given (malformed messages, tombstones). */
    const publishRaw = async (
      messages: {
        key?: Buffer | string | null;
        value: Buffer | string | null;
        partition?: number;
        headers?: Record<string, string>;
      }[],
    ) => producer.send({ topic, messages });
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
      consumers: Type<Projector>[],
      options: BootOptions = {},
    ) => {
      const moduleRef = await generateTestingModule(
        [
          KitClockModule,
          ProjectionsModule.forProjectors(
            consumers,
            (options.imports ?? []) as never[],
          ),
        ],
        {
          stores: ['redis'],
          customize: (b) => {
            let builder = b.overrideProvider(CLOCK).useValue(kitClock);
            if (options.consumerProxy)
              builder = builder
                .overrideProvider(KAFKA_CONSUMER_OVERRIDES)
                .useValue({ socketFactory: this.proxy.kafkaSocketFactory() });
            if (options.producerProxy)
              builder = builder
                .overrideProvider(KAFKA_CLIENT_OVERRIDES)
                .useValue({ socketFactory: this.proxy.kafkaSocketFactory() });
            return builder;
          },
        },
      );
      const app = moduleRef.createNestApplication();
      const config = app.get<ApiConfigService, MockApiConfigService>(
        ApiConfigService,
      );
      config.set('consumer_backoff_min_ms', 10);
      config.set('consumer_backoff_max_ms', 50);
      if (options.sessionTimeoutMs)
        config.set('consumer_session_timeout_ms', options.sessionTimeoutMs);
      for (const [key, value] of Object.entries(options.config ?? {}))
        config.set(key as never, value);
      await app.init();
      this.apps.push(app);
      useEventClock(kitClock);
      this.sequelize = app.get(Sequelize);
      return app;
    };
    const stop = async (app: INestApplication) => {
      this.apps.splice(this.apps.indexOf(app), 1);
      await app.close();
    };
    return {
      id,
      agg,
      topic,
      ItemChanged,
      ItemDeleted,
      publish,
      publishRaw,
      make,
      boot,
      stop,
      kafka,
    };
  }

  count = async (sql: string, ...bind: unknown[]): Promise<number> =>
    Number(
      ((await this.sequelize.query(sql, { bind }))[0] as { n: string }[])[0].n,
    );

  effects = (consumer: string) =>
    this.count(
      `SELECT count(*) AS n FROM "S53FixtureEffect" WHERE "consumer" = $1`,
      consumer,
    );

  inboxRecords = (consumer: string) =>
    this.count(
      `SELECT count(*) AS n FROM "ProcessedWebhookEvent" WHERE "provider" = $1`,
      consumer,
    );

  naturalRows = (consumer: string) =>
    this.count(
      `SELECT count(*) AS n FROM "S53FixtureNatural" WHERE "consumer" = $1`,
      consumer,
    );

  doc = async (consumer: string, aggregateId: string) =>
    (
      (
        await this.sequelize.query(
          `SELECT "version", "name", "deleted" FROM "S53FixtureDoc" WHERE "consumer" = $1 AND "aggregateId" = $2`,
          { bind: [consumer, aggregateId] },
        )
      )[0] as { version: string; name: string; deleted: boolean }[]
    )[0];

  metric = (consumer: string, outcome: string): number =>
    MetricsRegistry.value('consumer_events_total', { consumer, outcome }) ?? 0;

  /** Committed offset per partition of a group (the offset of the next message it will read). */
  async committed(
    kafka: ReturnType<typeof testKafka>,
    group: string,
    topic: string,
  ): Promise<number[]> {
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
  }

  /** Waits until the group is stable with `members` members. */
  awaitMembers(
    kafka: ReturnType<typeof testKafka>,
    group: string,
    members: number,
  ) {
    return waitFor(
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
  }
}

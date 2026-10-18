import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  consumerReplaySchema,
  type ConsumerView,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { sleep } from '@app/common/core/backoff';
import { CLOCK, Clock, SystemClock } from '@app/common/core/clock';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CONSUMER_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { aliasesOf, membersOf, queueOf } from './consumer-groups';
import { ConsumerLag, UnknownConsumerGroupError } from './consumer-lag';
import { ConsumerPauseFlags } from './consumer-pause';
import { deadLetterTopic } from './dead-letter';
import { NotReplayableError } from './projection-admin.service';
import { ProjectionRegistry } from './projection-registry';
import { RedriveService } from './redrive.service';

export class ConsumerNotFoundError extends Error {
  constructor(readonly group: string) {
    super(`Consumer group "${group}" is not known`);
    this.name = 'ConsumerNotFoundError';
  }
}

export class InvalidReplaySinceError extends Error {
  constructor(readonly reason: 'malformed' | 'future') {
    super(`replay "since" is ${reason}`);
    this.name = 'InvalidReplaySinceError';
  }
}

export { NotReplayableError };

const dlqDepthGauge = MetricsRegistry.gauge({
  name: 'consumer_dlq_depth',
  help: 'Dead letters of a consumer group not yet redriven',
  labels: ['group'],
});

const SAMPLE_EVERY_MS = 30_000;
const REPLAY_WAIT_MS = 60_000;

interface Resolved {
  group: string;
  /** The real Kafka groups: the group itself, or the groups a canonical alias stands for. */
  members: string[];
  topics: string[];
  topicsOf: Map<string, string[]>;
  replayable: Map<string, boolean>;
}

/**
 * Operator view and control of consumer groups (S53 R-21 to R-24): state, lag, last processed time, dead-letter depth,
 * pause and resume (one Redis flag every process obeys), replay from a point in time and dead-letter redrive.
 * A group is addressed by its declared name or by a canonical journey name (`consumer-groups.ts`).
 */
@Injectable()
export class ConsumerAdminService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConsumerAdminService.name);
  private sampler?: NodeJS.Timeout;
  private readonly replays = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly config: ApiConfigService,
    private readonly flags: ConsumerPauseFlags,
    private readonly registry: ProjectionRegistry,
    private readonly lag: ConsumerLag,
    private readonly redriver: RedriveService,
    @Optional()
    @Inject(CLOCK)
    private readonly clock: Clock = new SystemClock(),
    @Optional()
    @Inject(KAFKA_CONSUMER_OVERRIDES)
    private readonly overrides: KafkaClientOverrides = {},
    @Optional() private readonly queues?: TaskQueue,
  ) {}

  onModuleInit(): void {
    // The gauge feeds the `ConsumerDlqNotEmpty` alert: it is refreshed even when nobody calls the route.
    this.sampler = setInterval(() => void this.sample(), SAMPLE_EVERY_MS);
    this.sampler.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.sampler) clearInterval(this.sampler);
    await Promise.allSettled([...this.replays]);
  }

  async view(group: string): Promise<ConsumerView> {
    const resolved = await this.resolve(group);
    const depths = await this.dlqDepths(resolved.members);
    const dlqDepth = [...depths.values()].reduce((a, b) => a + b, 0);
    dlqDepthGauge.set(dlqDepth, { group });
    let lag = 0;
    for (const member of resolved.members)
      lag += await this.lagOf(member, resolved.topicsOf.get(member) ?? []);
    // A queue consumer (the booking voucher): the lag is what waits in its queue, visible and not yet received.
    const queue = queueOf(group);
    if (queue && this.queues) lag += await this.queues.queueDepth(queue);
    return {
      group,
      topics: resolved.topics,
      state: (await this.flags.isPaused([group, ...aliasesOf(group)]))
        ? 'PAUSED'
        : 'RUNNING',
      lag,
      lastProcessedAt: await this.flags.lastProcessed(resolved.members),
      dlqDepth,
    };
  }

  /** Idempotent: pausing a paused group leaves the first flag (and its author) in place. */
  async pause(group: string, by: string): Promise<ConsumerView> {
    await this.resolve(group);
    await this.flags.pause(group, by, this.nowIso());
    return this.view(group);
  }

  async resume(group: string): Promise<ConsumerView> {
    await this.resolve(group);
    await this.flags.resume(group);
    return this.view(group);
  }

  /**
   * Pauses the group, has each partition moved to the first offset at or after `since`, then resumes it. The move is
   * done by the runner that owns the partition (a group with live members cannot be rewound from outside), or here
   * when the group has no members. Returns once the request is recorded; completion is observable as state RUNNING.
   */
  async replay(group: string, since: string, by: string): Promise<void> {
    const parsed = consumerReplaySchema.safeParse({ since });
    if (!parsed.success) throw new InvalidReplaySinceError('malformed');
    const sinceMs = Date.parse(parsed.data.since);
    if (sinceMs > this.clock.nowMs())
      throw new InvalidReplaySinceError('future');
    const resolved = await this.resolve(group);
    for (const member of resolved.members)
      if (resolved.replayable.get(member) === false)
        throw new NotReplayableError(member);

    await this.flags.pause(group, by, this.nowIso());
    const admin = createKafka(
      this.config,
      'consumer-admin',
      this.overrides,
    ).admin();
    await admin.connect();
    try {
      for (const member of resolved.members) {
        const topics = resolved.topicsOf.get(member) ?? [];
        const targets: Record<string, number> = {};
        const partitions: {
          topic: string;
          partition: number;
          offset: string;
        }[] = [];
        for (const topic of topics) {
          const high = new Map(
            (await admin.fetchTopicOffsets(topic)).map((o) => [
              o.partition,
              Number(o.high),
            ]),
          );
          for (const found of await admin.fetchTopicOffsetsByTimestamp(
            topic,
            sinceMs,
          )) {
            // No message at or after `since`: nothing to replay on this partition.
            const offset =
              Number(found.offset) < 0
                ? (high.get(found.partition) ?? 0)
                : Number(found.offset);
            targets[`${topic}|${found.partition}`] = offset;
            partitions.push({
              topic,
              partition: found.partition,
              offset: String(offset),
            });
          }
        }
        const [description] = (await admin.describeGroups([member])).groups;
        if (description.members.length === 0) {
          for (const topic of topics)
            await admin.setOffsets({
              groupId: member,
              topic,
              partitions: partitions
                .filter((p) => p.topic === topic)
                .map(({ partition, offset }) => ({ partition, offset })),
            });
        } else await this.flags.setReplay(member, targets);
      }
    } finally {
      await admin.disconnect();
    }
    const done = this.finishReplay(group, resolved.members).finally(() =>
      this.replays.delete(done),
    );
    this.replays.add(done);
  }

  /** Re-queues dead letters of the group (or of each member of an alias) to their source topics. */
  async redrive(group: string, limit?: number): Promise<{ requeued: number }> {
    const resolved = await this.resolve(group);
    let requeued = 0;
    for (const member of resolved.members) {
      const remaining = limit === undefined ? undefined : limit - requeued;
      if (remaining !== undefined && remaining <= 0) break;
      const result = await this.redriver.redrive(member, {
        limit: remaining,
      });
      requeued += result.redriven;
    }
    const depths = await this.dlqDepths(resolved.members);
    dlqDepthGauge.set(
      [...depths.values()].reduce((a, b) => a + b, 0),
      {
        group,
      },
    );
    return { requeued };
  }

  private async finishReplay(group: string, members: string[]): Promise<void> {
    try {
      for (
        let waited = 0;
        waited < REPLAY_WAIT_MS && !this.stopped;
        waited += 200
      ) {
        const pending = await Promise.all(
          members.map((m) => this.flags.pendingReplay(m)),
        );
        if (pending.every((p) => Object.keys(p).length === 0)) {
          await this.flags.resume(group);
          return;
        }
        await sleep(200);
      }
      // Left paused on purpose: a replay no runner applied must not silently resume from the old position.
      this.logger.error(
        `replay of ${group} was not applied; group left paused`,
      );
    } catch (error) {
      this.logger.error(
        `replay of ${group} failed: ${(error as Error).message}`,
      );
    }
  }

  private async resolve(group: string): Promise<Resolved> {
    const declared = await this.registry.all();
    const names = declared.map((d) => d.name);
    const members =
      membersOf(group, names) ?? (names.includes(group) ? [group] : null);
    if (!members) throw new ConsumerNotFoundError(group);
    const topicsOf = new Map<string, string[]>();
    const replayable = new Map<string, boolean>();
    for (const d of declared)
      if (members.includes(d.name)) {
        topicsOf.set(d.name, d.topics);
        replayable.set(d.name, d.replayable);
      }
    return {
      group,
      members,
      topics: [...new Set([...topicsOf.values()].flat())],
      topicsOf,
      replayable,
    };
  }

  private async lagOf(member: string, topics: string[]): Promise<number> {
    if (topics.length === 0) return 0;
    try {
      return (await this.lag.read(member, { topics })).totalLag;
    } catch (error) {
      if (error instanceof UnknownConsumerGroupError) return 0;
      throw error;
    }
  }

  /** Dead letters not yet redriven, per real group: end of `<group>.dlq` against the `<group>.redrive` position. */
  private async dlqDepths(members: string[]): Promise<Map<string, number>> {
    const depths = new Map<string, number>();
    if (members.length === 0) return depths;
    const admin = createKafka(
      this.config,
      'consumer-admin',
      this.overrides,
    ).admin();
    await admin.connect();
    try {
      const existing = new Set(await admin.listTopics());
      for (const member of members) {
        const topic = deadLetterTopic(member);
        if (!existing.has(topic)) {
          depths.set(member, 0);
          continue;
        }
        const ends = await admin.fetchTopicOffsets(topic);
        const [committed] = await admin.fetchOffsets({
          groupId: `${member}.redrive`,
          topics: [topic],
        });
        let depth = 0;
        for (const end of ends) {
          const done = Number(
            committed?.partitions.find((p) => p.partition === end.partition)
              ?.offset ?? -1,
          );
          depth += Math.max(
            0,
            Number(end.high) - (done < 0 ? Number(end.low) : done),
          );
        }
        depths.set(member, depth);
      }
      return depths;
    } finally {
      await admin.disconnect();
    }
  }

  private async sample(): Promise<void> {
    try {
      const names = (await this.registry.all()).map((d) => d.name);
      for (const [member, depth] of await this.dlqDepths(names))
        dlqDepthGauge.set(depth, { group: member });
    } catch (error) {
      this.logger.warn(
        `consumer_dlq_depth sampling failed (${(error as Error).name})`,
      );
    }
  }

  private nowIso(): string {
    return new Date(this.clock.nowMs()).toISOString();
  }
}

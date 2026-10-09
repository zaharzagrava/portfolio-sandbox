import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigResourceTypes } from 'kafkajs';
import { ApiConfigService } from '@app/common/config';
import { createKafka } from '@app/infrastructure/kafka/kafka-client.factory';
import {
  KAFKA_CONSUMER_OVERRIDES,
  type KafkaClientOverrides,
} from '@app/infrastructure/kafka/kafka-client.options';
import { ConsumerLag } from './consumer-lag';
import { ProjectionActivation } from './projection-activation';
import { ProjectionRegistry } from './projection-registry';

/** Operator-facing refusals: each carries the code the CLI prints and exits non-zero with. */
abstract class AdminRefusal extends Error {
  abstract readonly code: string;
}
export class GroupActiveError extends AdminRefusal {
  readonly code = 'GROUP_ACTIVE';
  constructor(group: string) {
    super(
      `GROUP_ACTIVE: consumer group "${group}" has live members; stop it before rewinding its offsets`,
    );
    this.name = 'GroupActiveError';
  }
}
export class NotReplayableError extends AdminRefusal {
  readonly code = 'NOT_REPLAYABLE';
  constructor(consumer: string) {
    super(
      `NOT_REPLAYABLE: "${consumer}" has side effects (replayable: false); rewinding it needs --allow-side-effects and a --reason`,
    );
    this.name = 'NotReplayableError';
  }
}
export class HistoryTruncatedError extends AdminRefusal {
  readonly code = 'HISTORY_TRUNCATED';
  constructor(topic: string, earliest: number) {
    super(
      `HISTORY_TRUNCATED: topic "${topic}" no longer holds its first events (earliest retained offset ${earliest}) and is not compacted; use --from-retained to rebuild from what is left`,
    );
    this.name = 'HistoryTruncatedError';
  }
}
export class NotCaughtUpError extends AdminRefusal {
  readonly code = 'NOT_CAUGHT_UP';
  constructor(detail: string) {
    super(`NOT_CAUGHT_UP: ${detail}`);
    this.name = 'NotCaughtUpError';
  }
}

export interface RebuildOptions {
  consumer: string;
  /** Defaults to the topics the consumer declared. */
  topics?: string[];
  /** Required together with `reason` to rewind a consumer declared `replayable: false`. */
  allowSideEffects?: boolean;
  reason?: string;
  operator?: string;
  /** Rebuild from the oldest retained offset of a topic whose history is truncated. */
  fromRetained?: boolean;
}

export interface PromoteOptions {
  /** The projection (what reads ask for) and the version label that should become active. */
  name: string;
  label: string;
  /** The consumer group that fills the new version's target. */
  group: string;
  /** Defaults to `projection_promotion_max_lag` (1,000 events). */
  maxLag?: number;
  /** Compares the new target with the source (row counts); false refuses the promotion. */
  verify?: () => Promise<boolean>;
}

/**
 * Operator operations on projections (S53 FR-051 to FR-055): in-place replay (`rebuild`), shadow rebuild promotion
 * (`promote`) and `rollback`. Every refusal is a typed error with a code: the CLI prints it and exits non-zero.
 */
@Injectable()
export class ProjectionAdmin {
  private readonly logger = new Logger(ProjectionAdmin.name);

  constructor(
    private readonly config: ApiConfigService,
    private readonly lag: ConsumerLag,
    private readonly registry: ProjectionRegistry,
    private readonly activation: ProjectionActivation,
    @Optional()
    @Inject(KAFKA_CONSUMER_OVERRIDES)
    private readonly overrides: KafkaClientOverrides = {},
  ) {}

  /**
   * Resets a stopped consumer group to the earliest offset so the consumer re-projects everything (idempotent: sinks
   * skip what they already hold). Refuses a group with live members, a side-effect consumer without the explicit
   * flags (the override is audited), and a topic whose history is gone unless it is compacted or `fromRetained` is set.
   */
  async rebuild(options: RebuildOptions): Promise<{ topics: string[] }> {
    const declaration = await this.registry.get(options.consumer);
    const replayable = declaration?.replayable !== false;
    if (!replayable && !(options.allowSideEffects && options.reason))
      throw new NotReplayableError(options.consumer);

    const admin = createKafka(
      this.config,
      'projection-admin',
      this.overrides,
    ).admin();
    await admin.connect();
    try {
      const [group] = (await admin.describeGroups([options.consumer])).groups;
      if (group.members.length > 0 || !['Empty', 'Dead'].includes(group.state))
        throw new GroupActiveError(options.consumer);

      const topics =
        options.topics ??
        declaration?.topics ??
        (await admin.fetchOffsets({ groupId: options.consumer })).map(
          (t) => t.topic,
        );
      for (const topic of topics) {
        const earliest = (await admin.fetchTopicOffsets(topic)).reduce(
          (min, o) => Math.min(min, Number(o.low)),
          Number.POSITIVE_INFINITY,
        );
        if (
          earliest > 0 &&
          !options.fromRetained &&
          !(await this.compacted(admin, topic))
        )
          throw new HistoryTruncatedError(topic, earliest);
      }

      if (!replayable)
        this.logger.warn(
          JSON.stringify({
            audit: 'projection.rebuild.side_effects',
            consumer: options.consumer,
            reason: options.reason,
            operator: options.operator ?? 'unknown',
          }),
        );
      // Explicit offsets (the oldest retained one per partition) rather than the client's "earliest" sentinel, so
      // every tool that reads the group sees a real position.
      for (const topic of topics)
        await admin.setOffsets({
          groupId: options.consumer,
          topic,
          partitions: (await admin.fetchTopicOffsets(topic)).map((o) => ({
            partition: o.partition,
            offset: o.low,
          })),
        });
      return { topics };
    } finally {
      await admin.disconnect();
    }
  }

  /**
   * Switches reads to a shadow rebuild: refused (`NOT_CAUGHT_UP`) while the new version's lag is above the gate or its
   * verification fails; otherwise one atomic switch. The previous version keeps running, ready for `rollback`.
   */
  async promote(options: PromoteOptions): Promise<void> {
    const maxLag =
      options.maxLag ?? this.config.get('projection_promotion_max_lag');
    const report = await this.lag.read(options.group);
    if (report.totalLag > maxLag)
      throw new NotCaughtUpError(
        `"${options.group}" is ${report.totalLag} events behind (gate ${maxLag})`,
      );
    if (options.verify && !(await options.verify()))
      throw new NotCaughtUpError(
        `verification of "${options.label}" does not match the source`,
      );
    await this.activation.switchTo(options.name, options.label);
  }

  /** Reads use the previous version again; returns its label. */
  rollback(name: string): Promise<string> {
    return this.activation.rollback(name);
  }

  activeLabel(name: string): Promise<string | null> {
    return this.activation.active(name);
  }

  private async compacted(
    admin: ReturnType<ReturnType<typeof createKafka>['admin']>,
    topic: string,
  ): Promise<boolean> {
    const { resources } = await admin.describeConfigs({
      includeSynonyms: false,
      resources: [
        {
          type: ConfigResourceTypes.TOPIC,
          name: topic,
          configNames: ['cleanup.policy'],
        },
      ],
    });
    return resources[0].configEntries.some(
      (e) =>
        e.configName === 'cleanup.policy' && e.configValue.includes('compact'),
    );
  }
}

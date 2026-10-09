import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { DomainTopic, topicFor } from './event-envelope';
import { registeredEventDefinitions } from './define-event';
import {
  DuplicateAggregateTypeError,
  InvalidAggregateTypeError,
  InvalidPartitionCountError,
  TopicPolicyError,
  UnregisteredAggregateTypeError,
} from './topic-errors';

export type TopicRetention = 'full-history' | 'latest-per-key';

export interface TopicRegistration {
  aggregateType: string;
  /** Explicit partition count; otherwise the default (12) or, with `hot`, the hot count (64). */
  partitions?: number;
  hot?: boolean;
  retention: TopicRetention;
}

export interface RegisteredTopic {
  aggregateType: string;
  topic: DomainTopic;
  partitions: number;
  retention: TopicRetention;
  /** Broker topic configuration derived from the retention policy. */
  configEntries: { name: string; value: string }[];
}

export interface TopicDefaults {
  defaultPartitions: number;
  hotPartitions: number;
}

const AGGREGATE_TYPE = /^[a-z][a-z0-9_]*$/;

/**
 * The aggregate types that own a topic `<aggregateType>.events`. Each domain registers its own at module init;
 * infrastructure holds no list of domain topics (FR-004). `latest-per-key` (compacted) is accepted only when every
 * event definition of the aggregate carries the full state (FR-005).
 */
@Injectable()
export class TopicRegistry {
  private readonly topics = new Map<string, RegisteredTopic>();
  private readonly defaults: TopicDefaults;

  constructor(defaults: TopicDefaults | ApiConfigService) {
    this.defaults =
      defaults instanceof ApiConfigService
        ? {
            defaultPartitions: defaults.get('topic_default_partitions'),
            hotPartitions: defaults.get('topic_hot_partitions'),
          }
        : defaults;
  }

  register(registration: TopicRegistration): RegisteredTopic {
    const { aggregateType, retention } = registration;
    if (!AGGREGATE_TYPE.test(aggregateType))
      throw new InvalidAggregateTypeError(aggregateType);
    if (this.topics.has(aggregateType))
      throw new DuplicateAggregateTypeError(aggregateType);
    const partitions =
      registration.partitions ??
      (registration.hot
        ? this.defaults.hotPartitions
        : this.defaults.defaultPartitions);
    if (!Number.isInteger(partitions) || partitions < 1)
      throw new InvalidPartitionCountError(aggregateType);
    this.assertPolicy(aggregateType, retention);

    const registered: RegisteredTopic = {
      aggregateType,
      topic: topicFor(aggregateType),
      partitions,
      retention,
      configEntries:
        retention === 'latest-per-key'
          ? [{ name: 'cleanup.policy', value: 'compact' }]
          : [
              { name: 'cleanup.policy', value: 'delete' },
              { name: 'retention.ms', value: '-1' },
            ],
    };
    this.topics.set(aggregateType, registered);
    return registered;
  }

  /**
   * Idempotent `register` for an aggregate declared by several modules of the same domain (api and worker app
   * modules). Registering the same type again with a different policy still throws.
   */
  ensure(registration: TopicRegistration): RegisteredTopic {
    const existing = this.topics.get(registration.aggregateType);
    if (!existing) return this.register(registration);
    const partitions =
      registration.partitions ??
      (registration.hot
        ? this.defaults.hotPartitions
        : this.defaults.defaultPartitions);
    if (
      existing.retention !== registration.retention ||
      existing.partitions !== partitions
    )
      throw new DuplicateAggregateTypeError(registration.aggregateType);
    return existing;
  }

  has(aggregateType: string): boolean {
    return this.topics.has(aggregateType);
  }

  get(aggregateType: string): RegisteredTopic {
    const topic = this.topics.get(aggregateType);
    if (!topic) throw new UnregisteredAggregateTypeError(aggregateType);
    return topic;
  }

  topicFor(aggregateType: string): DomainTopic {
    return this.get(aggregateType).topic;
  }

  all(): RegisteredTopic[] {
    return [...this.topics.values()];
  }

  /** Re-checks every registration against the event definitions known now (definitions can load after `register`). */
  validate(): void {
    for (const topic of this.topics.values())
      this.assertPolicy(topic.aggregateType, topic.retention);
  }

  private assertPolicy(aggregateType: string, retention: TopicRetention): void {
    if (retention !== 'latest-per-key') return;
    const offending = [...registeredEventDefinitions().values()]
      .filter((d) => d.aggregateType === aggregateType && d.carries !== 'state')
      .map((d) => d.type);
    if (offending.length > 0)
      throw new TopicPolicyError(aggregateType, [...new Set(offending)]);
  }
}

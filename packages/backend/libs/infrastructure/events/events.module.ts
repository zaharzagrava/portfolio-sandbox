import { DynamicModule, Module } from '@nestjs/common';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { OutboxModule } from '@app/infrastructure/outbox/outbox.module';
import { EventPublisher } from './event-publisher';
import { EventsCoreModule } from './events-core.module';
import { TopicRegistration, TopicRegistry } from './topic-registry';

/**
 * What a domain imports to declare and publish events: the topic registry, `OutboxService` (`append`,
 * `appendStandalone`, `appendTask`) and the plain `EventPublisher`.
 *
 *   imports: [EventsModule.forAggregates([{ aggregateType: 'orders', retention: 'full-history' }])]
 *
 * `forAggregates` registers the domain's aggregate types at module init (FR-004); every module of a domain may
 * list the same types.
 */
@Module({
  imports: [EventsCoreModule, OutboxModule, KafkaProducerModule],
  providers: [EventPublisher],
  exports: [EventsCoreModule, OutboxModule, EventPublisher],
})
export class EventsModule {
  static forAggregates(aggregates: TopicRegistration[]): DynamicModule {
    return {
      module: EventsModule,
      imports: [EventsCoreModule, OutboxModule, KafkaProducerModule],
      providers: [
        EventPublisher,
        {
          provide: Symbol(
            `aggregates:${aggregates.map((a) => a.aggregateType).join(',')}`,
          ),
          inject: [TopicRegistry],
          useFactory: (registry: TopicRegistry) =>
            aggregates.map((a) => registry.ensure(a)),
        },
      ],
      exports: [EventsCoreModule, OutboxModule, EventPublisher],
    };
  }
}

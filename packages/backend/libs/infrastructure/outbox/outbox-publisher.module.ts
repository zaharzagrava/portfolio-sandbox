import { DynamicModule, Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import {
  OUTBOX_PUBLISHER_OPTIONS,
  OutboxPublisherOptions,
  OutboxPublisherService,
} from './outbox-publisher.service';
import { RELAY_RANDOM } from './relay-random';

/**
 * Separate from OutboxModule deliberately: OutboxService (writing rows) is needed wherever events are appended;
 * the relay (a local ticker draining rows to the log) belongs in core with everything that has no distinguishing
 * resource profile. In `cdc` mode the ticker does not start (Debezium relays the outbox).
 */
@Module({
  imports: [ApiConfigModule, KafkaProducerModule, SqsModule],
  providers: [
    { provide: RELAY_RANDOM, useValue: Math.random },
    { provide: OUTBOX_PUBLISHER_OPTIONS, useValue: {} },
    OutboxPublisherService,
  ],
  exports: [OutboxPublisherService],
})
export class OutboxPublisherModule {
  /** `ticker: false` keeps the relay passive so a spec can call `drain()` itself. */
  static register(options: OutboxPublisherOptions = {}): DynamicModule {
    return {
      module: OutboxPublisherModule,
      imports: [ApiConfigModule, KafkaProducerModule, SqsModule],
      providers: [
        { provide: RELAY_RANDOM, useValue: Math.random },
        { provide: OUTBOX_PUBLISHER_OPTIONS, useValue: options },
        OutboxPublisherService,
      ],
      exports: [OutboxPublisherService],
    };
  }
}

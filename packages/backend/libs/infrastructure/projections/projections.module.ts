import {
  DynamicModule,
  Inject,
  Module,
  OnApplicationBootstrap,
  Type,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiConfigModule } from '@app/common/config';
import { TransactionModule } from '@app/infrastructure/context/transaction.module';
import { InboxModule } from '@app/infrastructure/inbox/inbox.module';
import { KAFKA_CONSUMER_OVERRIDES } from '@app/infrastructure/kafka/kafka-client.options';
import { KafkaProducerModule } from '@app/infrastructure/kafka/kafka-producer.module';
import { DeadLetterWriter } from './dead-letter';
import { Projector } from './projector';
import { CONSUMER_RANDOM, ProjectionRunner } from './projection-runner.service';
import { ProjectionCheckpoints } from './read-your-writes';
import { ConsumerLag } from './consumer-lag';
import { ProjectionActivation } from './projection-activation';
import { ProjectionAdmin } from './projection-admin.service';
import { ProjectionRegistry } from './projection-registry';
import { ReadYourWrites } from './read-your-writes.service';
import { RedriveService } from './redrive.service';
import { RedisDocSink } from './sinks/redis-doc.sink';
import { TransactionalPipeline } from './transactional-pipeline';

const PROJECTORS = Symbol('PROJECTORS');

/**
 * `ProjectionsModule.forProjectors([ProductSearchProjector, ...], [modules those need])` in the `projector` app
 * starts every listed consumer once the app has bootstrapped (S53 FR-040). The framework brings what every consumer
 * needs: the runner, checkpoints, dead-letter writer, inbox, transactions and the Redis document sink; `imports`
 * adds the stores and domain modules the listed consumers inject. A wrong declaration (no idempotency mechanism,
 * duplicate group name, `coalesce` on delta events) fails the whole startup before any consumer starts.
 */
@Module({})
export class ProjectionsModule implements OnApplicationBootstrap {
  constructor(
    private readonly runner: ProjectionRunner,
    private readonly moduleRef: ModuleRef,
    @Inject(PROJECTORS) private readonly projectorTypes: Type<Projector>[],
  ) {}

  static forProjectors(
    projectors: Type<Projector>[],
    imports: DynamicModule['imports'] = [],
  ): DynamicModule {
    return {
      module: ProjectionsModule,
      imports: [
        ApiConfigModule,
        TransactionModule,
        InboxModule,
        KafkaProducerModule,
        ...imports,
      ],
      providers: [
        ProjectionRunner,
        ProjectionCheckpoints,
        ReadYourWrites,
        ProjectionRegistry,
        ProjectionActivation,
        ProjectionAdmin,
        ConsumerLag,
        TransactionalPipeline,
        DeadLetterWriter,
        RedriveService,
        RedisDocSink,
        { provide: CONSUMER_RANDOM, useValue: Math.random },
        // Empty in production; specs bind a socket factory to cut or delay the consumer's connection.
        { provide: KAFKA_CONSUMER_OVERRIDES, useValue: {} },
        ...projectors,
        { provide: PROJECTORS, useValue: projectors },
      ],
      exports: [
        ProjectionRunner,
        ProjectionCheckpoints,
        ReadYourWrites,
        ProjectionAdmin,
        ProjectionActivation,
        ConsumerLag,
        TransactionalPipeline,
        RedisDocSink,
        RedriveService,
      ],
    };
  }

  async onApplicationBootstrap() {
    await this.runner.startAll(
      this.projectorTypes.map((type) =>
        this.moduleRef.get(type, { strict: false }),
      ),
    );
  }
}

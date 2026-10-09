import { Global, Inject, Module, OnModuleInit, Optional } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { useEventClock } from './define-event';
import { TopicRegistry } from './topic-registry';

/**
 * The topic registry and the time source of event definitions. Global: domains register their aggregate types at
 * init (`TopicRegistry.register`) and `OutboxService` reads the registry when it appends. Domains import
 * `EventsModule` (which adds the outbox), not this module.
 */
@Global()
@Module({
  providers: [
    {
      provide: TopicRegistry,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => new TopicRegistry(config),
    },
  ],
  exports: [TopicRegistry],
})
export class EventsCoreModule implements OnModuleInit {
  constructor(@Optional() @Inject(CLOCK) private readonly clock?: Clock) {}

  onModuleInit(): void {
    if (this.clock) useEventClock(this.clock);
  }
}

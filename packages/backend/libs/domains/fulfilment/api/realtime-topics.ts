import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime';
import {
  REALTIME_ACCESS_PORT,
  type RealtimeAccessPort,
} from '../domain/delivery-ports';

/**
 * `delivery:{id}` (SD-23 live tracking, S20 FR-040): one rule - the buyer and the assigned courier only. The data access
 * is the port's; nothing here touches a store (A23).
 */
@Injectable()
export class DeliveryTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    @Inject(REALTIME_ACCESS_PORT) private readonly access: RealtimeAccessPort,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'delivery',
      owner: 'fulfilment',
      policy: (viewer, _topic, deliveryId) =>
        !!viewer.userId && this.access.canSubscribe(deliveryId, viewer.userId),
    });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    delivery: `delivery:${string}`;
  }
}

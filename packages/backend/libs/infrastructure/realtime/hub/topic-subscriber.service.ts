import { Injectable } from '@nestjs/common';
import type { RealtimeMessage, RealtimeTopic } from '../topics';
import { SubscriptionHub } from './subscription-hub';

/**
 * In-process listener for a topic (S51 FR-041): shares the ref-counted backplane subscription with the HTTP viewers of
 * the same instance. Resolves an idempotent release function.
 */
@Injectable()
export class TopicSubscriber {
  constructor(private readonly hub: SubscriptionHub) {}

  subscribe(
    topic: RealtimeTopic,
    handler: (message: RealtimeMessage) => void,
  ): Promise<() => Promise<void>> {
    return this.hub.subscribe(topic, handler);
  }
}

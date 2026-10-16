import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime';
import { QUEUE_STORE, type QueueStore } from '../domain/ports';

/**
 * Launch-event topics (one rule per route, S51 follow-up):
 *  - `event:{id}:seatmap`: public seat deltas (S22 FR-039);
 *  - `queue:{ticket}`: the waiting-room push, **owner only** (S22 FR-008). The policy asks the ticket store who owns the
 *    ticket; an unknown ticket and somebody else's ticket are refused the same way.
 * The live stream's `stream:{id}` topic belongs to S23 (`LiveTopics`).
 */
@Injectable()
export class LaunchEventTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
    @Inject(QUEUE_STORE) private readonly queue: QueueStore,
  ) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'event',
      suffixes: ['seatmap'],
      owner: 'launch-events',
      policy: () => true,
    });
    this.topics.define({
      prefix: 'queue',
      owner: 'launch-events',
      policy: async (viewer, _topic, ticket) => {
        if (!viewer.userId) return false;
        try {
          return (await this.queue.ownerOf(ticket)) === viewer.userId;
        } catch {
          return false;
        }
      },
    });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    'event:seatmap': `event:${string}:seatmap`;
    queue: `queue:${string}`;
  }
}

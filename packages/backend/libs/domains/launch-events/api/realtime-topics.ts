import { Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime';

/** Launch-event topics: `event:{id}:seatmap` (public seat deltas, SD-21), `queue:{ticket}` (waiting-room position), `stream:{id}` (public live comments, SD-15). */
@Injectable()
export class LaunchEventTopics implements OnModuleInit {
  constructor(private readonly topics: TopicRegistry) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'event',
      suffixes: ['seatmap'],
      policy: () => true,
    });
    // Waiting-room tickets are unguessable UUIDs handed only to their holder: knowing the topic is the capability (SD-21).
    this.topics.define({ prefix: 'queue', policy: () => true });
    this.topics.define({ prefix: 'stream', policy: () => true });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    'event:seatmap': `event:${string}:seatmap`;
    queue: `queue:${string}`;
    stream: `stream:${string}`;
    /** Internal comment firehose between the live service and the batcher; no route, so no client can subscribe. */
    livefeed: `livefeed:${string}`;
  }
}

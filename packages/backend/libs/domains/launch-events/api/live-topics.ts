import { Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime';

/**
 * The live stream's realtime topics (S23 FR-016): `stream:{id}` is a public broadcast of control events only (`status`,
 * `pin`, `comment_removed`, `stats`); the comment feed (`livefeed:{id}`) has NO route here, so no client can subscribe
 * to it and it is refused like any unknown topic. `stats` is published live-only (`replay: false`), the rest replay.
 */
@Injectable()
export class LiveTopics implements OnModuleInit {
  constructor(private readonly topics: TopicRegistry) {}

  onModuleInit() {
    this.topics.define({
      prefix: 'stream',
      owner: 'launch-events',
      policy: () => true,
    });
  }
}

/** The routes this domain declares in the shared topic type (S51 FR-024). */
declare module '@app/infrastructure/realtime/topics' {
  interface RealtimeTopicPrefixes {
    stream: `stream:${string}`;
    /** Internal comment feed between the comment service and the gateways' batchers; no route, so no client can subscribe. */
    livefeed: `livefeed:${string}`;
  }
}

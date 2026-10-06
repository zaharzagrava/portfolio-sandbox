import { Injectable, OnModuleInit } from '@nestjs/common';
import { TopicRegistry } from '@app/infrastructure/realtime/topic-registry';

/** Launch-event topics: `event:{id}:seatmap` (public seat deltas, SD-21), `queue:{ticket}` (waiting-room position), `stream:{id}` (public live comments, SD-15). */
@Injectable()
export class LaunchEventTopics implements OnModuleInit {
  constructor(
    private readonly topics: TopicRegistry,
  ) {}

  onModuleInit() {
    this.topics.define({ prefix: 'event', suffixes: ['seatmap'], policy: () => true });
    // Waiting-room tickets are unguessable UUIDs handed only to their holder: knowing the topic is the capability (SD-21).
    this.topics.define({ prefix: 'queue', policy: () => true });
    this.topics.define({ prefix: 'stream', policy: () => true });
  }
}

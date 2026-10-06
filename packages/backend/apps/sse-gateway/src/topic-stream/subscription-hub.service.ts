import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle/shutdown-registry.service';
import { channelName, RealtimeMessage } from '@app/infrastructure/realtime/topics';

type Listener = (message: RealtimeMessage) => void;

/**
 * One Redis subscriber connection per gateway instance, ref-counted per
 * channel (README #30, now in NestJS too): SUBSCRIBE on the first local
 * listener, UNSUBSCRIBE when the last one leaves. Redis fan-out cost then
 * tracks topics that have viewers *on this instance*, not all topics ever.
 * (The previous per-viewer subscribe/unsubscribe dropped the channel for
 * every other viewer when one disconnected.)
 */
@Injectable()
export class SubscriptionHub implements OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionHub.name);
  private readonly subscriber: Redis;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    config: ApiConfigService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    this.subscriber = new Redis(config.get('redis_url'), { maxRetriesPerRequest: null });
    this.subscriber.on('message', (channel: string, raw: string) => this.dispatch(channel, raw));
    // On reconnect ioredis re-subscribes automatically; clients resume missed events via Last-Event-ID replay.
    shutdown?.register({ name: 'sse.hub.close', order: 20, run: async () => this.onModuleDestroy() });
  }

  async subscribe(topic: string, listener: Listener): Promise<() => Promise<void>> {
    const channel = channelName(topic);
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.subscriber.subscribe(channel);
    }
    set.add(listener);

    return async () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        await this.subscriber.unsubscribe(channel).catch((e) => this.logger.warn(`unsubscribe ${channel}: ${e.message}`));
      }
    };
  }

  listenerCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  private dispatch(channel: string, raw: string) {
    const set = this.listeners.get(channel);
    if (!set) return;
    let message: RealtimeMessage;
    try {
      message = JSON.parse(raw) as RealtimeMessage;
    } catch {
      return;
    }
    for (const listener of set) listener(message);
  }

  async onModuleDestroy() {
    this.listeners.clear();
    this.subscriber.disconnect();
  }
}

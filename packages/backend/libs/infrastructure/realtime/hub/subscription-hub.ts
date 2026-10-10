import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { ApiConfigService } from '@app/common/config';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { RealtimeConfig } from '../config/realtime.config';
import { CHANNEL_PREFIX, CONTROL_CHANNEL, channelName } from '../keys';
import { RealtimeMetrics } from '../metrics/realtime-metrics';
import type { RealtimeMessage } from '../topics';

export type Listener = (message: RealtimeMessage) => void;

export interface RevocationNotice {
  userId?: string;
  prefix: string;
  id: string;
  suffix?: string;
}

interface ChannelEntry {
  listeners: Set<Listener>;
  ready: Promise<void>;
}

/**
 * One Redis subscriber connection per instance, ref-counted per channel (README #30): SUBSCRIBE on the first local
 * listener, UNSUBSCRIBE when the last one leaves, so the backplane cost tracks topics that have viewers *on this
 * instance*. Concurrent first listeners share one pending SUBSCRIBE; a failed one leaves no entry behind. A listener
 * that throws is isolated from the others. The connection is opened on first use, so processes that only publish never
 * hold one.
 */
@Injectable()
export class SubscriptionHub implements OnModuleDestroy {
  private readonly logger = new Logger(SubscriptionHub.name);
  private subscriber?: Redis;
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly resubscribeHandlers = new Set<() => void>();
  private readonly controlHandlers = new Set<(n: RevocationNotice) => void>();
  private controlReady?: Promise<void>;
  private everReady = false;
  private destroyed = false;

  constructor(
    private readonly apiConfig: ApiConfigService,
    private readonly config: RealtimeConfig,
    private readonly metrics: RealtimeMetrics,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({
      name: 'realtime.hub.quit',
      order: 85,
      run: async () => this.onModuleDestroy(),
    });
  }

  private connection(): Redis {
    if (this.destroyed) throw new Error('realtime hub is closed');
    if (this.subscriber) return this.subscriber;
    const subscriber = new Redis(
      this.config.get('subscriberUrl') || this.apiConfig.get('redis_url'),
      {
        // Fail fast instead of queueing a SUBSCRIBE while the backplane is down: admission answers 503 and retries later.
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        commandTimeout: this.config.get('subscribeTimeoutMs'),
      },
    );
    subscriber.on('message', (channel: string, raw: string) =>
      this.dispatch(channel, raw),
    );
    subscriber.on('error', (error) =>
      this.logger.warn(`realtime subscriber connection: ${error.message}`),
    );
    // ioredis re-subscribes the channels itself after a reconnect; events published meanwhile are gap-filled per connection.
    subscriber.on('ready', () => {
      if (this.everReady) {
        for (const handler of this.resubscribeHandlers) {
          try {
            handler();
          } catch (error) {
            this.logger.warn(
              `resubscribe handler: ${(error as Error).message}`,
            );
          }
        }
      }
      this.everReady = true;
    });
    this.subscriber = subscriber;
    return subscriber;
  }

  /** The first command waits for the connection that is still being opened; a connection that is down fails at once. */
  private whenReady(connection: Redis): Promise<void> {
    if (connection.status === 'ready') return Promise.resolve();
    if (connection.status !== 'connecting' && connection.status !== 'wait')
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.off('ready', onReady);
        reject(new Error('realtime backplane connection timed out'));
      }, this.config.get('subscribeTimeoutMs'));
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      connection.once('ready', onReady);
    });
  }

  /** `release` is idempotent. Rejects when the backplane could not confirm the subscription; nothing is left behind. */
  async subscribe(
    topic: string,
    listener: Listener,
  ): Promise<() => Promise<void>> {
    const channel = channelName(topic);
    let entry = this.channels.get(channel);
    if (!entry) {
      const created: ChannelEntry = {
        listeners: new Set(),
        ready: Promise.resolve(),
      };
      this.channels.set(channel, created);
      created.ready = this.whenReady(this.connection())
        .then(() => this.connection().subscribe(channel))
        .then(
          () => this.publishGauges(),
          (error) => {
            if (this.channels.get(channel) === created)
              this.channels.delete(channel);
            this.publishGauges();
            throw error;
          },
        );
      // Waiters handle the rejection; this keeps it from surfacing as unhandled when nobody is left waiting.
      created.ready.catch(() => undefined);
      entry = created;
    }
    entry.listeners.add(listener);
    try {
      await entry.ready;
    } catch (error) {
      entry.listeners.delete(listener);
      throw error;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0 && this.channels.get(channel) === entry) {
        this.channels.delete(channel);
        this.publishGauges();
        await this.subscriber?.unsubscribe(channel).catch((error: Error) => {
          this.logger.warn(`unsubscribe ${channel}: ${error.message}`);
        });
      }
    };
  }

  /** Revocation notices from any instance (research D6); the subscription lives as long as the hub. */
  async onControl(handler: (notice: RevocationNotice) => void): Promise<void> {
    this.controlHandlers.add(handler);
    this.controlReady ??= this.whenReady(this.connection())
      .then(() => this.connection().subscribe(CONTROL_CHANNEL))
      .then(() => undefined)
      .catch((error) => {
        this.controlReady = undefined;
        throw error;
      });
    await this.controlReady;
  }

  /** Called after the subscriber connection came back (not on the first connect). */
  onResubscribed(handler: () => void): () => void {
    this.resubscribeHandlers.add(handler);
    return () => this.resubscribeHandlers.delete(handler);
  }

  /** The subscriber connection's state (`none` before first use). */
  backplaneStatus(): string {
    return this.subscriber?.status ?? 'none';
  }

  channelCount(): number {
    return this.channels.size;
  }

  listenerCount(): number {
    let total = 0;
    for (const entry of this.channels.values()) total += entry.listeners.size;
    return total;
  }

  private publishGauges() {
    this.metrics.subscriptions.set(this.channels.size);
  }

  private dispatch(channel: string, raw: string) {
    if (channel === CONTROL_CHANNEL) return this.dispatchControl(raw);
    if (!channel.startsWith(CHANNEL_PREFIX)) return;
    const entry = this.channels.get(channel);
    if (!entry) return;
    let message: RealtimeMessage;
    try {
      message = JSON.parse(raw) as RealtimeMessage;
    } catch {
      return;
    }
    for (const listener of [...entry.listeners]) {
      try {
        listener(message);
      } catch (error) {
        this.metrics.listenerErrors.add(1);
        this.logger.warn(
          `realtime listener failed: ${(error as Error).message}`,
        );
      }
    }
  }

  private dispatchControl(raw: string) {
    let notice: RevocationNotice;
    try {
      notice = JSON.parse(raw) as RevocationNotice;
    } catch {
      return;
    }
    if (typeof notice?.prefix !== 'string' || typeof notice?.id !== 'string')
      return;
    for (const handler of this.controlHandlers) {
      try {
        handler(notice);
      } catch (error) {
        this.metrics.listenerErrors.add(1);
        this.logger.warn(
          `revocation handler failed: ${(error as Error).message}`,
        );
      }
    }
  }

  /** Graceful: pending commands finish, then the connection closes (the shutdown task runs it after the drain). */
  async onModuleDestroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.channels.clear();
    this.controlHandlers.clear();
    this.resubscribeHandlers.clear();
    const subscriber = this.subscriber;
    if (!subscriber) return;
    try {
      await Promise.race([
        subscriber.quit(),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      /* already closed */
    }
    subscriber.disconnect();
  }
}

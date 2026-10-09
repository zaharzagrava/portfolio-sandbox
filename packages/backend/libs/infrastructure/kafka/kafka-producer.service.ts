import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';
import { ApiConfigService } from '@app/common/config';
import { PublishTimeoutError } from '@app/infrastructure/events/event-errors';
import { createKafka } from './kafka-client.factory';
import {
  KAFKA_CLIENT_OVERRIDES,
  type KafkaClientOverrides,
} from './kafka-client.options';

/** A publish that does not complete within this limit rejects with `PublishTimeoutError` (S53 FR-063). */
export const PUBLISH_TIMEOUT_MS = 10_000;

export interface ProducerMessage {
  /** Raw bytes for a dead letter that must keep the original key unchanged. */
  key: string | Buffer | null;
  /** Strings and buffers go out as they are, anything else as JSON. */
  value: unknown;
  headers?: Record<string, string>;
}

/**
 * `relay`: no client-level retries and not idempotent (kafkajs requires retries for idempotence): the relay owns
 * retry and backoff (one retry layer, IV.6), delivers at least once, resets the producer after a failure, and its
 * consumers de-duplicate by `eventId`. `publisher`: plain producer for `EventPublisher` and direct callers; the
 * idempotent producer retries a lost acknowledgement without creating a second copy.
 */
export type ProducerProfile = 'relay' | 'publisher';

const serialize = (value: unknown): string | Buffer =>
  typeof value === 'string' || Buffer.isBuffer(value)
    ? value
    : JSON.stringify(value);

/**
 * Idempotent producer (`acks=-1`, one request in flight, 10 s timeout) over the shared client factory. Connects on
 * first use, so a process starts without the broker; a failed send is the caller's to retry.
 */
@Injectable()
export class KafkaProducerService implements OnModuleDestroy {
  private readonly clients: Record<ProducerProfile, Kafka>;
  private readonly producers = new Map<ProducerProfile, Promise<Producer>>();

  constructor(
    configService: ApiConfigService,
    @Optional()
    @Inject(KAFKA_CLIENT_OVERRIDES)
    overrides?: KafkaClientOverrides,
  ) {
    const base: KafkaClientOverrides = { connectionTimeout: 3_000 };
    this.clients = {
      // The relay makes one attempt and fails fast, on connect too (it retries with its own backoff): the whole
      // publish budget goes to that attempt, and a hanging broker surfaces as our PublishTimeoutError.
      relay: createKafka(configService, 'marketplace-relay', {
        ...base,
        requestTimeout: PUBLISH_TIMEOUT_MS + 1_000,
        retry: { retries: 0 },
        ...overrides,
      }),
      // The idempotent publisher retries inside the budget: a request that times out (a lost acknowledgement) is
      // resent in time, and the broker drops the duplicate.
      publisher: createKafka(configService, 'marketplace-producer', {
        ...base,
        requestTimeout: Math.floor(PUBLISH_TIMEOUT_MS / 3),
        ...overrides,
      }),
    };
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(
      [...this.producers.keys()].map((profile) => this.reset(profile)),
    );
  }

  /** Drops the producer of a profile (disconnects it); the next send connects a fresh one with a new epoch. */
  async reset(profile: ProducerProfile): Promise<void> {
    const pending = this.producers.get(profile);
    this.producers.delete(profile);
    if (!pending) return;
    try {
      await (await pending).disconnect();
    } catch {
      // The connection is already gone.
    }
  }

  private producer(profile: ProducerProfile): Promise<Producer> {
    let pending = this.producers.get(profile);
    if (!pending) {
      const producer = this.clients[profile].producer({
        maxInFlightRequests: 1,
        ...(profile === 'relay'
          ? { retry: { retries: 0 } }
          : { idempotent: true }),
      });
      pending = producer.connect().then(() => producer);
      this.producers.set(profile, pending);
      pending.catch(() => {
        if (this.producers.get(profile) === pending)
          this.producers.delete(profile);
      });
    }
    return pending;
  }

  public async send(
    {
      topic,
      key,
      value,
      headers,
    }: {
      topic: string;
      key: string;
      value: unknown;
      headers?: Record<string, string>;
    },
    options: { profile?: ProducerProfile } = {},
  ): Promise<void> {
    await this.sendMany(topic, [{ key, value, headers }], options);
  }

  /** Many messages to one topic in a single produce request (batched per partition by kafkajs). */
  public async sendMany(
    topic: string,
    messages: ProducerMessage[],
    options: { profile?: ProducerProfile } = {},
  ): Promise<void> {
    if (messages.length === 0) return;
    const work = async () => {
      const producer = await this.producer(options.profile ?? 'publisher');
      await producer.send({
        topic,
        acks: -1,
        timeout: PUBLISH_TIMEOUT_MS,
        messages: messages.map((m) => ({
          key: m.key,
          value: serialize(m.value),
          ...(m.headers && { headers: m.headers }),
        })),
      });
    };
    const profile = options.profile ?? 'publisher';
    let timer: NodeJS.Timeout | undefined;
    const sending = work();
    try {
      await Promise.race([
        sending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new PublishTimeoutError(topic, PUBLISH_TIMEOUT_MS)),
            PUBLISH_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof PublishTimeoutError) {
        // The abandoned request must not complete behind the caller's back: drop the connection and its state.
        sending.catch(() => undefined);
        void this.reset(profile);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

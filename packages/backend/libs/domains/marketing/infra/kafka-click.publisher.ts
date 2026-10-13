import { Injectable, Logger, Optional } from '@nestjs/common';
import { KafkaProducerService } from '@app/infrastructure/kafka/kafka-producer.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import type { ClickEnvelope, ClickPublisher } from '../domain/ports';
import { linkClickPublishFailedCounter } from '../domain/link-metrics';

const TOPIC = 'links.events';
const RETRIES = 2;
const BACKOFF_MS = 100;
export const PUBLISH_DRAIN_MS = 5_000;

/**
 * Click events leave the request path at once (S37 G15, FR-062): the response never waits for Kafka. A failed send is
 * retried at most twice off the path; the last failure increments `link_click_publish_failed_total` once and writes
 * one structured warning without destination, referrer, address or visitor data. In-flight publishes are tracked so a
 * shutdown can wait for them (up to 5 s) before the pools close (AS-37).
 */
@Injectable()
export class KafkaClickPublisher implements ClickPublisher {
  private readonly logger = new Logger(KafkaClickPublisher.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly producer: KafkaProducerService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    shutdown?.register({
      name: 'share-links.click-publisher.drain',
      order: 50,
      timeoutMs: PUBLISH_DRAIN_MS + 500,
      run: () => this.drain(PUBLISH_DRAIN_MS),
    });
  }

  publish(envelope: ClickEnvelope): void {
    const task = this.send(envelope).finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }

  async drain(timeoutMs: number): Promise<void> {
    if (this.inFlight.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  private async send(envelope: ClickEnvelope): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        await this.producer.send({
          topic: TOPIC,
          key: envelope.aggregateId,
          value: envelope,
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < RETRIES)
          await new Promise((r) => setTimeout(r, BACKOFF_MS * 2 ** attempt));
      }
    }
    linkClickPublishFailedCounter.add(1);
    this.logger.warn(
      `link click event not published (${(lastError as Error)?.name ?? 'Error'})`,
    );
  }
}

import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { MetricsRegistry } from '@app/common/telemetry/metrics-registry';
import { RequestRecord, RequestRecordPublisher } from '../domain/ports';

export const REQUEST_SINK_OPTIONS = Symbol('REQUEST_SINK_OPTIONS');

export interface RequestSinkOptions {
  /** Records kept while the bus is down; on overflow the oldest is dropped (FR-054). */
  capacity: number;
  batch: number;
  /** Waits between attempts after a failure; the last one repeats. */
  backoffMs: number[];
}

export const DEFAULT_SINK_OPTIONS: RequestSinkOptions = {
  capacity: 10_000,
  batch: 100,
  backoffMs: [200, 500, 1_000, 2_000, 5_000],
};

const droppedCounter = () =>
  MetricsRegistry.counter({
    name: 'public_api_request_log_dropped_total',
    help: 'Request records dropped because the retry buffer was full',
    labels: [],
  });

/**
 * Logging never hurts the request (FR-054, AS-61): `record` is an in-memory handover and returns at once; a background
 * loop publishes in batches and, when the bus is unavailable, retries with backoff from a bounded buffer. On overflow the
 * oldest record goes and is counted. The loop is single-flight, so a record is published once.
 */
@Injectable()
export class RequestRecordSink implements OnModuleDestroy {
  private readonly logger = new Logger(RequestRecordSink.name);
  private readonly options: RequestSinkOptions;
  private buffer: RequestRecord[] = [];
  private pump?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly publisher: RequestRecordPublisher,
    @Optional() @Inject(REQUEST_SINK_OPTIONS) options?: RequestSinkOptions,
  ) {
    this.options = options ?? DEFAULT_SINK_OPTIONS;
  }

  record(record: RequestRecord): void {
    this.buffer.push(record);
    while (this.buffer.length > this.options.capacity) {
      this.buffer.shift();
      droppedCounter().add(1);
    }
    this.schedule();
  }

  /** Waits until everything buffered is published, or `timeoutMs` passes (shutdown, tests). */
  async flush(timeoutMs = 5_000): Promise<void> {
    this.stopping = true; // no more waiting between attempts: this is the last chance
    const deadline = Date.now() + timeoutMs;
    try {
      while (this.buffer.length > 0 && Date.now() < deadline) {
        this.schedule();
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.pump,
            new Promise((r) => {
              timer = setTimeout(r, Math.max(1, deadline - Date.now()));
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      this.stopping = false;
    }
    if (this.buffer.length > 0)
      this.logger.warn(
        `${this.buffer.length} request records not published at flush`,
      );
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
  }

  private schedule(): void {
    if (this.pump) return;
    this.pump = this.run().finally(() => {
      this.pump = undefined;
    });
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.buffer.length > 0) {
      const batch = this.buffer.slice(0, this.options.batch);
      try {
        await this.publisher.publish(batch);
        const done = new Set(batch);
        this.buffer = this.buffer.filter((r) => !done.has(r));
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures === 1)
          this.logger.warn(
            `request records not published: ${(error as Error).message}`,
          );
        if (this.stopping && failures > 1) return;
        const wait =
          this.options.backoffMs[
            Math.min(failures - 1, this.options.backoffMs.length - 1)
          ];
        await new Promise((r) => setTimeout(r, this.stopping ? 1 : wait));
      }
    }
  }
}

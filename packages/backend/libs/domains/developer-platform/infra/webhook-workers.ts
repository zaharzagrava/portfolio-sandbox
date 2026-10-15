import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ReadinessService } from '@app/infrastructure/health/readiness.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { ShutdownRegistry } from '@app/infrastructure/lifecycle';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import {
  deliveryMessageSchema,
  WebhookDeliveryService,
  type DeliveryOutcome,
} from '../application/webhook-delivery.service';
import {
  WEBHOOK_PURGE_JOB,
  WEBHOOK_SWEEP_JOB,
  type WebhookRetryPayload,
} from '../application/webhook-jobs';
import { WebhookLifecycleService } from '../application/webhook-lifecycle.service';
import { recordDeadLetter } from '../application/webhook-metrics';
import { DELIVERY_MAX_RECEIVES, WEBHOOK_QUEUE } from '../domain/webhook-events';
import { DeliveryQueue, type DeliveryMessage } from '../domain/webhook-ports';
import {
  DEFAULT_WEBHOOK_SETTINGS,
  WEBHOOK_SETTINGS,
  type WebhookSettings,
} from '../domain/webhook-settings';

/**
 * Concurrency of the retry-lane job. A decorator cannot read the injected settings, so it takes the default, which is
 * the same number as the queue consumer's.
 */
const RETRY_JOB_CONCURRENCY = DEFAULT_WEBHOOK_SETTINGS.workerConcurrency;

/** How long shutdown waits for the attempts in flight (the attempt deadline is 10 s). */
const SHUTDOWN_WAIT_MS = 10_000;

/**
 * apps/worker host of delivery (the same `WebhookDeliveryService` also runs as the Lambda host with the FIFO queue as its
 * event source). The FIFO consumer takes one message of an endpoint at a time (group = endpoint id) and the endpoints
 * side by side. A message the delivery asks to see again is left unacknowledged, so the queue redelivers it after its
 * visibility timeout and dead-letters it after five receives (redrive policy on the queue). A body that is not a delivery
 * message goes to the dead-letter queue at once. The retry lane is the job `webhooks.retry`, which puts the delivery back
 * into the ordered lane when it is due. On shutdown the consumer stops taking messages and the attempts in flight finish
 * and are recorded before the process goes on.
 */
@Injectable()
export class WebhookWorkers implements OnApplicationBootstrap, OnModuleDestroy {
  private stop?: () => Promise<void>;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly queue: TaskQueue,
    private readonly delivery: WebhookDeliveryService,
    private readonly lane: DeliveryQueue,
    private readonly lifecycle: WebhookLifecycleService,
    private readonly jobs: JobsService,
    @Inject(WEBHOOK_SETTINGS) private readonly settings: WebhookSettings,
    @Optional() readiness?: ReadinessService,
    @Optional() shutdown?: ShutdownRegistry,
  ) {
    // A consumed queue that is not defined means deliveries wait forever: the pod is not ready until it exists (L-002).
    readiness?.register({
      name: `queue:${WEBHOOK_QUEUE}`,
      scope: 'pod',
      timeoutMs: 2_000,
      check: async () => {
        for (const name of [
          WEBHOOK_QUEUE,
          WEBHOOK_QUEUE.replace(/(\.fifo)?$/, '-dlq$1'),
        ])
          if (!(await this.queue.queueExists(name)))
            throw new Error(`queue ${name} is not defined`);
      },
    });
    shutdown?.register({
      name: 'webhook-delivery-consumer',
      order: 10,
      timeoutMs: SHUTDOWN_WAIT_MS + 2_000,
      run: () => this.shutdown(),
    });
  }

  async onApplicationBootstrap() {
    // Single-run schedules (overlap 'skip'), safe from every replica at boot.
    await this.jobs.upsertSchedule({
      name: WEBHOOK_SWEEP_JOB,
      cron: '*/15 * * * *',
      jobType: WEBHOOK_SWEEP_JOB,
      payload: {},
      overlap: 'skip',
    });
    await this.jobs.upsertSchedule({
      name: WEBHOOK_PURGE_JOB,
      cron: '17 3 * * *',
      jobType: WEBHOOK_PURGE_JOB,
      payload: {},
      overlap: 'skip',
    });
    this.stop = this.queue.consume<DeliveryMessage>(
      WEBHOOK_QUEUE,
      ({ body, receiveCount }) =>
        this.handle(body, receiveCount).then(
          () => undefined,
          (error: unknown) => {
            // The receive that reaches the redrive limit is the last: the queue dead-letters the message.
            if (receiveCount >= DELIVERY_MAX_RECEIVES)
              recordDeadLetter('delivery');
            throw error;
          },
        ),
      {
        concurrency: this.settings.workerConcurrency,
        visibilityTimeoutSec: this.settings.visibilityTimeoutSec,
        // A body that is not a delivery message goes to the dead-letter queue at once; the count is made here because the
        // queue port does it without telling the consumer.
        bodySchema: {
          safeParse: (input: unknown) => {
            const parsed = deliveryMessageSchema.safeParse(input);
            if (!parsed.success) recordDeadLetter('delivery');
            return parsed;
          },
        },
      },
    );
  }

  /** One message through the delivery service, counted as in flight until it settles. */
  handle(
    message: DeliveryMessage,
    receiveCount: number,
  ): Promise<DeliveryOutcome> {
    const run = this.delivery.handle(message, receiveCount);
    this.inFlight.add(run);
    const forget = () => this.inFlight.delete(run);
    run.then(forget, forget);
    return run;
  }

  /** Stops taking messages, then waits (bounded) for the attempts in flight to be recorded. Idempotent. */
  async shutdown(): Promise<void> {
    const stop = this.stop;
    this.stop = undefined;
    await stop?.();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async onModuleDestroy() {
    await this.shutdown();
  }

  /** The sweep: endpoints past the failure window that no attempt reaches any more are switched off (FR-042). */
  @JobHandler(WEBHOOK_SWEEP_JOB, { concurrency: 1, fleetConcurrency: 1 })
  async disableFailingEndpoints(): Promise<void> {
    await this.lifecycle.sweepFailingEndpoints();
  }

  /** Retention: state-change history older than 400 days goes (FR-044). */
  @JobHandler(WEBHOOK_PURGE_JOB, { concurrency: 1, fleetConcurrency: 1 })
  async purgeHistory(): Promise<void> {
    await this.lifecycle.purgeHistory();
  }

  /** The retry lane: a due delivery goes back into the endpoint's ordered lane as the attempt it waits for. */
  @JobHandler('webhooks.retry', { concurrency: RETRY_JOB_CONCURRENCY })
  async retry(payload: WebhookRetryPayload): Promise<void> {
    await this.lane.enqueue({
      endpointId: payload.endpointId,
      eventId: payload.eventId,
      deliveryId: payload.deliveryId,
      kind: payload.kind,
      attempt: payload.attempt,
      ...(payload.scheduledFor ? { scheduledFor: payload.scheduledFor } : {}),
    });
  }
}

import { getConnectionToken } from '@nestjs/sequelize';
import { JobsTestProbe } from '@app/infrastructure/jobs';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { Projector } from '@app/infrastructure/projections/projector';
import { routeEnvelope } from '@app/infrastructure/projections/routing';
import type { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import {
  WebhookRedeliverError,
  type DeliveryOutcome,
} from '../application/webhook-delivery.service';
import type { DeliveryMessage } from '../domain/webhook-ports';
import { WEBHOOK_QUEUE } from '../domain/webhook-events';
import { WebhookWorkers } from '../infra/webhook-workers';
import type { SourceEvent, WebhookKit } from './webhook-e2e.fixture';

/**
 * Drives the ordered lane of a spec that replaces the queue with `InMemoryTaskQueue`: the messages the routing put on
 * `webhook-deliveries.fifo` are handed to the same handler the worker registers (`WebhookWorkers.handle`), one message of
 * a group after the other, groups side by side. A handler that asks for redelivery (`WebhookRedeliverError`) returns
 * `'redeliver'`; the queue's visibility timeout is the spec's decision (it advances the clock itself).
 */
export interface Lane {
  /** The messages waiting on the FIFO queue, oldest first. */
  pending(endpointId?: string): DeliveryMessage[];
  /** Removes and returns them. */
  take(endpointId?: string): DeliveryMessage[];
  /** One message through the worker's handler. */
  run(
    message: DeliveryMessage,
    receiveCount?: number,
  ): Promise<DeliveryOutcome | 'redeliver'>;
  /** Every pending message of one endpoint, in order (a redelivery is not repeated). */
  runEndpoint(
    endpointId: string,
  ): Promise<
    { message: DeliveryMessage; result: DeliveryOutcome | 'redeliver' }[]
  >;
  /** The delayed-retry jobs of an endpoint (`webhooks.retry`), oldest first. */
  retryJobs(
    endpointId: string,
    eventId?: string,
  ): Promise<{ id: string; runAt: Date; payload: DeliveryMessage }[]>;
  /** Runs the job handler of a retry (puts the message back into the lane) and returns that message. */
  runRetryJob(job: {
    id: string;
    payload: DeliveryMessage;
  }): Promise<DeliveryMessage>;
}

export function createLane(t: WebhookKit, queue: InMemoryTaskQueue): Lane {
  const ran = new Set<string>();
  const workers = () => t.app.get(WebhookWorkers);
  const matches = (endpointId?: string) => (m: (typeof queue.sent)[number]) =>
    m.queue === WEBHOOK_QUEUE &&
    (!endpointId || (m.body as DeliveryMessage).endpointId === endpointId);
  const lane: Lane = {
    pending: (endpointId) =>
      queue.sent
        .filter(matches(endpointId))
        .map((m) => m.body as DeliveryMessage),
    take(endpointId) {
      const taken = queue.sent.filter(matches(endpointId));
      for (const m of taken) queue.sent.splice(queue.sent.indexOf(m), 1);
      return taken.map((m) => m.body as DeliveryMessage);
    },
    async run(message, receiveCount = 1) {
      try {
        return await workers().handle(message, receiveCount);
      } catch (error) {
        if (error instanceof WebhookRedeliverError) return 'redeliver';
        throw error;
      }
    },
    async runEndpoint(endpointId) {
      const out: {
        message: DeliveryMessage;
        result: DeliveryOutcome | 'redeliver';
      }[] = [];
      for (const message of lane.take(endpointId))
        out.push({ message, result: await lane.run(message) });
      return out;
    },
    async retryJobs(endpointId, eventId) {
      const probe = new JobsTestProbe(t.app.get(getConnectionToken()));
      return (
        await probe.find('webhooks.retry', {
          endpointId,
          ...(eventId ? { eventId } : {}),
        })
      )
        .filter((j) => j.status === 'QUEUED' && !ran.has(j.id))
        .map((j) => ({
          id: j.id,
          runAt: new Date(j.runAt),
          payload: j.payload as DeliveryMessage,
        }));
    },
    async runRetryJob(job) {
      ran.add(job.id);
      await workers().retry(job.payload);
      const queued = lane.pending(job.payload.endpointId).at(-1)!;
      return queued;
    },
  };
  return lane;
}

/**
 * What the projection runner does with each envelope before the consumer sees it, then the consumer's own effect: not a
 * handled type is skipped, an envelope the declared contract refuses is dead-lettered, a `PermanentError` of the handler
 * is dead-lettered, anything else propagates. A poison event never stops the ones behind it.
 */
export async function feed(
  consumer: Projector,
  events: (SourceEvent | EventEnvelope)[],
): Promise<{ eventId: string; reason: string }[]> {
  const deadLettered: { eventId: string; reason: string }[] = [];
  for (const event of events) {
    const routed = routeEnvelope(consumer.handles, event as EventEnvelope);
    if (routed.kind === 'skip') continue;
    if (routed.kind === 'reject') {
      deadLettered.push({ eventId: event.eventId, reason: routed.code });
      continue;
    }
    try {
      await consumer.project([routed.envelope]);
    } catch (error) {
      if (!(error instanceof PermanentError)) throw error;
      deadLettered.push({ eventId: event.eventId, reason: 'PERMANENT' });
    }
  }
  return deadLettered;
}

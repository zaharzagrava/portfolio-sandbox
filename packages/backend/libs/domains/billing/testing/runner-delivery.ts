import type { INestApplication } from '@nestjs/common';
import { TransactionRunner } from '@app/infrastructure/context';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { InboxService } from '@app/infrastructure/inbox/inbox.service';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { routeEnvelope } from '@app/infrastructure/projections/routing';

export interface RunnerDelivered {
  counts: SinkCounts;
  ignored: number;
  deadLetters: { code: string; reason: string }[];
}

type ProjectorClass = new (...args: never[]) => Projector;

/**
 * Hands envelopes to the real consumer the way the S53 runner does for one batch (`invoke` in
 * `projection-runner.service.ts`): route by type and version, validate the payload against the declared contract, then
 * for `idempotency: 'inbox'` record `(consumer, eventId)` and run `project` for the fresh events in ONE transaction,
 * so a rolled-back effect leaves no record and the redelivery counts as new. A `PermanentError` is a dead letter, any
 * other failure is rethrown (the runner would not acknowledge the message and redeliver it). Only Kafka is missing.
 */
export function createRunnerDelivery(
  app: INestApplication,
  projector: ProjectorClass,
) {
  const consumer = app.get(projector, { strict: false });
  const runner = app.get(TransactionRunner, { strict: false });
  const inbox = app.get(InboxService, { strict: false });

  const empty = (): RunnerDelivered => ({
    counts: { applied: 0, duplicate: 0, stale: 0 },
    ignored: 0,
    deadLetters: [],
  });

  /** One batch: every envelope that routes to the consumer, in order, in a single handler call. */
  async function batch(
    envelopes: EventEnvelope[],
    into: RunnerDelivered,
  ): Promise<void> {
    const routed: EventEnvelope[] = [];
    for (const envelope of envelopes) {
      const result = routeEnvelope(
        consumer.handles,
        envelope,
        consumer.aggregateIdSchema,
      );
      if (result.kind === 'skip') into.ignored++;
      else if (result.kind === 'reject')
        into.deadLetters.push({ code: result.code, reason: result.reason });
      else routed.push(result.envelope);
    }
    if (routed.length === 0) return;
    const apply = async (): Promise<SinkCounts> => {
      let duplicate = 0;
      const fresh: EventEnvelope[] = [];
      if (consumer.idempotency === 'inbox') {
        for (const event of routed)
          if (await inbox.recordOnce(consumer.name, event.eventId))
            fresh.push(event);
          else duplicate++;
      } else fresh.push(...routed);
      const result =
        fresh.length > 0 ? await consumer.project(fresh) : undefined;
      const counts: SinkCounts = result
        ? { ...result }
        : { applied: fresh.length, duplicate: 0, stale: 0 };
      counts.duplicate += duplicate;
      return counts;
    };
    try {
      const counts =
        consumer.idempotency === 'inbox'
          ? await runner.run(apply)
          : await apply();
      into.counts.applied += counts.applied;
      into.counts.duplicate += counts.duplicate;
      into.counts.stale += counts.stale;
    } catch (error) {
      if (!(error instanceof PermanentError)) throw error;
      // the runner retries the chunk's events one at a time: the poison one is dead-lettered, its neighbours applied
      if (routed.length === 1) {
        into.deadLetters.push({
          code: 'HANDLER_FAILED',
          reason: error.message,
        });
        return;
      }
      for (const envelope of routed) await batch([envelope], into);
    }
  }

  return {
    consumer,
    /** One handler call for all envelopes (a delivered batch). */
    async deliverBatch(
      ...envelopes: EventEnvelope[]
    ): Promise<RunnerDelivered> {
      const into = empty();
      await batch(envelopes, into);
      return into;
    },
    /** One message after the other; a poison message never blocks the next. */
    async deliver(...envelopes: EventEnvelope[]): Promise<RunnerDelivered> {
      const into = empty();
      for (const envelope of envelopes) await batch([envelope], into);
      return into;
    },
    /** The same deliveries at the same moment (`Promise.all`). */
    async deliverConcurrently(
      ...envelopes: EventEnvelope[]
    ): Promise<RunnerDelivered> {
      const into = empty();
      await Promise.all(envelopes.map((envelope) => batch([envelope], into)));
      return into;
    },
  };
}

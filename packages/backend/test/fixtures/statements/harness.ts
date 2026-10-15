import type { INestApplication } from '@nestjs/common';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { routeEnvelope } from '@app/infrastructure/projections/routing';

/** What the consumer framework would have done with the deliveries: applied, skipped, or written to a dead-letter topic. */
export interface Delivered {
  counts: SinkCounts;
  ignored: number;
  deadLetters: { code: string; reason: string }[];
}

export type FactProjectorClass = new (...args: never[]) => Projector;

/**
 * The in-memory delivery harness of the statements specs (S16 test-plan.md): it hands envelopes to the real projector
 * the way the consumer runner does for one message at a time (route by type and version, validate, then `project`),
 * and records the dead letters the runner would write. It can deliver the same message twice, concurrently, out of
 * order or again after a "rebuild"; the projector, its inbox and its store are the real ones.
 */
export function createDelivery(
  app: INestApplication,
  projector: FactProjectorClass,
) {
  const consumer = app.get(projector, { strict: false });

  async function one(envelope: EventEnvelope, into: Delivered): Promise<void> {
    const routed = routeEnvelope(
      consumer.handles,
      envelope,
      consumer.aggregateIdSchema,
    );
    if (routed.kind === 'skip') {
      into.ignored++;
      return;
    }
    if (routed.kind === 'reject') {
      into.deadLetters.push({ code: routed.code, reason: routed.reason });
      return;
    }
    try {
      const result = await consumer.project([routed.envelope]);
      if (result) {
        into.counts.applied += result.applied;
        into.counts.duplicate += result.duplicate;
        into.counts.stale += result.stale;
      } else into.counts.applied++;
    } catch (error) {
      if (error instanceof PermanentError)
        into.deadLetters.push({
          code: 'HANDLER_FAILED',
          reason: error.message,
        });
      else throw error;
    }
  }

  const empty = (): Delivered => ({
    counts: { applied: 0, duplicate: 0, stale: 0 },
    ignored: 0,
    deadLetters: [],
  });

  return {
    consumer,
    /** One message after the other, a poison message never blocks the next. */
    async deliver(...envelopes: EventEnvelope[]): Promise<Delivered> {
      const into = empty();
      for (const envelope of envelopes) await one(envelope, into);
      return into;
    },
    /** The same deliveries at the same moment (`Promise.all`). */
    async deliverConcurrently(
      ...envelopes: EventEnvelope[]
    ): Promise<Delivered> {
      const into = empty();
      await Promise.all(envelopes.map((envelope) => one(envelope, into)));
      return into;
    },
  };
}

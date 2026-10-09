import { Injectable, OnModuleInit, Type } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { ZodType } from 'zod';
import type { EventDefinition } from '../define-event';
import type { EventEnvelope } from '../event-envelope';
import { applyIfNewer } from '@app/infrastructure/projections/sinks/apply-if-newer';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';

/** Test-only tables of the fixture consumers (created here, no migration): effects, versioned documents, natural keys. */
export async function ensureFixtureTables(sequelize: Sequelize): Promise<void> {
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS "S53FixtureEffect" (
      "n" bigserial PRIMARY KEY, "consumer" text NOT NULL, "aggregateId" text NOT NULL,
      "eventId" text NOT NULL, "name" text);
    CREATE TABLE IF NOT EXISTS "S53FixtureDoc" (
      "consumer" text NOT NULL, "aggregateId" text NOT NULL, "version" bigint NOT NULL,
      "name" text, "deleted" boolean NOT NULL DEFAULT false, PRIMARY KEY ("consumer", "aggregateId"));
    CREATE TABLE IF NOT EXISTS "S53FixtureNatural" (
      "consumer" text NOT NULL, "key" text NOT NULL, "value" text, PRIMARY KEY ("consumer", "key"));`);
}

/** What a spec can see and steer in a fixture consumer. */
export interface ConsumerProbe {
  /** Every `project` call, in call order, with its start and end time. */
  calls: { events: EventEnvelope[]; startedAt: number; endedAt?: number }[];
  /** Events inside the handler right now, and the most there ever were at once. */
  inHandler: number;
  maxInHandler: number;
  /** Throw before the effect for these event ids (consumed one per call; `-1` = always). */
  throwBefore: Map<string, { times: number; error: () => Error }>;
  /** Throw after the effect for these event ids. */
  throwAfter: Map<string, { times: number; error: () => Error }>;
  /** Awaited at the start of every call (a spec holds the handler open with it). */
  gate?: (events: EventEnvelope[]) => Promise<void>;
  /** Awaited after the effect, before returning. */
  afterEffect?: (events: EventEnvelope[]) => Promise<void>;
  /** Total invocations per event id. */
  invocationsOf(eventId: string): number;
  reset(): void;
}

export interface FixtureConsumerOptions {
  name: string;
  topics: string[];
  kind: IdempotencyMechanism;
  handles: HandledEvent[];
  coalesce?: boolean;
  attempts?: number;
  replayable?: boolean;
  aggregateIdSchema?: ZodType;
  /** Event type that deletes: the version-guard consumer then keeps a tombstone at that version. */
  deleteType?: string;
}

const newProbe = (): ConsumerProbe => {
  const probe: ConsumerProbe = {
    calls: [],
    inHandler: 0,
    maxInHandler: 0,
    throwBefore: new Map(),
    throwAfter: new Map(),
    invocationsOf: (eventId) =>
      probe.calls.filter((c) => c.events.some((e) => e.eventId === eventId))
        .length,
    reset() {
      probe.calls = [];
      probe.inHandler = 0;
      probe.maxInHandler = 0;
      probe.throwBefore.clear();
      probe.throwAfter.clear();
      probe.gate = undefined;
      probe.afterEffect = undefined;
    },
  };
  return probe;
};

const maybeThrow = (
  table: ConsumerProbe['throwBefore'],
  events: EventEnvelope[],
): void => {
  for (const event of events) {
    const rule = table.get(event.eventId);
    if (!rule || rule.times === 0) continue;
    if (rule.times > 0) rule.times--;
    throw rule.error();
  }
};

/**
 * A consumer class for the e2e specs, one per idempotency mechanism:
 *  - `inbox`: inserts one effect row per event; the framework's inbox record makes a duplicate harmless;
 *  - `versionGuard`: a versioned document per aggregate, written only when newer (returns the outcome counts);
 *  - `natural`: an upsert by business key.
 */
export function fixtureConsumer(
  options: FixtureConsumerOptions,
): Type<Projector & { probe: ConsumerProbe }> {
  @Injectable()
  class FixtureConsumer implements Projector, OnModuleInit {
    readonly name = options.name;
    readonly topics = options.topics;
    readonly idempotency = options.kind;
    readonly handles = options.handles;
    readonly coalesce = options.coalesce;
    readonly attempts = options.attempts;
    readonly replayable = options.replayable;
    readonly aggregateIdSchema = options.aggregateIdSchema;
    readonly probe = newProbe();

    constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

    async onModuleInit(): Promise<void> {
      await ensureFixtureTables(this.sequelize);
    }

    async project(events: EventEnvelope[]): Promise<void | SinkCounts> {
      const call = {
        events,
        startedAt: Date.now(),
      } as ConsumerProbe['calls'][number];
      this.probe.calls.push(call);
      this.probe.inHandler += events.length;
      this.probe.maxInHandler = Math.max(
        this.probe.maxInHandler,
        this.probe.inHandler,
      );
      try {
        await this.probe.gate?.(events);
        maybeThrow(this.probe.throwBefore, events);
        const counts = await this.apply(events);
        maybeThrow(this.probe.throwAfter, events);
        await this.probe.afterEffect?.(events);
        return counts;
      } finally {
        this.probe.inHandler -= events.length;
        call.endedAt = Date.now();
      }
    }

    /** `name` (contract v1) or `title` (v2): what the fixture stores, so an upgraded v1 equals a native v2. */
    private nameOf(e: EventEnvelope): string {
      const payload = e.payload as { name?: string; title?: string };
      return String(payload.name ?? payload.title ?? '');
    }

    private async apply(events: EventEnvelope[]): Promise<void | SinkCounts> {
      if (options.kind === 'inbox') {
        for (const e of events)
          await this.sequelize.query(
            `INSERT INTO "S53FixtureEffect" ("consumer", "aggregateId", "eventId", "name") VALUES ($1, $2, $3, $4)`,
            { bind: [options.name, e.aggregateId, e.eventId, this.nameOf(e)] },
          );
        return;
      }
      if (options.kind === 'natural') {
        for (const e of events)
          await this.sequelize.query(
            `INSERT INTO "S53FixtureNatural" ("consumer", "key", "value") VALUES ($1, $2, $3)
             ON CONFLICT ("consumer", "key") DO UPDATE SET "value" = EXCLUDED."value"`,
            { bind: [options.name, e.aggregateId, this.nameOf(e)] },
          );
        return;
      }
      const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
      for (const e of events) {
        const [written] = (
          await this.sequelize.query(
            `INSERT INTO "S53FixtureDoc" ("consumer", "aggregateId", "version", "name", "deleted") VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ("consumer", "aggregateId") DO UPDATE
             SET "version" = EXCLUDED."version", "name" = EXCLUDED."name", "deleted" = EXCLUDED."deleted"
             WHERE "S53FixtureDoc"."version" < EXCLUDED."version"
           RETURNING 1`,
            {
              bind: [
                options.name,
                e.aggregateId,
                e.aggregateVersion,
                this.nameOf(e),
                e.type === options.deleteType,
              ],
            },
          )
        )[0];
        if (written) {
          counts.applied++;
          continue;
        }
        const stored = await this.stored(e.aggregateId);
        counts[
          applyIfNewer(stored, e.aggregateVersion) === 'duplicate'
            ? 'duplicate'
            : 'stale'
        ]++;
      }
      return counts;
    }

    private async stored(aggregateId: string): Promise<number | null> {
      const [rows] = await this.sequelize.query(
        `SELECT "version" FROM "S53FixtureDoc" WHERE "consumer" = $1 AND "aggregateId" = $2`,
        { bind: [options.name, aggregateId] },
      );
      const row = (rows as { version: string }[])[0];
      return row ? Number(row.version) : null;
    }
  }
  return FixtureConsumer;
}

export type { EventDefinition };

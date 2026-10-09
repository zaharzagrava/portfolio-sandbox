import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { v7 as uuidv7 } from 'uuid';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { EventEnvelope } from '../event-envelope';
import { TopicRegistry } from '../topic-registry';
import { FIXTURE_AGGREGATE, FixtureItemChanged } from './fixture-events';

/** The aggregate's conditional update found another version (optimistic-lock conflict). */
export class FixtureConflictError extends Error {
  constructor(id: string) {
    super(`Fixture ${id} was changed concurrently`);
    this.name = 'FixtureConflictError';
  }
}

export interface FixtureRow {
  id: string;
  tenantId: string;
  name: string;
  version: number;
}

/**
 * Fixture aggregate for the S53 e2e specs: a tenant-scoped table (created here, test code only, no migration) and
 * operations that change state and append events in one transaction, exactly as a domain service would.
 */
@Injectable()
export class FixtureService implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly outbox: OutboxService,
    private readonly runner: TransactionRunner,
    private readonly topics: TopicRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.sequelize.query(`
      CREATE TABLE IF NOT EXISTS "S53Fixture" (
        "id" uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "name" text NOT NULL,
        "version" integer NOT NULL
      )`);
    if (!this.topics.has(FIXTURE_AGGREGATE))
      this.topics.register({
        aggregateType: FIXTURE_AGGREGATE,
        retention: 'full-history',
      });
  }

  /** Inserts an aggregate at `version` without an event (the "Given A at version 3" of the scenarios). */
  async seed(tenantId: string, name = 'seed', version = 0): Promise<string> {
    const id = uuidv7();
    await this.sequelize.query(
      `INSERT INTO "S53Fixture" ("id", "tenantId", "name", "version") VALUES ($1, $2, $3, $4)`,
      { bind: [id, tenantId, name, version] },
    );
    return id;
  }

  async get(id: string): Promise<FixtureRow | null> {
    const [rows] = await this.sequelize.query(
      `SELECT * FROM "S53Fixture" WHERE "id" = $1`,
      { bind: [id] },
    );
    return (rows[0] as FixtureRow | undefined) ?? null;
  }

  async count(): Promise<number> {
    const [rows] = await this.sequelize.query(
      `SELECT count(*)::int AS n FROM "S53Fixture"`,
    );
    return (rows[0] as { n: number }).n;
  }

  /**
   * Conditional update `version = expected → expected + 1` plus the events `build` returns for the new version,
   * in one transaction.
   */
  async changeWith(
    id: string,
    expectedVersion: number,
    name: string,
    build: (version: number) => EventEnvelope | EventEnvelope[],
    options: { failAfterAppend?: boolean } = {},
  ): Promise<number> {
    return this.runner.run(async (tx) => {
      const [rows] = await this.sequelize.query(
        `UPDATE "S53Fixture" SET "name" = $1, "version" = "version" + 1
         WHERE "id" = $2 AND "version" = $3 RETURNING "version"`,
        { bind: [name, id, expectedVersion], transaction: tx },
      );
      if (rows.length === 0) throw new FixtureConflictError(id);
      const version = (rows[0] as { version: number }).version;
      await this.outbox.append(build(version));
      if (options.failAfterAppend) throw new Error('boom after append');
      return version;
    });
  }

  /** The common case: rename and announce `fixtures.item_changed`. */
  rename(
    id: string,
    expectedVersion: number,
    name: string,
    options: { failAfterAppend?: boolean } = {},
  ): Promise<number> {
    return this.changeWith(
      id,
      expectedVersion,
      name,
      (version) => FixtureItemChanged.create(id, version, { name }),
      options,
    );
  }

  /** Appends a prepared list inside one transaction (several events, one statement). */
  async appendInTransaction(events: EventEnvelope[]): Promise<void> {
    await this.runner.run(async () => {
      await this.outbox.append(events);
    });
  }

  /** `append` outside any transaction, to prove it refuses. */
  appendWithoutTransaction(events: EventEnvelope[]): Promise<void> {
    return this.outbox.append(events);
  }
}

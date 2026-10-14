import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { monthBounds, monthPartitionName } from '../domain/partition-months';
import type { PartitionRepository } from '../domain/ports';
import { select } from './sql';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** DDL of the monthly partitions. Names come from `monthPartitionName` after a shape check, never from input. */
@Injectable()
export class SequelizePartitionRepository implements PartitionRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async lock(): Promise<void> {
    await select(
      this.sequelize,
      `SELECT pg_advisory_xact_lock(hashtext('chat.partition-maintenance'))`,
    );
  }

  async existing(): Promise<Set<string>> {
    const rows = await select<{ relname: string }>(
      this.sequelize,
      `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = '"ChatMessage"'::regclass`,
    );
    return new Set(
      rows
        .map((r) => /^ChatMessage_(\d{4})_(\d{2})$/.exec(r.relname))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => `${m[1]}-${m[2]}`),
    );
  }

  async oldestDefault(): Promise<Date | null> {
    const [row] = await select<{ oldest: Date | null }>(
      this.sequelize,
      `SELECT min("createdAt") AS oldest FROM "ChatMessage_default"`,
    );
    return row?.oldest ?? null;
  }

  async defaultRows(): Promise<number> {
    const [row] = await select<{ n: string }>(
      this.sequelize,
      `SELECT count(*)::text AS n FROM "ChatMessage_default"`,
    );
    return Number(row?.n ?? 0);
  }

  async create(month: string): Promise<{ moved: number }> {
    if (!MONTH.test(month)) throw new Error(`not a month: ${month}`);
    const name = monthPartitionName(month);
    const { from, to } = monthBounds(month);
    const q = (sql: string, replacements: object = {}) =>
      this.sequelize.query(sql, {
        replacements: replacements as Record<string, unknown>,
      });

    // A standalone table first: rows parked in the default partition for this month are moved into it, then it is
    // attached (a partition cannot be created while the default partition holds rows of its range).
    await q(`CREATE TABLE "${name}" (LIKE "ChatMessage" INCLUDING DEFAULTS)`);
    const moved = await select<{ n: string }>(
      this.sequelize,
      `WITH moved AS (
         DELETE FROM "ChatMessage_default" WHERE "createdAt" >= :from AND "createdAt" < :to RETURNING *
       ), ins AS (
         INSERT INTO "${name}" SELECT * FROM moved RETURNING 1
       )
       SELECT count(*)::text AS n FROM ins`,
      { from, to },
    );
    await q(`ALTER TABLE "${name}" ADD PRIMARY KEY (id, "createdAt")`);
    await q(
      `CREATE UNIQUE INDEX "${name}_channel_seq_uq" ON "${name}" ("channelId", seq)`,
    );
    await q(
      `CREATE INDEX "${name}_channel_created_idx" ON "${name}" ("channelId", "createdAt" DESC)`,
    );
    await q(
      `ALTER TABLE "ChatMessage" ATTACH PARTITION "${name}" FOR VALUES FROM (:from) TO (:to)`,
      { from, to },
    );
    return { moved: Number(moved[0]?.n ?? 0) };
  }
}

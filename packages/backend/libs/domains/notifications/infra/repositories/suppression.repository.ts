import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { Channel } from '../../domain/catalog';
import type { SuppressionRepository } from '../../domain/ports';
import type { SuppressionReason } from '../../domain/types';
import { rows } from './pg';

/**
 * Postgres adapter of `SUPPRESSION_REPOSITORY`: the only code that touches `NotificationSuppression`. Reads go to
 * the table every time (no cache, no negative cache): a suppression is in effect for the very next send. Callers pass
 * normalized addresses.
 */
@Injectable()
export class PgSuppressionRepository implements SuppressionRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async suppressedAmong(
    channel: Channel,
    addresses: string[],
  ): Promise<Set<string>> {
    if (addresses.length === 0) return new Set();
    const found = await rows<{ address: string }>(
      this.sequelize,
      `SELECT "address" FROM "NotificationSuppression" WHERE "channel" = $1 AND "address" = ANY($2::text[])`,
      [channel, addresses],
    );
    return new Set(found.map((r) => r.address));
  }

  async add(
    channel: Channel,
    address: string,
    reason: SuppressionReason,
    now: Date,
  ): Promise<boolean> {
    const created = await rows<{ address: string }>(
      this.sequelize,
      `INSERT INTO "NotificationSuppression" ("channel","address","reason","createdAt") VALUES ($1,$2,$3,$4)
       ON CONFLICT ("channel","address") DO NOTHING RETURNING "address"`,
      [channel, address, reason, now],
    );
    return created.length === 1;
  }
}

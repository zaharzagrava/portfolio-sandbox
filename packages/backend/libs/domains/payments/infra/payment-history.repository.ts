import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  PaymentHistoryEntry,
  PaymentHistoryRepository,
} from '../domain/ports';
import type { PaymentStatus } from '../domain/payment-status';

/** Append-only (AS-42): `insert` and `listByPayment` are the whole surface; there is no update and no delete. */
@Injectable()
export class SequelizePaymentHistoryRepository implements PaymentHistoryRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async insert(entry: PaymentHistoryEntry): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO "PaymentHistory" ("paymentId", "version", "fromStatus", "toStatus", "reason", "actor", "at")
       VALUES (:paymentId, :version, :from, :to, :reason, :actor, :at)`,
      {
        replacements: {
          paymentId: entry.paymentId,
          version: entry.version,
          from: entry.fromStatus,
          to: entry.toStatus,
          reason: entry.reason,
          actor: entry.actor,
          at: entry.at,
        },
      },
    );
  }

  async listByPayment(paymentId: string): Promise<PaymentHistoryEntry[]> {
    const rows = await this.sequelize.query<{
      paymentId: string;
      version: number;
      fromStatus: PaymentStatus | null;
      toStatus: PaymentStatus;
      reason: string | null;
      actor: string;
      at: Date;
    }>(
      `SELECT "paymentId", "version", "fromStatus", "toStatus", "reason", "actor", "at"
       FROM "PaymentHistory" WHERE "paymentId" = :paymentId ORDER BY "version", "at"`,
      { type: QueryTypes.SELECT, replacements: { paymentId } },
    );
    return rows;
  }
}

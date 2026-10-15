import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type { ReceiptRepository } from '../../domain/ports';
import { count } from './sql';

/** `WebhookReceipt` (own table): first-delivery dedupe. */
@Injectable()
export class SequelizeReceiptRepository implements ReceiptRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async insertIfNew(
    integrationId: string,
    deliveryId: string,
    receivedAt: Date,
  ): Promise<boolean> {
    return (
      (await count(
        this.db,
        `INSERT INTO "WebhookReceipt" ("integrationId", "deliveryId", "receivedAt")
         VALUES (:integrationId, :deliveryId, :receivedAt) ON CONFLICT DO NOTHING RETURNING 1`,
        { integrationId, deliveryId, receivedAt },
      )) > 0
    );
  }

  async remove(integrationId: string, deliveryId: string): Promise<void> {
    await count(
      this.db,
      `DELETE FROM "WebhookReceipt" WHERE "integrationId" = :integrationId AND "deliveryId" = :deliveryId RETURNING 1`,
      { integrationId, deliveryId },
    );
  }

  purgeReceivedBefore(before: Date, limit: number): Promise<number> {
    return count(
      this.db,
      `DELETE FROM "WebhookReceipt" WHERE ctid IN (SELECT ctid FROM "WebhookReceipt" WHERE "receivedAt" < :before ORDER BY "receivedAt" LIMIT :limit)
       RETURNING 1`,
      { before, limit },
    );
  }
}

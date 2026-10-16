import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type { RealtimeAccessPort } from '../domain/delivery-ports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who may follow a delivery (S20 FR-040, A23): ONE query on this domain's own store with the principal in the
 * predicate - the buyer, or the courier the delivery is assigned to. A shop member, a courier that only held an offer
 * and an unknown delivery id all find no row. A value that cannot be an id never reaches the database.
 */
@Injectable()
export class RealtimeAccessSqlAdapter implements RealtimeAccessPort {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async canSubscribe(deliveryId: string, userId: string): Promise<boolean> {
    if (!UUID.test(deliveryId) || !UUID.test(userId)) return false;
    const rows = await this.sequelize.query(
      `SELECT 1 FROM "Delivery"
        WHERE "id" = :deliveryId AND ("buyerId" = :userId OR "courierId" = :userId)
        LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { deliveryId, userId } },
    );
    return rows.length > 0;
  }
}

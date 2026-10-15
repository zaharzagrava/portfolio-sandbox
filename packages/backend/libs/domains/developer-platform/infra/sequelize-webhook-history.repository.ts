import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { EndpointHistory, HistoryEntry } from '../domain/webhook-ports';

/**
 * `WebhookEndpointHistory`: append-only state changes, kept 400 days, no foreign key (it survives the endpoint).
 * `fromValue` and `toValue` are never a secret; URL facets carry the host only (the caller decides what to pass).
 */
@Injectable()
export class SequelizeWebhookHistoryRepository extends EndpointHistory {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {
    super();
  }

  async append(entries: HistoryEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const values = entries
      .map(
        (_, i) =>
          `(:endpointId${i}, :shopId${i}, :facet${i}, :fromValue${i}, :toValue${i}, :actorId${i}, :at${i})`,
      )
      .join(', ');
    const replacements: Record<string, unknown> = {};
    entries.forEach((e, i) => {
      replacements[`endpointId${i}`] = e.endpointId;
      replacements[`shopId${i}`] = e.shopId;
      replacements[`facet${i}`] = e.facet;
      replacements[`fromValue${i}`] = e.fromValue;
      replacements[`toValue${i}`] = e.toValue;
      replacements[`actorId${i}`] = e.actorId;
      replacements[`at${i}`] = e.at;
    });
    await this.sequelize.query(
      `INSERT INTO "WebhookEndpointHistory" ("endpointId", "shopId", facet, "fromValue", "toValue", "actorId", "createdAt")
       VALUES ${values}`,
      { replacements },
    );
  }

  async listForEndpoint(
    shopId: string,
    endpointId: string,
    limit: number,
  ): Promise<HistoryEntry[]> {
    const rows = await this.sequelize.query<
      Omit<HistoryEntry, 'at'> & { createdAt: Date }
    >(
      `SELECT "endpointId", "shopId", facet, "fromValue", "toValue", "actorId", "createdAt"
         FROM "WebhookEndpointHistory"
        WHERE "endpointId" = :endpointId AND "shopId" = :shopId
        ORDER BY "createdAt", id LIMIT :limit`,
      { type: QueryTypes.SELECT, replacements: { shopId, endpointId, limit } },
    );
    return rows.map(({ createdAt, ...rest }) => ({ ...rest, at: createdAt }));
  }

  async deleteForShop(shopId: string, limit: number): Promise<number> {
    const removed = await this.sequelize.query(
      `DELETE FROM "WebhookEndpointHistory"
        WHERE id IN (SELECT id FROM "WebhookEndpointHistory" WHERE "shopId" = :shopId LIMIT :limit)
        RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { shopId, limit } },
    );
    return removed.length;
  }

  async deleteOlderThan(cutoff: Date, limit: number): Promise<number> {
    const removed = await this.sequelize.query(
      `DELETE FROM "WebhookEndpointHistory"
        WHERE id IN (SELECT id FROM "WebhookEndpointHistory" WHERE "createdAt" <= :cutoff ORDER BY "createdAt" LIMIT :limit)
        RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { cutoff, limit } },
    );
    return removed.length;
  }
}

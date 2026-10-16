import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import type {
  StatusHistoryEntry,
  StatusHistoryRepository,
} from '../domain/ports';

/** `OnboardingStatusHistory` (own table): one row per transition, written in the transition's transaction (FR-062). */
@Injectable()
export class SequelizeStatusHistoryRepository implements StatusHistoryRepository {
  constructor(@InjectConnection() private readonly db: Sequelize) {}

  async append(entries: StatusHistoryEntry | StatusHistoryEntry[]): Promise<void> {
    const list = Array.isArray(entries) ? entries : [entries];
    if (list.length === 0) return;
    const values = list
      .map(
        (_, i) =>
          `(:entity${i}, :entityId${i}, :shopId${i}, :from${i}, :to${i}, :actor${i}, :reason${i}, :at${i})`,
      )
      .join(', ');
    const replacements: Record<string, unknown> = {};
    list.forEach((e, i) => {
      replacements[`entity${i}`] = e.entity;
      replacements[`entityId${i}`] = e.entityId;
      replacements[`shopId${i}`] = e.shopId;
      replacements[`from${i}`] = e.fromStatus;
      replacements[`to${i}`] = e.toStatus;
      replacements[`actor${i}`] = e.actor;
      replacements[`reason${i}`] = e.reasonCode ?? null;
      replacements[`at${i}`] = e.at;
    });
    await this.db.query(
      `INSERT INTO "OnboardingStatusHistory" ("entity", "entityId", "shopId", "fromStatus", "toStatus", "actor", "reasonCode", "at") VALUES ${values}`,
      { type: QueryTypes.INSERT, replacements },
    );
  }

  async erase(shopId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM "OnboardingStatusHistory" WHERE "shopId" = :shopId`,
      { replacements: { shopId } },
    );
  }
}

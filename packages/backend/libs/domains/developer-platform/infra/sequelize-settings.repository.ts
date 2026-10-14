import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context/transaction-runner.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { ApiVersionPinned } from '../application/events/api-events';
import { SettingsRepository } from '../domain/ports';

/** `ShopApiSettings`: the shop's pinned API version (FR-025, FR-028). */
@Injectable()
export class SequelizeSettingsRepository extends SettingsRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {
    super();
  }

  async getPinned(
    shopId: string,
  ): Promise<{ version: string; pinnedAt: Date | null } | null> {
    const [row] = await this.sequelize.query<{
      pinnedVersion: string;
      pinnedAt: Date | null;
    }>(
      `SELECT "pinnedVersion", "pinnedAt" FROM "ShopApiSettings" WHERE "shopId" = :shopId`,
      { type: QueryTypes.SELECT, replacements: { shopId } },
    );
    return row ? { version: row.pinnedVersion, pinnedAt: row.pinnedAt } : null;
  }

  async getPinnedMany(shopIds: string[]): Promise<Map<string, string>> {
    if (shopIds.length === 0) return new Map();
    const rows = await this.sequelize.query<{
      shopId: string;
      pinnedVersion: string;
    }>(
      `SELECT "shopId", "pinnedVersion" FROM "ShopApiSettings" WHERE "shopId" IN (:shopIds)`,
      { type: QueryTypes.SELECT, replacements: { shopIds } },
    );
    return new Map(rows.map((r) => [r.shopId, r.pinnedVersion]));
  }

  async pinIfAbsent(
    shopId: string,
    version: string,
    now: Date,
  ): Promise<string> {
    const [row] = await this.sequelize.query<{ pinnedVersion: string }>(
      `INSERT INTO "ShopApiSettings" ("shopId", "pinnedVersion", "pinnedAt", "updatedAt")
       VALUES (:shopId, :version, :now, :now)
       ON CONFLICT ("shopId") DO UPDATE SET "pinnedVersion" = "ShopApiSettings"."pinnedVersion"
       RETURNING "pinnedVersion"`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId, version, now },
      },
    );
    return row.pinnedVersion;
  }

  async change(input: {
    shopId: string;
    version: string;
    now: Date;
    actorId: string;
  }): Promise<{ previousVersion: string | null; pinnedAt: Date }> {
    const { shopId, version, now, actorId } = input;
    return this.runner.run(async (tx) => {
      const [before] = await this.sequelize.query<{
        pinnedVersion: string;
        pinnedAt: Date | null;
      }>(
        `SELECT "pinnedVersion", "pinnedAt" FROM "ShopApiSettings" WHERE "shopId" = :shopId FOR UPDATE`,
        { type: QueryTypes.SELECT, transaction: tx, replacements: { shopId } },
      );
      // the same version again changes nothing and emits nothing (FR-028)
      if (before?.pinnedVersion === version)
        return {
          previousVersion: version,
          pinnedAt: before.pinnedAt ?? now,
        };
      await this.sequelize.query(
        `INSERT INTO "ShopApiSettings" ("shopId", "pinnedVersion", "pinnedAt", "updatedAt")
         VALUES (:shopId, :version, :now, :now)
         ON CONFLICT ("shopId") DO UPDATE
           SET "pinnedVersion" = EXCLUDED."pinnedVersion", "pinnedAt" = EXCLUDED."pinnedAt", "updatedAt" = EXCLUDED."updatedAt"`,
        { transaction: tx, replacements: { shopId, version, now } },
      );
      const previousVersion = before?.pinnedVersion ?? null;
      await this.outbox.append(
        ApiVersionPinned.create(
          shopId,
          Math.floor(now.getTime() / 1000),
          { shopId, version, previousVersion, actorId },
          now,
        ),
        tx,
      );
      return { previousVersion, pinnedAt: now };
    });
  }
}

import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import type { Channel } from '../../domain/catalog';
import type { PreferenceRepository } from '../../domain/ports';
import { rows } from './pg';

interface OverrideRow {
  userId: string;
  category: string;
  channel: string;
  enabled: boolean;
}

/** Postgres adapter of `PREFERENCE_REPOSITORY`: the only code that touches `NotificationPreference`. */
@Injectable()
export class PgPreferenceRepository implements PreferenceRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async overrides(userId: string): Promise<Record<string, boolean>> {
    return (await this.overridesMany([userId])).get(userId) ?? {};
  }

  async overridesMany(
    userIds: string[],
  ): Promise<Map<string, Record<string, boolean>>> {
    const out = new Map<string, Record<string, boolean>>();
    if (userIds.length === 0) return out;
    const found = await rows<OverrideRow>(
      this.sequelize,
      `SELECT "userId","category","channel","enabled" FROM "NotificationPreference" WHERE "userId" = ANY($1::uuid[])`,
      [userIds],
    );
    for (const r of found) {
      const forUser = out.get(r.userId) ?? {};
      forUser[`${r.category}:${r.channel}`] = r.enabled;
      out.set(r.userId, forUser);
    }
    return out;
  }

  async set(
    userId: string,
    category: string,
    channel: Channel,
    enabled: boolean,
    now: Date,
  ): Promise<void> {
    await rows(
      this.sequelize,
      `INSERT INTO "NotificationPreference" ("userId","category","channel","enabled","updatedAt")
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT ("userId","category","channel") DO UPDATE SET "enabled" = EXCLUDED."enabled", "updatedAt" = EXCLUDED."updatedAt"`,
      [userId, category, channel, enabled, now],
    );
  }
}

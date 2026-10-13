import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  SettingsPatch,
  SettingsRepository,
  StoredSettings,
} from '../../domain/ports';
import { rows } from './pg';

const COLUMNS = `"userId","timezone","locale","quietStart","quietEnd","phone","phoneVerifiedAt","updatedAt"`;

/** Postgres adapter of `SETTINGS_REPOSITORY`: the only code that touches `NotificationSettings`. */
@Injectable()
export class PgSettingsRepository implements SettingsRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  async find(userId: string): Promise<StoredSettings | null> {
    const found = await rows<StoredSettings>(
      this.sequelize,
      `SELECT ${COLUMNS} FROM "NotificationSettings" WHERE "userId" = $1`,
      [userId],
    );
    return found[0] ?? null;
  }

  async findMany(userIds: string[]): Promise<Map<string, StoredSettings>> {
    if (userIds.length === 0) return new Map();
    const found = await rows<StoredSettings>(
      this.sequelize,
      `SELECT ${COLUMNS} FROM "NotificationSettings" WHERE "userId" = ANY($1::uuid[])`,
      [userIds],
    );
    return new Map(found.map((s) => [s.userId, s]));
  }

  /**
   * One upsert; only the keys present in the patch change. Writing a different phone clears `phoneVerifiedAt` in the
   * same statement (every SET expression reads the old row).
   */
  async update(
    userId: string,
    patch: SettingsPatch,
    now: Date,
  ): Promise<StoredSettings> {
    const has = (key: keyof SettingsPatch) => patch[key] !== undefined;
    const written = await rows<StoredSettings>(
      this.sequelize,
      `INSERT INTO "NotificationSettings" ("userId","timezone","locale","quietStart","quietEnd","phone","updatedAt")
       VALUES ($1, coalesce($2::text,'UTC'), coalesce($3::text,'en'),
               CASE WHEN $9::boolean AND $10::boolean THEN $4::text END,
               CASE WHEN $9::boolean AND $10::boolean THEN $5::text END, $6::text, $12::timestamptz)
       ON CONFLICT ("userId") DO UPDATE SET
         "timezone" = CASE WHEN $7::boolean THEN $2::text ELSE "NotificationSettings"."timezone" END,
         "locale" = CASE WHEN $8::boolean THEN $3::text ELSE "NotificationSettings"."locale" END,
         "quietStart" = CASE WHEN $9::boolean THEN $4::text ELSE "NotificationSettings"."quietStart" END,
         "quietEnd" = CASE WHEN $10::boolean THEN $5::text ELSE "NotificationSettings"."quietEnd" END,
         "phone" = CASE WHEN $11::boolean THEN $6::text ELSE "NotificationSettings"."phone" END,
         "phoneVerifiedAt" = CASE
           WHEN $11::boolean AND $6::text IS DISTINCT FROM "NotificationSettings"."phone" THEN NULL
           ELSE "NotificationSettings"."phoneVerifiedAt" END,
         "updatedAt" = $12::timestamptz
       RETURNING ${COLUMNS}`,
      [
        userId,
        patch.timezone ?? null,
        patch.locale ?? null,
        patch.quietStart ?? null,
        patch.quietEnd ?? null,
        patch.phone ?? null,
        has('timezone'),
        has('locale'),
        has('quietStart'),
        has('quietEnd'),
        has('phone'),
        now,
      ],
    );
    return written[0];
  }

  async markPhoneVerified(
    userId: string,
    phone: string,
    now: Date,
  ): Promise<boolean> {
    const done = await rows<{ userId: string }>(
      this.sequelize,
      `UPDATE "NotificationSettings" SET "phoneVerifiedAt" = $3, "updatedAt" = $3
       WHERE "userId" = $1 AND "phone" = $2 RETURNING "userId"`,
      [userId, phone, now],
    );
    return done.length === 1;
  }
}

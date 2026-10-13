import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import type { DeviceRecord, DeviceRepository } from '../../domain/ports';
import { rows } from './pg';

const COLUMNS = `"id","userId","platform","token","lastSeenAt"`;

/** SHA-256 of a push token, hex: what logs and lookups may use instead of the token. */
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** Postgres adapter of `DEVICE_REPOSITORY`: the only code that touches `PushDevice`. */
@Injectable()
export class PgDeviceRepository implements DeviceRepository {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
  ) {}

  list(userId: string): Promise<DeviceRecord[]> {
    return rows<DeviceRecord>(
      this.sequelize,
      `SELECT ${COLUMNS} FROM "PushDevice" WHERE "userId" = $1 ORDER BY "lastSeenAt" DESC, "token"`,
      [userId],
    );
  }

  async listMany(userIds: string[]): Promise<Map<string, DeviceRecord[]>> {
    const out = new Map<string, DeviceRecord[]>();
    if (userIds.length === 0) return out;
    const found = await rows<DeviceRecord>(
      this.sequelize,
      `SELECT ${COLUMNS} FROM "PushDevice" WHERE "userId" = ANY($1::uuid[]) ORDER BY "lastSeenAt" DESC, "token"`,
      [userIds],
    );
    for (const d of found) out.set(d.userId, [...(out.get(d.userId) ?? []), d]);
    return out;
  }

  /** Upsert on the token, then evict the oldest beyond `cap`: two statements, one transaction, no network I/O. */
  register(
    input: {
      userId: string;
      token: string;
      platform: DeviceRecord['platform'];
    },
    cap: number,
    now: Date,
  ): Promise<{
    device: DeviceRecord;
    created: boolean;
    previousUserId: string | null;
  }> {
    return this.transactions.run(async () => {
      const [before] = await rows<{ userId: string }>(
        this.sequelize,
        `SELECT "userId" FROM "PushDevice" WHERE "token" = $1 FOR UPDATE`,
        [input.token],
      );
      const written = await rows<DeviceRecord & { inserted: boolean }>(
        this.sequelize,
        `INSERT INTO "PushDevice" ("token","userId","platform","tokenHash","lastSeenAt")
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT ("token") DO UPDATE SET
           "userId" = EXCLUDED."userId", "platform" = EXCLUDED."platform",
           "tokenHash" = EXCLUDED."tokenHash", "lastSeenAt" = EXCLUDED."lastSeenAt"
         RETURNING ${COLUMNS}, (xmax = 0) AS "inserted"`,
        [
          input.token,
          input.userId,
          input.platform,
          tokenHash(input.token),
          now,
        ],
      );
      await rows(
        this.sequelize,
        `DELETE FROM "PushDevice" WHERE "token" IN (
           SELECT "token" FROM "PushDevice" WHERE "userId" = $1 ORDER BY "lastSeenAt" DESC, "token" OFFSET $2
         )`,
        [input.userId, cap],
      );
      const { inserted, ...device } = written[0];
      const previous = before?.userId;
      return {
        device,
        created: inserted,
        previousUserId: previous && previous !== input.userId ? previous : null,
      };
    });
  }

  async remove(userId: string, deviceId: string): Promise<boolean> {
    const gone = await rows<{ id: string }>(
      this.sequelize,
      `DELETE FROM "PushDevice" WHERE "id" = $1 AND "userId" = $2 RETURNING "id"`,
      [deviceId, userId],
    );
    return gone.length === 1;
  }

  async removeByToken(token: string): Promise<string | null> {
    const gone = await rows<{ userId: string }>(
      this.sequelize,
      `DELETE FROM "PushDevice" WHERE "token" = $1 RETURNING "userId"`,
      [token],
    );
    return gone[0]?.userId ?? null;
  }
}

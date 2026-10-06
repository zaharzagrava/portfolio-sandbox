import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { CacheService } from '@app/infrastructure/cache/cache.service';

const key = (channel: string, address: string) => `notif:supp:${channel}:${address.toLowerCase()}`;

/**
 * Addresses we must never contact again (hard bounce, spam complaint, carrier
 * STOP, dead push token). Postgres is the record; checks go through the cache
 * with negative caching, because almost every check is a "not suppressed" miss.
 * Sending to known-bad addresses is how a sender's SES reputation gets suspended.
 */
@Injectable()
export class SuppressionService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly cache: CacheService,
  ) {}

  async isSuppressed(channel: string, address: string): Promise<boolean> {
    const hit = await this.cache.getOrLoad<{ reason: string }>(
      key(channel, address),
      async () => {
        const [row] = await this.sequelize.query<{ reason: string }>(
          `SELECT reason FROM "NotificationSuppression" WHERE channel = :channel AND address = :address`,
          { type: QueryTypes.SELECT, replacements: { channel, address: address.toLowerCase() } },
        );
        return row ?? null;
      },
      { ttlMs: 600_000, negativeTtlMs: 600_000, l1: 'never' },
    );
    return !!hit;
  }

  async suppress(channel: string, addresses: string[], reason: string): Promise<void> {
    for (const address of addresses) {
      await this.sequelize.query(
        `INSERT INTO "NotificationSuppression" (channel, address, reason) VALUES (:channel, :address, :reason) ON CONFLICT DO NOTHING`,
        { replacements: { channel, address: address.toLowerCase(), reason } },
      );
    }
    await this.cache.invalidate(addresses.map((a) => key(channel, a)));
  }
}

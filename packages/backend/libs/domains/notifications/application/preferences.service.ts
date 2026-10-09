import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import {
  Category,
  CATEGORIES,
  Channel,
  CHANNELS,
  NotificationType,
  OPT_IN_CHANNELS,
  typeDef,
} from '../domain/catalog';
import { Recipient } from '../domain/types';

const recipientKey = (userId: string) => `notif:recipient:${userId}`;

export interface SettingsInput {
  timezone?: string;
  locale?: string;
  quietStart?: string | null;
  quietEnd?: string | null;
  phone?: string | null;
}

/**
 * Who the user is and what they want, as ONE cached object per user: the
 * router resolves it for every recipient of every event, so it must not be a
 * Postgres round trip each time (5-minute TTL + SWR, invalidated on change).
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly cache: CacheService,
  ) {}

  async recipients(userIds: string[]): Promise<Map<string, Recipient>> {
    const unique = [...new Set(userIds)];
    const loaded = await Promise.all(
      unique.map((id) =>
        this.cache.getOrLoad<Recipient>(recipientKey(id), () => this.load(id), {
          ttlMs: 300_000,
          swrMs: 60_000,
          negativeTtlMs: 30_000,
          l1: 'hot',
        }),
      ),
    );
    return new Map(
      loaded.filter((r): r is Recipient => !!r).map((r) => [r.userId, r]),
    );
  }

  /** Channels this notification goes to for this user, before suppressions / caps / quiet hours. */
  channelsFor(type: NotificationType, recipient: Recipient): Channel[] {
    const def = typeDef(type);
    return CHANNELS.filter((channel) => {
      const isDefault = def.channels.includes(channel);
      const override = recipient.overrides[`${def.category}:${channel}`];
      if (def.mandatory && isDefault) return true;
      if (override !== undefined)
        return override && (isDefault || OPT_IN_CHANNELS.includes(channel));
      return isDefault && !OPT_IN_CHANNELS.includes(channel);
    }).filter((channel) => {
      if (channel === 'email') return !!recipient.email;
      if (channel === 'sms') return !!recipient.phone;
      if (channel === 'push') return recipient.pushTokens.length > 0;
      return true;
    });
  }

  async matrix(userId: string) {
    const recipient = (await this.recipients([userId])).get(userId);
    const overrides = recipient?.overrides ?? {};
    return {
      settings: recipient && {
        timezone: recipient.timezone,
        locale: recipient.locale,
        quietStart: recipient.quietStart,
        quietEnd: recipient.quietEnd,
        phone: recipient.phone,
      },
      preferences: CATEGORIES.map((category) => ({
        category,
        channels: Object.fromEntries(
          CHANNELS.map((c) => [
            c,
            overrides[`${category}:${c}`] ?? defaultFor(category, c),
          ]),
        ),
      })),
    };
  }

  async setPreference(
    userId: string,
    category: Category,
    channel: Channel,
    enabled: boolean,
  ) {
    await this.sequelize.query(
      `INSERT INTO "NotificationPreference" ("userId", category, channel, enabled) VALUES (:userId, :category, :channel, :enabled)
       ON CONFLICT ("userId", category, channel) DO UPDATE SET enabled = EXCLUDED.enabled, "updatedAt" = now()`,
      { replacements: { userId, category, channel, enabled } },
    );
    await this.cache.invalidate([recipientKey(userId)]);
  }

  async updateSettings(userId: string, input: SettingsInput) {
    await this.sequelize.query(
      `INSERT INTO "NotificationSettings" ("userId", timezone, locale, "quietStart", "quietEnd", phone)
       VALUES (:userId, coalesce(:timezone, 'UTC'), coalesce(:locale, 'en'), :quietStart, :quietEnd, :phone)
       ON CONFLICT ("userId") DO UPDATE SET
         timezone = coalesce(:timezone, "NotificationSettings".timezone),
         locale = coalesce(:locale, "NotificationSettings".locale),
         "quietStart" = CASE WHEN :hasQuiet THEN :quietStart ELSE "NotificationSettings"."quietStart" END,
         "quietEnd" = CASE WHEN :hasQuiet THEN :quietEnd ELSE "NotificationSettings"."quietEnd" END,
         phone = CASE WHEN :hasPhone THEN :phone ELSE "NotificationSettings".phone END,
         "updatedAt" = now()`,
      {
        replacements: {
          userId,
          timezone: input.timezone ?? null,
          locale: input.locale ?? null,
          quietStart: input.quietStart ?? null,
          quietEnd: input.quietEnd ?? null,
          phone: input.phone ?? null,
          hasQuiet:
            input.quietStart !== undefined || input.quietEnd !== undefined,
          hasPhone: input.phone !== undefined,
        },
      },
    );
    await this.cache.invalidate([recipientKey(userId)]);
  }

  async registerDevice(
    userId: string,
    token: string,
    platform: 'ios' | 'android' | 'web',
  ) {
    // A token moves to whoever logged in on that device last.
    await this.sequelize.query(
      `INSERT INTO "PushDevice" (token, "userId", platform) VALUES (:token, :userId, :platform)
       ON CONFLICT (token) DO UPDATE SET "userId" = EXCLUDED."userId", platform = EXCLUDED.platform, "lastSeenAt" = now()`,
      { replacements: { token, userId, platform } },
    );
    await this.cache.invalidate([recipientKey(userId)]);
  }

  async removeDevices(tokens: string[]) {
    if (tokens.length === 0) return;
    const rows = await this.sequelize.query<{ userId: string }>(
      `DELETE FROM "PushDevice" WHERE token IN (:tokens) RETURNING "userId"`,
      {
        type: QueryTypes.SELECT,
        replacements: { tokens },
      },
    );
    await this.cache.invalidate([
      ...new Set(rows.map((r) => recipientKey(r.userId))),
    ]);
  }

  private async load(userId: string): Promise<Recipient | null> {
    const [row] = await this.sequelize.query<
      Omit<Recipient, 'overrides'> & {
        overrides: { k: string; v: boolean }[] | null;
      }
    >(
      `SELECT u.id AS "userId", u.email, s.phone,
              coalesce(s.locale, 'en') AS locale, coalesce(s.timezone, 'UTC') AS timezone, s."quietStart", s."quietEnd",
              coalesce((SELECT array_agg(token ORDER BY "lastSeenAt" DESC) FROM (SELECT token, "lastSeenAt" FROM "PushDevice" d WHERE d."userId" = u.id ORDER BY "lastSeenAt" DESC LIMIT 5) t), '{}') AS "pushTokens",
              (SELECT json_agg(json_build_object('k', p.category || ':' || p.channel, 'v', p.enabled)) FROM "NotificationPreference" p WHERE p."userId" = u.id) AS overrides
       FROM "User" u LEFT JOIN "NotificationSettings" s ON s."userId" = u.id
       WHERE u.id = :userId`,
      { type: QueryTypes.SELECT, replacements: { userId } },
    );
    if (!row) return null;
    return {
      ...row,
      overrides: Object.fromEntries(
        (row.overrides ?? []).map((o) => [o.k, o.v]),
      ),
    };
  }
}

function defaultFor(category: Category, channel: Channel): boolean {
  if (OPT_IN_CHANNELS.includes(channel)) return false;
  return channel === 'inapp' || category !== 'marketing' || channel === 'push';
}

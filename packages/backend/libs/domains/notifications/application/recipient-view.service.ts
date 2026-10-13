import { Inject, Injectable } from '@nestjs/common';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import {
  DEVICE_REPOSITORY,
  PREFERENCE_REPOSITORY,
  RECIPIENT_DIRECTORY,
  SETTINGS_REPOSITORY,
  type DeviceRepository,
  type PreferenceRepository,
  type RecipientDirectory,
  type SettingsRepository,
} from '../domain/ports';
import type { RecipientView } from '../domain/types';

const PREFIX = 'notif:rv:';
const keyOf = (userId: string) => `${PREFIX}${userId}`;
const userOf = (key: string) => key.slice(PREFIX.length);

/** Recipient views live at most 5 minutes (FR-019); every write that changes one invalidates it at once. */
const VIEW_TTL_MS = 300_000;
const BATCH = 500;

/**
 * Who a user is and what they want, read once per consumed batch (FR-007, research R-14). A view is built in code, never
 * by a join: the address comes from identity's directory, the rest from this domain's own tables through their
 * repositories (three `IN (...)` reads for all the missing users, not one per user). Views are cached in the shared
 * tier only (`l1: 'never'`), so a preference change made by one process is seen by every other at once after
 * `invalidate`. A user identity does not know has no view: nothing is sent to them.
 */
@Injectable()
export class RecipientViewService {
  constructor(
    @Inject(RECIPIENT_DIRECTORY) private readonly directory: RecipientDirectory,
    @Inject(SETTINGS_REPOSITORY) private readonly settings: SettingsRepository,
    @Inject(PREFERENCE_REPOSITORY)
    private readonly preferences: PreferenceRepository,
    @Inject(DEVICE_REPOSITORY) private readonly devices: DeviceRepository,
    private readonly cache: CacheService,
  ) {}

  async views(userIds: string[]): Promise<Map<string, RecipientView>> {
    const unique = [...new Set(userIds)];
    const out = new Map<string, RecipientView>();
    for (let i = 0; i < unique.length; i += BATCH) {
      const ids = unique.slice(i, i + BATCH);
      const found = await this.cache.getOrLoadMany<RecipientView>(
        ids.map(keyOf),
        (missing) => this.load(missing.map(userOf)),
        { ttlMs: VIEW_TTL_MS, l1: 'never' },
      );
      ids.forEach((id, index) => {
        const view = found[index];
        if (view) out.set(id, view);
      });
    }
    return out;
  }

  async view(userId: string): Promise<RecipientView | null> {
    return (await this.views([userId])).get(userId) ?? null;
  }

  /** After any write to the user's preferences, settings, devices or suppression-driven overrides. */
  async invalidate(userIds: string | string[]): Promise<void> {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    if (ids.length > 0) await this.cache.invalidate(ids.map(keyOf));
  }

  private async load(
    ids: string[],
  ): Promise<Map<string, RecipientView | null>> {
    const [users, settings, overrides, devices] = await Promise.all([
      this.directory.users(ids),
      this.settings.findMany(ids),
      this.preferences.overridesMany(ids),
      this.devices.listMany(ids),
    ]);
    return new Map(
      ids.map((id): [string, RecipientView | null] => {
        const user = users.get(id);
        if (!user) return [keyOf(id), null];
        const own = settings.get(id);
        return [
          keyOf(id),
          {
            userId: id,
            email: user.email,
            phone: own?.phone ?? null,
            phoneVerified: !!own?.phoneVerifiedAt,
            locale: own?.locale ?? 'en',
            timezone: own?.timezone ?? 'UTC',
            quietStart: own?.quietStart ?? null,
            quietEnd: own?.quietEnd ?? null,
            overrides: overrides.get(id) ?? {},
            devices: (devices.get(id) ?? []).map((d) => ({
              id: d.id,
              token: d.token,
              platform: d.platform,
            })),
          },
        ];
      }),
    );
  }
}

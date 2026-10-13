import { Inject, Injectable } from '@nestjs/common';
import type {
  NotificationPreferences,
  UpdatePreferenceRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  CATEGORIES,
  CHANNELS,
  type Category,
  type Channel,
} from '../domain/catalog';
import { phoneNotVerified } from '../domain/errors';
import {
  defaultCell,
  mandatoryChannelsOf,
  maskPhone,
} from '../domain/preference-matrix';
import {
  PREFERENCE_REPOSITORY,
  SETTINGS_REPOSITORY,
  type PreferenceRepository,
  type SettingsRepository,
} from '../domain/ports';
import { RecipientViewService } from './recipient-view.service';

/**
 * The preference matrix and the writes to it. What routing reads is the cached `RecipientView`; every write here
 * invalidates it, so no process uses the previous value for later routing (FR-019). The matrix is the stored explicit
 * choices over the catalog defaults (FR-015), always returned whole (FR-016).
 */
@Injectable()
export class PreferencesService {
  constructor(
    @Inject(PREFERENCE_REPOSITORY)
    private readonly preferences: PreferenceRepository,
    @Inject(SETTINGS_REPOSITORY) private readonly settings: SettingsRepository,
    private readonly views: RecipientViewService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Settings (phone masked) and one row per category; a user nothing is stored for sees the defaults. */
  async matrix(userId: string): Promise<NotificationPreferences> {
    const view = await this.views.view(userId);
    const overrides = view?.overrides ?? {};
    return {
      settings: {
        timezone: view?.timezone ?? 'UTC',
        locale: view?.locale ?? 'en',
        quietStart: view?.quietStart ?? null,
        quietEnd: view?.quietEnd ?? null,
        phone: view?.phone ? maskPhone(view.phone) : null,
        phoneVerified: view?.phoneVerified ?? false,
      },
      preferences: CATEGORIES.map((category) => ({
        category,
        channels: Object.fromEntries(
          CHANNELS.map((channel) => [
            channel,
            overrides[`${category}:${channel}`] ??
              defaultCell(category, channel),
          ]),
        ) as NotificationPreferences['preferences'][number]['channels'],
        mandatoryChannels: mandatoryChannelsOf(category),
      })),
    };
  }

  /** `PUT /preferences`: SMS can only be switched on for a verified phone. Idempotent. */
  async update(
    userId: string,
    request: UpdatePreferenceRequest,
  ): Promise<NotificationPreferences> {
    if (request.channel === 'sms' && request.enabled) {
      const stored = await this.settings.find(userId);
      if (!stored?.phone || !stored.phoneVerifiedAt) throw phoneNotVerified();
    }
    await this.setCell(
      userId,
      request.category,
      request.channel,
      request.enabled,
    );
    return this.matrix(userId);
  }

  /** One cell, no verification rule: unsubscribes and complaints only ever switch cells off. */
  async setCell(
    userId: string,
    category: Category,
    channel: Channel,
    enabled: boolean,
  ): Promise<void> {
    await this.preferences.set(
      userId,
      category,
      channel,
      enabled,
      this.clock.now(),
    );
    await this.views.invalidate(userId);
  }
}

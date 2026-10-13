import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  NotificationPreferences,
  UpdateSettingsRequest,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  Domain_RateLimitedError,
  RateLimiterService,
} from '@app/infrastructure/rate-limit';
import {
  codeExpired,
  codeInvalid,
  codeNotRequested,
  phoneMissing,
  phoneUnreachable,
  quietHoursIncomplete,
  quietHoursInvalid,
  verificationLocked,
} from '../domain/errors';
import {
  OTP_STORE,
  SETTINGS_REPOSITORY,
  type OtpStore,
  type SettingsPatch,
  type SettingsRepository,
} from '../domain/ports';
import { PreferencesService } from './preferences.service';
import { NotificationRouterService } from './notification-router.service';
import { readNotificationsSettings } from './notifications-settings';
import { RecipientViewService } from './recipient-view.service';
import { SuppressionService } from './suppression.service';

/** A code is good for 10 minutes; 5 wrong ones lock the user out for 15 minutes (FR-018). */
const CODE_VALID_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const LOCK_SECONDS = 15 * 60;
/**
 * The stored code outlives its validity so that "expired" and "never requested" are told apart; validity is judged
 * against the injected clock, not the store's TTL.
 */
const STORED_FOR_SECONDS = 24 * 60 * 60;

/**
 * Time zone, locale, quiet hours and the phone with its ownership proof: a six digit code sent by SMS (FR-016,
 * FR-018, FR-023). Every write drops the cached recipient view and answers with the whole matrix.
 */
@Injectable()
export class SettingsService {
  private readonly secret: string;

  constructor(
    @Inject(SETTINGS_REPOSITORY) private readonly settings: SettingsRepository,
    @Inject(OTP_STORE) private readonly otp: OtpStore,
    private readonly preferences: PreferencesService,
    private readonly views: RecipientViewService,
    private readonly suppression: SuppressionService,
    private readonly router: NotificationRouterService,
    private readonly limiter: RateLimiterService,
    @Inject(CLOCK) private readonly clock: Clock,
    config: ApiConfigService,
  ) {
    this.secret = readNotificationsSettings(config).secret;
  }

  async update(
    userId: string,
    request: UpdateSettingsRequest,
  ): Promise<NotificationPreferences> {
    const stored = await this.settings.find(userId);
    this.assertQuietHours(stored, request);

    // A new number is answered with a code at once; check what a code needs before anything is written.
    const newPhone =
      request.phone && request.phone !== stored?.phone ? request.phone : null;
    if (newPhone) {
      await this.assertReachable(newPhone);
      await this.takeCodeRequest(userId);
    }

    const patch: SettingsPatch = { ...request };
    await this.settings.update(userId, patch, this.clock.now());
    if (request.phone !== undefined && request.phone !== stored?.phone)
      await this.otp.clear(userId); // a pending code was for the old number
    await this.views.invalidate(userId);
    if (newPhone) await this.sendCode(userId, newPhone);
    return this.preferences.matrix(userId);
  }

  /** `POST /settings/phone/code` (the 3 per hour limit is the route's policy). */
  async requestCode(userId: string): Promise<void> {
    const phone = (await this.settings.find(userId))?.phone;
    if (!phone) throw phoneMissing();
    await this.assertReachable(phone);
    await this.sendCode(userId, phone);
  }

  async verifyCode(
    userId: string,
    code: string,
  ): Promise<NotificationPreferences> {
    const lockedFor = await this.otp.lockedFor(userId);
    if (lockedFor > 0) throw verificationLocked(lockedFor);

    const [stored, settings] = await Promise.all([
      this.otp.get(userId),
      this.settings.find(userId),
    ]);
    const phone = settings?.phone;
    if (!stored || !phone) throw codeNotRequested();
    const [issuedAt, expected] = stored.split('.');
    if (this.clock.now().getTime() - Number(issuedAt) > CODE_VALID_MS) {
      await this.otp.clear(userId);
      throw codeExpired();
    }

    if (!this.same(expected, this.mac(userId, phone, code))) {
      const failures = await this.otp.failAttempt(userId, LOCK_SECONDS);
      if (failures >= MAX_ATTEMPTS) {
        await this.otp.lock(userId, LOCK_SECONDS);
        throw verificationLocked(LOCK_SECONDS);
      }
      throw codeInvalid(MAX_ATTEMPTS - failures);
    }

    // The code is used up whatever happens next; a phone changed in between has no pending code any more.
    await this.otp.clear(userId);
    if (
      !(await this.settings.markPhoneVerified(userId, phone, this.clock.now()))
    )
      throw codeNotRequested();
    await this.views.invalidate(userId);
    return this.preferences.matrix(userId);
  }

  // ---- internals --------------------------------------------------------------------------------------------------

  /** Both ends or neither, and not the same instant; judged on what would be stored after the update. */
  private assertQuietHours(
    stored: { quietStart: string | null; quietEnd: string | null } | null,
    request: UpdateSettingsRequest,
  ): void {
    if (request.quietStart === undefined && request.quietEnd === undefined)
      return;
    const start =
      request.quietStart === undefined
        ? (stored?.quietStart ?? null)
        : request.quietStart;
    const end =
      request.quietEnd === undefined
        ? (stored?.quietEnd ?? null)
        : request.quietEnd;
    if ((start === null) !== (end === null)) throw quietHoursIncomplete();
    if (start !== null && start === end) throw quietHoursInvalid();
  }

  private async assertReachable(phone: string): Promise<void> {
    if (await this.suppression.isSuppressed('sms', phone))
      throw phoneUnreachable();
  }

  /** Counts a code request that did not come through the route's own policy (a settings update with a new phone). */
  private async takeCodeRequest(userId: string): Promise<void> {
    const decision = await this.limiter.check(
      'notifications.phone-code.user',
      `user:${userId}`,
    );
    if (decision.allowed) return;
    const seconds = Math.max(
      Math.ceil((decision.retryAfterMs ?? 1_000) / 1_000),
      1,
    );
    throw new Domain_RateLimitedError(seconds, {
      'Retry-After': String(seconds),
    });
  }

  /**
   * Stores the code's MAC (never the code) and sends the code as the mandatory, immediate `security.phone_verification`
   * message on the SMS line: it ignores quiet hours, caps and the SMS opt-in, but not the suppression list.
   */
  private async sendCode(userId: string, phone: string): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const now = this.clock.now();
    await this.otp.put(
      userId,
      `${now.getTime()}.${this.mac(userId, phone, code)}`,
      STORED_FOR_SECONDS,
    );
    const view = await this.views.view(userId);
    if (!view) return;
    const plan = this.router.plan(
      {
        type: 'security.phone_verification',
        recipient: { kind: 'user', userId },
        data: { code },
        sourceId: `phone-verification:${randomUUID()}`,
        occurredAt: now.toISOString(),
      },
      // the number is not verified yet: that is what this message is for
      { ...view, phone, phoneVerified: true },
    );
    await this.router.execute(plan);
  }

  private mac(userId: string, phone: string, code: string): string {
    return createHmac('sha256', this.secret)
      .update(`${userId}|${phone}|${code}`)
      .digest('base64url');
  }

  private same(a: string | undefined, b: string): boolean {
    const left = Buffer.from(a ?? '');
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}

import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type {
  NotificationPreferences,
  PhoneVerifyRequest,
  UpdatePreferenceRequest,
  UpdateSettingsRequest,
} from '@marketplace-sandbox/contracts';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { PreferencesService } from '../application/preferences.service';
import { SettingsService } from '../application/settings.service';
import {
  phoneVerifyBody,
  updatePreferenceBody,
  updateSettingsBody,
} from './notifications.dto';

/** Preferences, settings and phone verification (contracts/http.md); every answer is the whole matrix. */
@ApiTags('notifications')
@Controller('notifications')
export class PreferencesController {
  constructor(
    private readonly preferences: PreferencesService,
    private readonly settings: SettingsService,
  ) {}

  @Firewall()
  @RateLimit('notifications.read.user')
  @Get('preferences')
  matrix(@User() user: UserRawDto): Promise<NotificationPreferences> {
    return this.preferences.matrix(user.id);
  }

  @Firewall()
  @RateLimit('notifications.write.user')
  @Put('preferences')
  update(
    @User() user: UserRawDto,
    @Body(updatePreferenceBody) body: UpdatePreferenceRequest,
  ): Promise<NotificationPreferences> {
    return this.preferences.update(user.id, body);
  }

  @Firewall()
  @RateLimit('notifications.write.user')
  @Put('settings')
  updateSettings(
    @User() user: UserRawDto,
    @Body(updateSettingsBody) body: UpdateSettingsRequest,
  ): Promise<NotificationPreferences> {
    return this.settings.update(user.id, body);
  }

  @Firewall()
  @RateLimit('notifications.phone-code.user')
  @Post('settings/phone/code')
  @HttpCode(202)
  async requestCode(@User() user: UserRawDto): Promise<Record<string, never>> {
    await this.settings.requestCode(user.id);
    return {};
  }

  @Firewall()
  @RateLimit('notifications.phone-verify.user')
  @Post('settings/phone/verify')
  @HttpCode(200)
  verify(
    @User() user: UserRawDto,
    @Body(phoneVerifyBody) body: PhoneVerifyRequest,
  ): Promise<NotificationPreferences> {
    return this.settings.verifyCode(user.id, body.code);
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ApiConfigService } from '@app/common/config';
import { CATEGORIES, CHANNELS } from '../domain/catalog';
import type { Category, Channel } from '../domain/catalog';
import { InboxService } from '../application/inbox.service';
import { NotificationPreferencesService } from '../application/preferences.service';
import { verifyUnsubscribe } from '../domain/unsubscribe-token';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class MarkReadDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() all?: boolean;
}

export class PreferenceDto {
  @ApiProperty({ enum: CATEGORIES }) @IsIn(CATEGORIES) category: Category;
  @ApiProperty({ enum: CHANNELS }) @IsIn(CHANNELS) channel: Channel;
  @ApiProperty() @IsBoolean() enabled: boolean;
}

export class SettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^[a-z]{2}(-[A-Z]{2})?$/)
  locale?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Matches(HHMM)
  quietStart?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Matches(HHMM)
  quietEnd?: string | null;
  /** E.164; verifying ownership (OTP) is a TODO noted in DOUBTS. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Matches(/^\+[1-9]\d{6,14}$/)
  phone?: string | null;
}

export class DeviceDto {
  @ApiProperty() @IsString() @MaxLength(4096) token: string;
  @ApiProperty({ enum: ['ios', 'android', 'web'] })
  @IsIn(['ios', 'android', 'web'])
  platform: 'ios' | 'android' | 'web';
}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly inbox: InboxService,
    private readonly preferences: NotificationPreferencesService,
    private readonly config: ApiConfigService,
  ) {}

  @Firewall()
  @Get()
  list(
    @User() user: UserRawDto,
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '20',
  ) {
    return this.inbox.list(
      user.id,
      cursor,
      Math.min(Math.max(Number(limit) || 20, 1), 50),
    );
  }

  @Firewall()
  @Get('unread-count')
  async unread(@User() user: UserRawDto) {
    return { unread: await this.inbox.unreadCount(user.id) };
  }

  @Firewall()
  @Post('read')
  @HttpCode(200)
  async markRead(@User() user: UserRawDto, @Body() body: MarkReadDto) {
    if (body.all) {
      await this.inbox.markAllRead(user.id);
      return { unread: 0 };
    }
    if (!body.ids?.length) throw new BadRequestException('ids or all');
    return { unread: await this.inbox.markRead(user.id, body.ids) };
  }

  @Firewall()
  @Get('preferences')
  matrix(@User() user: UserRawDto) {
    return this.preferences.matrix(user.id);
  }

  @Firewall()
  @Put('preferences')
  async setPreference(@User() user: UserRawDto, @Body() body: PreferenceDto) {
    await this.preferences.setPreference(
      user.id,
      body.category,
      body.channel,
      body.enabled,
    );
    return this.preferences.matrix(user.id);
  }

  @Firewall()
  @Put('settings')
  async settings(@User() user: UserRawDto, @Body() body: SettingsDto) {
    if (body.timezone && !isValidZone(body.timezone))
      throw new BadRequestException('Unknown time zone');
    await this.preferences.updateSettings(user.id, body);
    return this.preferences.matrix(user.id);
  }

  @Firewall()
  @Post('devices')
  @HttpCode(204)
  async registerDevice(@User() user: UserRawDto, @Body() body: DeviceDto) {
    await this.preferences.registerDevice(user.id, body.token, body.platform);
  }

  @Firewall()
  @Delete('devices/:token')
  @HttpCode(204)
  async removeDevice(@Param('token') token: string) {
    await this.preferences.removeDevices([token]);
  }

  /**
   * GET only DESCRIBES the unsubscribe (the FE renders a confirm button):
   * corporate mail scanners pre-fetch every link in an email, and a GET that
   * unsubscribed would silently opt people out. POST performs it - that's
   * also what RFC 8058 one-click clients send.
   */
  @Firewall({ anonymous: true })
  @Get('unsubscribe')
  describeUnsubscribe(@Query('token') token: string) {
    const parsed = verifyUnsubscribe(token ?? '', this.secret());
    if (!parsed) throw new BadRequestException('Invalid link');
    return { category: parsed.category };
  }

  @Firewall({ anonymous: true })
  @Post('unsubscribe')
  @HttpCode(200)
  async unsubscribe(@Query('token') token: string) {
    const parsed = verifyUnsubscribe(token ?? '', this.secret());
    if (!parsed) throw new BadRequestException('Invalid link');
    await this.preferences.setPreference(
      parsed.userId,
      parsed.category,
      'email',
      false,
    );
    return { unsubscribed: parsed.category };
  }

  private secret() {
    return (
      this.config.get('notification_secret') ?? this.config.get('jwt_secret')
    );
  }
}

function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

import { Body, Controller, Get, HttpCode, Param, Post, Put, Req } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, Matches } from 'class-validator';
import { Firewall, User, UserRawDto, Role } from '@app/domains/identity';
import { FlagsClient } from '../infra/flags.client';
import { FlagsAdminService } from '../application/flags-admin.service';
import { contextFromRequest } from '../domain/flags-context';
import type { Rule, Variant } from '../domain/evaluator';

export class FlagDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty() @IsBoolean() enabled: boolean;
  @ApiProperty() @IsArray() variants: Variant[];
  @ApiProperty() @IsString() defaultVariant: string;
  @ApiProperty() @IsString() offVariant: string;
  @ApiProperty() @IsArray() rules: Rule[];
  @ApiPropertyOptional() @IsOptional() @IsString() bucketBy: string;
  @ApiProperty() @IsString() owner: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() clientSide?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() expiresAt?: string | null;
}

@ApiTags('flags')
@Controller()
export class FlagsController {
  constructor(
    private readonly flags: FlagsClient,
    private readonly admin: FlagsAdminService,
  ) {}

  /** Pre-evaluated client-side flags for the caller (anonymous: `X-Anonymous-Id` keeps rollouts sticky). */
  @Firewall({ anonymous: true })
  @Get('flags')
  evaluate(@Req() req: Parameters<typeof contextFromRequest>[0]) {
    return { version: this.flags.version, flags: this.flags.evaluateClientFlags(contextFromRequest(req)) };
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/flags')
  list() {
    return this.admin.list();
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/flags/stale')
  stale() {
    return this.admin.stale();
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Put('admin/flags/:key')
  upsert(@Param('key') key: string, @Body() body: FlagDto, @User() user: UserRawDto) {
    return this.admin.upsert(key, body, user.id);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Post('admin/flags/:key/kill')
  @HttpCode(204)
  kill(@Param('key') key: string, @User() user: UserRawDto) {
    return this.admin.kill(key, user.id);
  }

  @Firewall({ roles: [Role.ADMIN] })
  @Get('admin/flags/:key/history')
  history(@Param('key') key: string) {
    return this.admin.history(key);
  }
}

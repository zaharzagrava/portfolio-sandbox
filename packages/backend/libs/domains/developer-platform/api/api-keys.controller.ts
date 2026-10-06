import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { ShopScoped } from '@app/domains/tenancy';
import { User, UserRawDto } from '@app/domains/identity';
import { ClickHouseService } from '@app/infrastructure/clickhouse/clickhouse.service';
import { CacheService } from '@app/infrastructure/cache/cache.service';
import { API_SCOPES } from '../domain/api-key-format';
import type { ApiScope } from '../domain/api-key-format';
import { ApiKeysService } from '../application/api-keys.service';
import { API_VERSIONS } from '../domain/versioning';

export class CreateApiKeyDto {
  @ApiProperty() @IsString() @Length(1, 60) name: string;
  @ApiProperty({ enum: API_SCOPES, isArray: true }) @IsArray() @ArrayMinSize(1) @IsIn(API_SCOPES, { each: true }) scopes: ApiScope[];
  @ApiProperty({ description: 'false = sk_test_ key acting on the sandbox' }) @IsBoolean() livemode: boolean;
}

export class PinVersionDto {
  @ApiProperty({ enum: API_VERSIONS }) @IsIn(API_VERSIONS) version: string;
}

/** Dashboard side (core): owners manage keys, pin the API version, search request logs. */
@ApiTags('developers')
@Controller('shops/:shopId/developers')
export class ApiKeysController {
  constructor(
    private readonly keys: ApiKeysService,
    private readonly clickhouse: ClickHouseService,
    private readonly cache: CacheService,
    @InjectConnection() private readonly sequelize: Sequelize,
  ) {}

  @ShopScoped('shop.manage')
  @Post('keys')
  create(@Param('shopId', ParseUUIDPipe) shopId: string, @User() user: UserRawDto, @Body() body: CreateApiKeyDto) {
    return this.keys.create(shopId, user.id, body.name, body.scopes, body.livemode);
  }

  @ShopScoped('shop.manage')
  @Get('keys')
  list(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.keys.list(shopId);
  }

  @ShopScoped('shop.manage')
  @Post('keys/:keyId/rotate')
  rotate(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('keyId', ParseUUIDPipe) keyId: string, @User() user: UserRawDto) {
    return this.keys.rotate(shopId, keyId, user.id);
  }

  @ShopScoped('shop.manage')
  @Delete('keys/:keyId')
  @HttpCode(204)
  revoke(@Param('shopId', ParseUUIDPipe) shopId: string, @Param('keyId', ParseUUIDPipe) keyId: string) {
    return this.keys.revoke(shopId, keyId);
  }

  @ShopScoped('shop.manage')
  @Put('api-version')
  async pin(@Param('shopId', ParseUUIDPipe) shopId: string, @Body() body: PinVersionDto) {
    await this.sequelize.query(
      `INSERT INTO "ShopApiSettings" ("shopId", "pinnedVersion") VALUES (:shopId, :version) ON CONFLICT ("shopId") DO UPDATE SET "pinnedVersion" = EXCLUDED."pinnedVersion", "updatedAt" = now()`,
      { replacements: { shopId, version: body.version } },
    );
    await this.cache.invalidate([`api:pinned:${shopId}`]);
    return { version: body.version };
  }

  /** Request logs (last 30 days) - by request id, or the latest 100. */
  @ShopScoped('shop.read')
  @Get('logs')
  logs(@Param('shopId', ParseUUIDPipe) shopId: string, @Query('requestId') requestId?: string, @Query('status') status?: string) {
    return this.clickhouse.query(
      `SELECT request_id, key_id, livemode, version, method, route, status, duration_ms, deprecated, ts FROM api_requests
       WHERE shop_id = {shopId:String} ${requestId ? 'AND request_id = {requestId:String}' : ''} ${status ? 'AND status >= {status:UInt16}' : ''}
       ORDER BY ts DESC LIMIT 100`,
      { shopId, requestId, status: status ? Number(status) : undefined },
    );
  }

  /** Who still calls deprecated routes / old versions (drives sunset decisions). */
  @ShopScoped('shop.read')
  @Get('usage')
  usage(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.clickhouse.query(
      `SELECT version, route, sum(calls) AS calls, sum(errors) AS errors FROM api_usage_daily
       WHERE shop_id = {shopId:String} AND day >= today() - 30 GROUP BY version, route ORDER BY calls DESC`,
      { shopId },
    );
  }
}

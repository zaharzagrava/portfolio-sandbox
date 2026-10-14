import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { API_KEY_LIMITS } from '@marketplace-sandbox/contracts';
import { ShopScoped } from '@app/domains/tenancy';
import { Firewall, User, type AuthenticatedUser } from '@app/domains/identity';
import { API_SCOPES } from '../domain/api-key-format';
import type { ApiScope } from '../domain/api-key-format';
import { ApiKeysService } from '../application/api-keys.service';

export class CreateApiKeyDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(API_KEY_LIMITS.name.min, API_KEY_LIMITS.name.max)
  name: string;

  @ApiProperty({ enum: API_SCOPES, isArray: true })
  @IsArray()
  @ArrayMinSize(API_KEY_LIMITS.scopes.min)
  @ArrayMaxSize(API_KEY_LIMITS.scopes.max)
  @ArrayUnique()
  @IsIn(API_SCOPES, { each: true })
  scopes: ApiScope[];

  @ApiProperty({ description: 'false = sk_test_ key acting on the sandbox' })
  @IsBoolean()
  livemode: boolean;

  @ApiPropertyOptional({ description: 'Future instant, at most 365 days away' })
  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string;
}

export class RotateApiKeyDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 168, default: 24 })
  @IsOptional()
  @IsInt()
  @Min(API_KEY_LIMITS.overlapHours.min)
  @Max(API_KEY_LIMITS.overlapHours.max)
  overlapHours?: number;
}

export class ListApiKeysQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 512)
  cursor?: string;
}

/**
 * Dashboard keys (apps/core, FR-001…FR-012): one application service, no persistence here. Create, rotate and revoke are
 * sensitive routes (a logged-out session is refused at once); a live key additionally needs a second factor.
 */
@ApiTags('developers')
@Controller('shops/:shopId/developers/keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Firewall({ sensitive: true })
  @ShopScoped('shop.manage')
  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body() body: CreateApiKeyDto,
  ) {
    return this.keys.create(
      shopId,
      { userId: user.id, amr: user.amr },
      {
        name: body.name,
        scopes: body.scopes,
        livemode: body.livemode,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
      },
    );
  }

  @Firewall({ sensitive: true })
  @ShopScoped('shop.manage')
  @Get()
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query() query: ListApiKeysQuery,
  ) {
    return this.keys.list(shopId, query);
  }

  @Firewall({ sensitive: true })
  @ShopScoped('shop.manage')
  @Post(':keyId/rotate')
  @Header('Cache-Control', 'no-store')
  rotate(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('keyId', ParseUUIDPipe) keyId: string,
    @User() user: AuthenticatedUser,
    @Body() body: RotateApiKeyDto,
  ) {
    return this.keys.rotate(
      shopId,
      keyId,
      { userId: user.id, amr: user.amr },
      body.overlapHours,
    );
  }

  @Firewall({ sensitive: true })
  @ShopScoped('shop.manage')
  @Delete(':keyId')
  @HttpCode(204)
  async revoke(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('keyId', ParseUUIDPipe) keyId: string,
    @User() user: AuthenticatedUser,
  ): Promise<void> {
    await this.keys.revoke(shopId, keyId, { userId: user.id, amr: user.amr });
  }
}

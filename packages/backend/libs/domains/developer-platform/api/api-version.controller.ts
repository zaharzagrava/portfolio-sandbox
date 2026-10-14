import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { ShopScoped } from '@app/domains/tenancy';
import { Firewall, User, type AuthenticatedUser } from '@app/domains/identity';
import { ApiVersionService } from '../application/api-version.service';

export class PinVersionDto {
  @ApiProperty({ example: '2026-10-01' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  version: string;
}

/** The shop's pinned API version (apps/core, FR-028): reading and changing it. Changing is a sensitive route. */
@ApiTags('developers')
@Controller('shops/:shopId/developers/api-version')
export class ApiVersionController {
  constructor(private readonly versions: ApiVersionService) {}

  @ShopScoped('shop.manage')
  @Get()
  state(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.versions.state(shopId);
  }

  @Firewall({ sensitive: true })
  @ShopScoped('shop.manage')
  @Put()
  pin(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body() body: PinVersionDto,
  ) {
    return this.versions.pin(shopId, body.version, user.id);
  }
}

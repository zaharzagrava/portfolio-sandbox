import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { shareLinkCreateRequestSchema } from '@marketplace-sandbox/contracts';
import { SensitivePathParams } from '@app/common/exceptions-filter';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { ShareService } from '../application/share.service';
import { assetNotFound, shareLinkNotFound } from '../domain/errors';
import { UuidParamPipe, ZodPipe } from './zod.pipes';

type PlatformRequest = Request & { clientIp?: string };
/** The client address as the platform resolved it (trusted proxies applied), for the per-address limit (FR-046). */
export const addressOf = (req: PlatformRequest): string =>
  req.clientIp ?? req.ip ?? 'unknown';

const assetId = () => Param('assetId', new UuidParamPipe(assetNotFound));

/** Owner side of share links: needs `products.write` of the shop in the path. */
@ApiTags('assets')
@Controller()
export class ShareController {
  constructor(private readonly shares: ShareService) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/assets/:assetId/share')
  create(
    @Param('shopId') shopId: string,
    @assetId() id: string,
    @User() user: UserRawDto,
    @Body(new ZodPipe(shareLinkCreateRequestSchema))
    body: ReturnType<typeof shareLinkCreateRequestSchema.parse>,
  ) {
    return this.shares.create(shopId, user.id, id, body);
  }

  @ShopScoped('products.write')
  @Get('shops/:shopId/assets/:assetId/share-links')
  list(@Param('shopId') shopId: string, @assetId() id: string) {
    return this.shares.list(shopId, id);
  }

  @ShopScoped('products.write')
  @HttpCode(204)
  @Delete('shops/:shopId/assets/:assetId/share-links/:linkId')
  async revoke(
    @Param('shopId') shopId: string,
    @assetId() id: string,
    @Param('linkId', new UuidParamPipe(shareLinkNotFound)) linkId: string,
  ) {
    await this.shares.revoke(shopId, id, linkId);
  }
}

/** The anonymous side: the token in the path is the credential. Rate limited per address, never counted by a preview. */
@ApiTags('assets')
@Controller()
export class SharedLinkController {
  constructor(private readonly shares: ShareService) {}

  @Firewall({ anonymous: true })
  @SensitivePathParams('token')
  @Get('assets/shared/:token')
  preview(@Param('token') token: string, @Req() req: PlatformRequest) {
    return this.shares.preview(token, addressOf(req));
  }

  @Firewall({ anonymous: true })
  @SensitivePathParams('token')
  @HttpCode(200)
  @Post('assets/shared/:token/redeem')
  redeem(@Param('token') token: string, @Req() req: PlatformRequest) {
    return this.shares.redeem(token, addressOf(req));
  }
}

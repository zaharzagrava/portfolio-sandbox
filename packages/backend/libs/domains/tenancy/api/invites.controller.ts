import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Firewall, User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ShopScoped } from './shop.guard';
import type { ShopRequest } from './shop.guard';
import { InviteService } from '../application/invite.service';
import {
  AcceptInviteDto,
  InviteListQueryDto,
  InviteMemberDto,
} from './tenancy.dto';
import type { ShopRole } from '../domain/shop-types';

@ApiTags('shops')
@Controller()
export class InvitesController {
  constructor(private readonly invites: InviteService) {}

  @ShopScoped('members.manage')
  @RateLimit('tenancy.invite.shop', 'tenancy.shop-write.shop')
  @Post('shops/:shopId/invites')
  @HttpCode(201)
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Req() req: ShopRequest,
    @Body() body: InviteMemberDto,
  ) {
    return this.invites.create(
      shopId,
      { id: user.id, role: req.shopRole as ShopRole },
      body,
    );
  }

  @ShopScoped('members.manage')
  @Get('shops/:shopId/invites')
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Query() query: InviteListQueryDto,
  ) {
    return this.invites.list(shopId, user.id, query);
  }

  @ShopScoped('members.manage')
  @RateLimit('tenancy.shop-write.shop')
  @Post('shops/:shopId/invites/:inviteId/resend')
  @HttpCode(200)
  resend(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @User() user: AuthenticatedUser,
    @Req() req: ShopRequest,
  ) {
    return this.invites.resend(
      shopId,
      { id: user.id, role: req.shopRole as ShopRole },
      inviteId,
    );
  }

  @ShopScoped('members.manage')
  @RateLimit('tenancy.shop-write.shop')
  @Delete('shops/:shopId/invites/:inviteId')
  @HttpCode(204)
  async revoke(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('inviteId', ParseUUIDPipe) inviteId: string,
    @User() user: AuthenticatedUser,
    @Req() req: ShopRequest,
  ): Promise<void> {
    await this.invites.revoke(
      shopId,
      { id: user.id, role: req.shopRole as ShopRole },
      inviteId,
    );
  }

  /** The invitee is signed in but has no shop context yet; failures count against the user's budget (404 only). */
  @Firewall()
  @RateLimit('tenancy.invite-accept.ip', 'tenancy.invite-accept.user')
  @Post('shop-invites/accept')
  async accept(
    @User() user: AuthenticatedUser,
    @Body() body: AcceptInviteDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.invites.accept(user.id, body.token);
    res.status('alreadyMember' in result ? 200 : 201);
    return result;
  }
}

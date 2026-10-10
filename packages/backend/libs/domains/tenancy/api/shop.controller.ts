import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  Firewall,
  User,
  UserDirectoryService,
  UserRawDto,
} from '@app/domains/identity';
import { ShopScoped } from './shop.guard';
import type { ShopRequest } from './shop.guard';
import { ShopService } from '../application/shop.service';
import { ShopSsoService } from '../application/shop-sso.service';
import {
  AcceptInviteDto,
  ChangeRoleDto,
  CreateShopDto,
  InviteMemberDto,
  ShopSsoConfigDto,
} from './tenancy.dto';

@ApiTags('shops')
@Controller()
export class ShopController {
  constructor(
    private readonly shops: ShopService,
    private readonly sso: ShopSsoService,
    private readonly directory: UserDirectoryService,
  ) {}

  @Firewall()
  @Post('shops')
  create(@User() user: UserRawDto, @Body() body: CreateShopDto) {
    return this.shops.create(user.id, body.name, body.slug);
  }

  @Firewall()
  @Get('shops/mine')
  mine(@User() user: UserRawDto) {
    return this.shops.mine(user.id);
  }

  @ShopScoped('shop.read')
  @Get('shops/:shopId')
  get(@Param('shopId', ParseUUIDPipe) shopId: string, @Req() req: ShopRequest) {
    return this.shops
      .get(shopId)
      .then((shop) => ({ ...shop, myRole: req.shopRole }));
  }

  @ShopScoped('members.read')
  @Get('shops/:shopId/members')
  members(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.shops.members(shopId);
  }

  @ShopScoped('members.manage')
  @Post('shops/:shopId/invites')
  invite(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: UserRawDto,
    @Body() body: InviteMemberDto,
  ) {
    return this.shops.invite(shopId, user.id, body.email, body.role);
  }

  @ShopScoped('members.manage')
  @Get('shops/:shopId/invites')
  invites(@Param('shopId', ParseUUIDPipe) shopId: string) {
    return this.shops.listInvites(shopId);
  }

  @Firewall()
  @Post('shop-invites/accept')
  async accept(@User() user: UserRawDto, @Body() body: AcceptInviteDto) {
    // The principal carries claims only (no e-mail): the invitee's address comes from the user directory.
    const profile = (await this.directory.getUsersByIds([user.id])).get(
      user.id,
    );
    return this.shops.acceptInvite(user.id, profile?.email ?? '', body.token);
  }

  @ShopScoped('members.manage')
  @Patch('shops/:shopId/members/:userId')
  @HttpCode(204)
  changeRole(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: ChangeRoleDto,
  ) {
    return this.shops.changeRole(shopId, userId, body.role);
  }

  @ShopScoped('members.manage')
  @Delete('shops/:shopId/members/:userId')
  @HttpCode(204)
  remove(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.shops.removeMember(shopId, userId);
  }

  @ShopScoped('sso.manage')
  @Put('shops/:shopId/sso')
  configureSso(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: ShopSsoConfigDto,
  ) {
    return this.sso.configure(
      shopId,
      body.issuer,
      body.clientId,
      body.clientSecret,
    );
  }
}

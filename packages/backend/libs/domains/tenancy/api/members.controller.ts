import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User } from '@app/domains/identity';
import type { AuthenticatedUser } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { ShopScoped } from './shop.guard';
import type { ShopRequest } from './shop.guard';
import { MembershipAdminService } from '../application/membership-admin.service';
import { MembershipQueryService } from '../application/membership-query.service';
import { ChangeRoleDto, PageQueryDto } from './tenancy.dto';
import type { ShopRole } from '../domain/shop-types';

@ApiTags('shops')
@Controller()
export class MembersController {
  constructor(
    private readonly admin: MembershipAdminService,
    private readonly query: MembershipQueryService,
  ) {}

  @ShopScoped('members.read')
  @Get('shops/:shopId/members')
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Query() query: PageQueryDto,
  ) {
    return this.query.list(shopId, user.id, query);
  }

  @ShopScoped('members.manage')
  @RateLimit('tenancy.shop-write.shop')
  @Patch('shops/:shopId/members/:userId')
  @HttpCode(204)
  async changeRole(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @User() user: AuthenticatedUser,
    @Req() req: ShopRequest,
    @Body() body: ChangeRoleDto,
  ): Promise<void> {
    await this.admin.changeRole(
      shopId,
      { id: user.id, role: req.shopRole as ShopRole },
      userId,
      body.role,
    );
  }

  /**
   * Every member may remove themselves, so the route needs only membership; removing someone else asks for
   * `members.manage` inside the service (read strongly, status gate included).
   */
  @ShopScoped('shop.read')
  @RateLimit('tenancy.shop-write.shop')
  @Delete('shops/:shopId/members/:userId')
  @HttpCode(204)
  async remove(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @User() user: AuthenticatedUser,
    @Req() req: ShopRequest,
  ): Promise<void> {
    await this.admin.remove(
      shopId,
      { id: user.id, role: req.shopRole as ShopRole },
      userId,
    );
  }
}

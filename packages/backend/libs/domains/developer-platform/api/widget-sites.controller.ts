import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createWidgetSiteRequestSchema,
  rotateWidgetSecretRequestSchema,
  updateWidgetSiteRequestSchema,
  widgetKillSwitchRequestSchema,
  type CreateWidgetSiteRequest,
  type RotateWidgetSecretRequest,
  type UpdateWidgetSiteRequest,
} from '@marketplace-sandbox/contracts';
import { User, type AuthenticatedUser } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { RateLimit } from '@app/infrastructure/rate-limit';
import { WidgetSitesService } from '../application/widget-sites.service';
import { ApiError } from '../domain/errors';
import { ZodBodyPipe } from './zod-body.pipe';

const intQuery = (
  value: string | undefined,
  field: string,
): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^\d{1,6}$/.test(value))
    throw new ApiError('validation_failed', 'The request is not valid.', {
      errors: [{ field, code: 'invalid' }],
    });
  return Number(value);
};

/**
 * Dashboard routes of the widget sites (FR-001…FR-010, FR-027): `widget.manage` on every route including reads (they
 * show origins and mint no secret, but the permission is one decision), mutations limited per shop. The CSRF check of
 * cookie sessions is the platform's guard (S01); bearer calls need none. No persistence here.
 */
@ApiTags('widget')
@Controller('shops/:shopId/widget/sites')
export class WidgetSitesController {
  constructor(private readonly sites: WidgetSitesService) {}

  @ShopScoped('widget.manage')
  @RateLimit('widget.manage.shop')
  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @User() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(createWidgetSiteRequestSchema))
    body: CreateWidgetSiteRequest,
  ) {
    return this.sites.create(shopId, user.id, body);
  }

  @ShopScoped('widget.manage')
  @Get()
  list(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.sites.list(shopId, {
      limit: intQuery(limit, 'limit'),
      cursor,
    });
  }

  @ShopScoped('widget.manage')
  @Get(':siteId')
  get(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
  ) {
    return this.sites.get(shopId, siteId);
  }

  @ShopScoped('widget.manage')
  @RateLimit('widget.manage.shop')
  @Patch(':siteId')
  update(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @User() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(updateWidgetSiteRequestSchema))
    body: UpdateWidgetSiteRequest,
  ) {
    return this.sites.update(shopId, siteId, user.id, body);
  }

  @ShopScoped('widget.manage')
  @RateLimit('widget.manage.shop')
  @Post(':siteId/rotate-secret')
  @Header('Cache-Control', 'no-store')
  rotate(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @User() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(rotateWidgetSecretRequestSchema))
    body: RotateWidgetSecretRequest,
  ) {
    return this.sites.rotateSecret(shopId, siteId, user.id, body.overlapHours);
  }

  @ShopScoped('widget.manage')
  @RateLimit('widget.manage.shop')
  @Post(':siteId/expire-previous-secret')
  @HttpCode(200)
  expirePrevious(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @User() user: AuthenticatedUser,
  ) {
    return this.sites.expirePreviousSecret(shopId, siteId, user.id);
  }

  @ShopScoped('widget.manage')
  @RateLimit('widget.manage.shop')
  @Put(':siteId/kill-switch')
  killSwitch(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @User() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(widgetKillSwitchRequestSchema)) body: { on: boolean },
  ) {
    return this.sites.setKillSwitch(shopId, siteId, user.id, body.on);
  }

  @ShopScoped('widget.manage')
  @RateLimit('widget.manage.shop')
  @Delete(':siteId')
  @HttpCode(204)
  async remove(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @User() user: AuthenticatedUser,
  ): Promise<void> {
    await this.sites.remove(shopId, siteId, user.id);
  }

  @ShopScoped('widget.manage')
  @Get(':siteId/history')
  history(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('siteId', ParseUUIDPipe) siteId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.sites.history(shopId, siteId, {
      limit: intQuery(limit, 'limit'),
      cursor,
    });
  }
}

import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { User, UserRawDto } from '@app/domains/identity';
import { ShopScoped } from '@app/domains/tenancy';
import { LiveModerationService } from '../application/live-moderation.service';
import { LivePinService } from '../application/live-pin.service';
import { LiveRemovalService } from '../application/live-removal.service';
import { LiveStreamService } from '../application/live-stream.service';
import { UuidParamPipe } from './pipes';

const shopParam = () => Param('shopId', new UuidParamPipe('shopId'));
const streamParam = () => Param('streamId', new UuidParamPipe('streamId'));

/**
 * The staff routes of a live stream, all under the shop so tenancy's guard decides access (FR-003): a non-member gets
 * `404`, a member without `products.write` `403`, a closed shop its own answer. A stream of another shop is `404`
 * (decided in the services). The handlers make one call each.
 */
@ApiTags('live')
@Controller()
export class LiveStaffController {
  constructor(
    private readonly streams: LiveStreamService,
    private readonly pins: LivePinService,
    private readonly moderation: LiveModerationService,
    private readonly removals: LiveRemovalService,
  ) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/live')
  create(@shopParam() shopId: string, @Body() body: unknown) {
    return this.streams.create(shopId, body);
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/live/:streamId/start')
  @HttpCode(200)
  start(@shopParam() shopId: string, @streamParam() streamId: string) {
    return this.streams.start(shopId, streamId);
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/live/:streamId/end')
  @HttpCode(200)
  end(@shopParam() shopId: string, @streamParam() streamId: string) {
    return this.streams.end(shopId, streamId);
  }

  @ShopScoped('products.write')
  @Put('shops/:shopId/live/:streamId/pin')
  pin(
    @shopParam() shopId: string,
    @streamParam() streamId: string,
    @Body() body: unknown,
  ) {
    return this.pins.pin(shopId, streamId, body);
  }

  @ShopScoped('products.write')
  @Delete('shops/:shopId/live/:streamId/pin')
  @HttpCode(204)
  unpin(@shopParam() shopId: string, @streamParam() streamId: string) {
    return this.pins.unpin(shopId, streamId);
  }

  @ShopScoped('products.write')
  @Delete('shops/:shopId/live/:streamId/comments/:commentId')
  @HttpCode(204)
  remove(
    @shopParam() shopId: string,
    @streamParam() streamId: string,
    @Param('commentId', new UuidParamPipe('commentId')) commentId: string,
    @User() user: UserRawDto,
  ) {
    return this.removals.removeByStaff(shopId, streamId, commentId, user.id);
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/live/:streamId/mutes/:userId')
  @HttpCode(204)
  mute(
    @shopParam() shopId: string,
    @streamParam() streamId: string,
    @Param('userId', new UuidParamPipe('userId')) userId: string,
    @User() user: UserRawDto,
  ) {
    return this.moderation.mute(shopId, streamId, userId, user.id);
  }

  @ShopScoped('products.write')
  @Delete('shops/:shopId/live/:streamId/mutes/:userId')
  @HttpCode(204)
  unmute(
    @shopParam() shopId: string,
    @streamParam() streamId: string,
    @Param('userId', new UuidParamPipe('userId')) userId: string,
  ) {
    return this.moderation.unmute(shopId, streamId, userId);
  }
}

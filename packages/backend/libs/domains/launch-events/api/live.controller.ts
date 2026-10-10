import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/sequelize';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { RateLimit } from '@app/infrastructure/rate-limit';
import {
  ShopScoped,
  ShopMembershipModel as ShopMembership,
} from '@app/domains/tenancy';
import { LiveService } from '../application/live.service';
import type { Reaction } from '../infra/live-keys';

export class CreateStreamDto {
  @ApiProperty() @IsString() @Length(3, 120) title: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() launchEventId?: string;
}

export class CommentDto {
  @ApiProperty() @IsString() @Length(1, 200) text: string;
}

export class ReactDto {
  @ApiProperty({ example: { '❤️': 7, '🔥': 2 } })
  @IsObject()
  reactions: Partial<Record<Reaction, number>>;
}

export class PinDto {
  @ApiProperty() @IsUUID() productId: string;
  @ApiProperty() @IsString() @MaxLength(80) text: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) stockLeft?: number;
}

@ApiTags('live')
@Controller()
export class LiveController {
  constructor(
    private readonly live: LiveService,
    @InjectModel(ShopMembership)
    private readonly memberships: typeof ShopMembership,
  ) {}

  @ShopScoped('products.write')
  @Post('shops/:shopId/live')
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: CreateStreamDto,
  ) {
    return this.live.create(shopId, body.title, body.launchEventId);
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/live/:streamId/start')
  start(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('streamId', ParseUUIDPipe) streamId: string,
  ) {
    return this.live.setStatus(shopId, streamId, 'LIVE');
  }

  @ShopScoped('products.write')
  @Post('shops/:shopId/live/:streamId/end')
  end(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('streamId', ParseUUIDPipe) streamId: string,
  ) {
    return this.live.setStatus(shopId, streamId, 'ENDED');
  }

  @Firewall()
  @RateLimit('live.comment')
  @Post('live/:streamId/comments')
  async comment(
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @User() user: UserRawDto,
    @Body() body: CommentDto,
  ) {
    const stream = await this.live.get(streamId);
    if (!stream) throw new NotFoundException();
    const isStaff = !!(await this.memberships.findOne({
      where: { shopId: stream.shopId, userId: user.id },
      attributes: ['role'],
    }));
    return this.live.comment(
      streamId,
      { id: user.id, name: user.email.split('@')[0], isStaff },
      body.text,
    );
  }

  @Firewall()
  @RateLimit('live.reaction')
  @Post('live/:streamId/reactions')
  @HttpCode(202)
  async react(
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Body() body: ReactDto,
  ) {
    await this.live.react(streamId, body.reactions);
  }

  @Firewall({ anonymous: true })
  @Get('live/:streamId')
  async snapshot(@Param('streamId', ParseUUIDPipe) streamId: string) {
    const stream = await this.live.get(streamId);
    if (!stream) throw new NotFoundException();
    return {
      ...stream,
      pin: await this.live.currentPin(streamId),
      recent: await this.live.recent(streamId),
    };
  }

  @Firewall()
  @Put('live/:streamId/pin')
  async pin(
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @User() user: UserRawDto,
    @Body() body: PinDto,
  ) {
    await this.assertStaff(streamId, user.id);
    await this.live.pin(streamId, body);
  }

  @Firewall()
  @Delete('live/:streamId/pin')
  @HttpCode(204)
  async unpin(
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @User() user: UserRawDto,
  ) {
    await this.assertStaff(streamId, user.id);
    await this.live.pin(streamId, null);
  }

  @Firewall()
  @Delete('live/:streamId/comments/:commentId')
  @HttpCode(204)
  async remove(
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Param('commentId') commentId: string,
    @User() user: UserRawDto,
  ) {
    await this.assertStaff(streamId, user.id);
    await this.live.remove(streamId, commentId, `moderator:${user.id}`);
  }

  @Firewall()
  @Post('live/:streamId/mutes/:userId')
  @HttpCode(204)
  async mute(
    @Param('streamId', ParseUUIDPipe) streamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @User() user: UserRawDto,
  ) {
    await this.assertStaff(streamId, user.id);
    await this.live.mute(streamId, userId);
  }

  private async assertStaff(streamId: string, userId: string) {
    const stream = await this.live.get(streamId);
    if (!stream) throw new NotFoundException();
    const member = await this.memberships.findOne({
      where: { shopId: stream.shopId, userId },
    });
    if (!member || member.role === 'VIEWER') throw new ForbiddenException();
  }
}

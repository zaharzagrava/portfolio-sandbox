import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ChatSyncService } from '../application/chat-sync.service';

export class SendMessageDto {
  @ApiProperty() @IsUUID() clientMessageId: string;
  @ApiProperty() @IsString() @Length(1, 4000) body: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() replyToId?: string;
}

export class SyncDto {
  @ApiProperty({ example: { '0190…channel': 42 } }) @IsObject() cursors: Record<string, number>;
}

export class ReadDto {
  @ApiProperty() @IsInt() @Min(0) seq: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags('chat')
@Controller('chat')
export class ChatSyncController {
  constructor(private readonly chat: ChatSyncService) {}

  @Firewall()
  @Post('channels/:channelId/messages')
  send(@Param('channelId', ParseUUIDPipe) channelId: string, @User() user: UserRawDto, @Body() body: SendMessageDto) {
    return this.chat.send(channelId, user.id, body.body, body.clientMessageId, body.replyToId);
  }

  /** POST because the cursor map can be large; it is a read. */
  @Firewall()
  @Post('sync')
  @HttpCode(200)
  sync(@User() user: UserRawDto, @Body() body: SyncDto) {
    const cursors = Object.fromEntries(Object.entries(body.cursors ?? {}).filter(([id, seq]) => UUID.test(id) && Number.isFinite(Number(seq))).map(([id, seq]) => [id, Number(seq)]));
    return this.chat.sync(user.id, cursors);
  }

  @Firewall()
  @Get('unread')
  unread(@User() user: UserRawDto) {
    return this.chat.unread(user.id);
  }

  @Firewall()
  @Post('channels/:channelId/read')
  @HttpCode(200)
  read(@Param('channelId', ParseUUIDPipe) channelId: string, @User() user: UserRawDto, @Body() body: ReadDto) {
    return this.chat.markRead(channelId, user.id, body.seq);
  }

  @Firewall()
  @Post('presence/heartbeat')
  @HttpCode(204)
  async heartbeat(@User() user: UserRawDto) {
    await this.chat.heartbeat(user.id);
  }

  @Firewall()
  @Get('presence')
  presence(@Query('userIds') userIds = '') {
    const ids = userIds.split(',').filter((id) => UUID.test(id));
    if (ids.length > 100) throw new BadRequestException('max 100 users');
    return this.chat.presence(ids);
  }
}

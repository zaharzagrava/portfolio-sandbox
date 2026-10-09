import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Firewall, User, UserRawDto } from '@app/domains/identity';
import { ChatService } from '../application/chat.service';
import {
  ChatMemberActionDto,
  CreateChatChannelDto,
  ListChatMessagesQueryDto,
  MuteChatMemberDto,
  UpdateChatChannelDto,
} from './chat.dto';

@ApiTags('chat')
@Controller('chat')
export class ChatController {
  private readonly l = new Logger(ChatController.name);

  constructor(private readonly chatService: ChatService) {}

  /**
   * Management/CRUD lives here in NestJS - low volume, no distinguishing
   * latency profile. The realtime send/receive path is handled entirely by
   * the Rust chat-gateway (see packages/hft-platform); this endpoint just
   * hands the client a short-lived ticket to authenticate against it.
   */
  @Firewall()
  @Post('ws-ticket')
  async mintWsTicket(@User() user: UserRawDto) {
    return this.chatService.mintWsTicket(user.id);
  }

  @Firewall()
  @Post('channels')
  async createChannel(
    @User() user: UserRawDto,
    @Body() body: CreateChatChannelDto,
  ) {
    return this.chatService.createChannel(user.id, body);
  }

  @Firewall()
  @Post('channels/:channelId/join')
  @HttpCode(200)
  async joinChannel(
    @User() user: UserRawDto,
    @Param('channelId', ParseUUIDPipe) channelId: string,
  ) {
    return this.chatService.joinChannel(channelId, user.id);
  }

  @Firewall()
  @Get('channels/by-product/:productId')
  async getChannelForProduct(
    @User() user: UserRawDto,
    @Param('productId') productId: string,
  ) {
    return this.chatService.getChannelForProduct(productId, user.id);
  }

  @Firewall()
  @Get('channels/:channelId')
  async getChannel(
    @User() user: UserRawDto,
    @Param('channelId') channelId: string,
  ) {
    return this.chatService.getChannel(channelId, user.id);
  }

  @Firewall()
  @Patch('channels/:channelId')
  async updateChannel(
    @User() user: UserRawDto,
    @Param('channelId') channelId: string,
    @Body() body: UpdateChatChannelDto,
  ) {
    return this.chatService.updateChannel(channelId, user.id, body);
  }

  @Firewall()
  @Get('channels/:channelId/messages')
  async listMessages(
    @User() user: UserRawDto,
    @Param('channelId') channelId: string,
    @Query() query: ListChatMessagesQueryDto,
  ) {
    return this.chatService.listMessages(channelId, user.id, query);
  }

  @Firewall()
  @Delete('channels/:channelId/messages/:messageId')
  async deleteMessage(
    @User() user: UserRawDto,
    @Param('channelId') channelId: string,
    @Param('messageId') messageId: string,
  ) {
    await this.chatService.deleteMessage(channelId, user.id, messageId);
    return { success: true };
  }

  @Firewall()
  @Post('channels/:channelId/members/ban')
  async banMember(
    @User() user: UserRawDto,
    @Param('channelId') channelId: string,
    @Body() body: ChatMemberActionDto,
  ) {
    await this.chatService.banMember(channelId, user.id, body.userId);
    return { success: true };
  }

  @Firewall()
  @Post('channels/:channelId/members/unban')
  async unbanMember(
    @User() user: UserRawDto,
    @Param('channelId') channelId: string,
    @Body() body: ChatMemberActionDto,
  ) {
    await this.chatService.unbanMember(channelId, user.id, body.userId);
    return { success: true };
  }

  @Firewall()
  @Post('channels/:channelId/members/mute')
  async muteMember(
    @User() user: UserRawDto,
    @Param('channelId') channelId: string,
    @Body() body: MuteChatMemberDto,
  ) {
    await this.chatService.muteMember(channelId, user.id, body);
    return { success: true };
  }

  @Firewall()
  @Post('channels/:channelId/members/promote')
  async promoteMember(
    @User() user: UserRawDto,
    @Param('channelId') channelId: string,
    @Body() body: ChatMemberActionDto,
  ) {
    await this.chatService.promoteMember(channelId, user.id, body.userId);
    return { success: true };
  }
}

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { UniqueConstraintError } from 'sequelize';
import * as jwt from 'jsonwebtoken';
import { ChatDtoService } from '../infra/chat-dto.service';
import { ProductDtoService } from '@app/domains/catalog';
import { DbUtilsService } from '@app/infrastructure/database/db-utils/db-utils.service';
import { ApiConfigService } from '@app/common/config';
import { RedisPubSubService } from '@app/infrastructure/redis-pubsub/redis-pubsub.service';
import ChatChannel from '../infra/models/chat-channel.model';
import ChatMessage from '../infra/models/chat-message.model';
import ChatChannelMember, {
  ChatChannelMemberRole,
  ChatChannelMemberStatus,
} from '../infra/models/chat-channel-member.model';
import {
  CHAT_MODERATION_REDIS_TOPIC,
  CHAT_WS_TICKET_TTL_SECONDS,
  CHAT_WS_TICKET_TYPE,
  ChatChannelEventType,
  ChatModerationEventType,
  chatChannelRedisTopic,
} from '../domain/chat.constants';
import {
  ChatChannelRawDto,
  ChatWsTicketRespDto,
  CreateChatChannelDto,
  ListChatMessagesQueryDto,
  MuteChatMemberDto,
  UpdateChatChannelDto,
} from '../api/chat.dto';

const MODERATOR_ROLES = [
  ChatChannelMemberRole.OWNER,
  ChatChannelMemberRole.MODERATOR,
];

/** Role hierarchy for "who can act on whom": strictly higher rank required. */
const ROLE_RANK: Record<ChatChannelMemberRole, number> = {
  [ChatChannelMemberRole.OWNER]: 2,
  [ChatChannelMemberRole.MODERATOR]: 1,
  [ChatChannelMemberRole.MEMBER]: 0,
};

@Injectable()
export class ChatService {
  private readonly l = new Logger(ChatService.name);

  constructor(
    private readonly chatDtoService: ChatDtoService,
    private readonly productDtoService: ProductDtoService,
    private readonly dbUtilsService: DbUtilsService,
    private readonly configService: ApiConfigService,
    private readonly redisPubSubService: RedisPubSubService,
  ) {}

  private toRawDto(
    channel: ChatChannel,
    myRole?: ChatChannelMemberRole,
  ): ChatChannelRawDto {
    return {
      id: channel.id,
      productId: channel.productId,
      sellerId: channel.sellerId,
      title: channel.title,
      isArchived: channel.isArchived,
      archivedAt: channel.archivedAt,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
      myRole,
    };
  }

  public async createChannel(
    userId: string,
    dto: CreateChatChannelDto,
  ): Promise<ChatChannelRawDto> {
    const product = await this.productDtoService.requestProduct({
      params: { id: dto.productId },
    });

    if (product.sellerId !== userId) {
      throw new ForbiddenException(
        'Only the product seller can create a chat channel for this product',
      );
    }

    try {
      const channel = await this.dbUtilsService.wrapInTransaction(
        async (tx) => {
          const created = await this.chatDtoService.createChannel({
            params: {
              productId: dto.productId,
              sellerId: userId,
              title: dto.title ?? product.title,
            },
            tx,
          });

          await this.chatDtoService.ensureMember({
            channelId: created.id,
            userId,
            role: ChatChannelMemberRole.OWNER,
            tx,
          });

          return created;
        },
      );

      return this.toRawDto(channel, ChatChannelMemberRole.OWNER);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new BadRequestException(
          'A chat channel already exists for this product',
        );
      }
      throw error;
    }
  }

  public async getChannelForProduct(
    productId: string,
    userId: string,
  ): Promise<ChatChannelRawDto> {
    const channel = await this.chatDtoService.requestChannel({
      params: { productId },
    });
    const member = await this.chatDtoService.findMember({
      channelId: channel.id,
      userId,
    });

    return this.toRawDto(channel, member?.role);
  }

  /**
   * A buyer joins a product's chat. Re-joining keeps the existing membership (a ban sticks); archived
   * channels take no new members.
   */
  public async joinChannel(
    channelId: string,
    userId: string,
  ): Promise<ChatChannelRawDto> {
    const channel = await this.chatDtoService.requestChannel({
      params: { id: channelId },
    });
    if (channel.isArchived)
      throw new ForbiddenException('This chat is archived');
    const member = await this.chatDtoService.ensureMember({
      channelId,
      userId,
    });
    if (member.status === ChatChannelMemberStatus.BANNED)
      throw new ForbiddenException('You are banned from this chat');
    return this.toRawDto(channel, member.role);
  }

  public async getChannel(
    channelId: string,
    userId: string,
  ): Promise<ChatChannelRawDto> {
    const channel = await this.chatDtoService.requestChannel({
      params: { id: channelId },
    });
    const member = await this.chatDtoService.findMember({
      channelId: channel.id,
      userId,
    });

    return this.toRawDto(channel, member?.role);
  }

  public async updateChannel(
    channelId: string,
    userId: string,
    dto: UpdateChatChannelDto,
  ): Promise<ChatChannelRawDto> {
    const member = await this.requireMember(channelId, userId);
    if (member.role !== ChatChannelMemberRole.OWNER) {
      throw new ForbiddenException(
        'Only the channel owner can update this channel',
      );
    }

    const channel = await this.chatDtoService.updateChannel({
      id: channelId,
      params: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.isArchived !== undefined && {
          isArchived: dto.isArchived,
          archivedAt: dto.isArchived ? new Date() : null,
        }),
      },
    });

    if (dto.isArchived) {
      await this.redisPubSubService.publish(chatChannelRedisTopic(channelId), {
        type: ChatChannelEventType.CHANNEL_ARCHIVED,
        channelId,
      });
    }

    return this.toRawDto(channel, member.role);
  }

  public async listMessages(
    channelId: string,
    userId: string,
    query: ListChatMessagesQueryDto,
  ): Promise<ChatMessage[]> {
    await this.chatDtoService.requestChannel({ params: { id: channelId } });

    const member = await this.chatDtoService.findMember({
      channelId,
      userId,
    });
    if (member?.status === ChatChannelMemberStatus.BANNED) {
      throw new ForbiddenException('You are banned from this channel');
    }

    return this.chatDtoService.findMessages({
      channelId,
      beforeId: query.before,
      limit: query.limit ?? 50,
    });
  }

  public async deleteMessage(
    channelId: string,
    userId: string,
    messageId: string,
  ): Promise<void> {
    const message = await this.chatDtoService.requestMessage({
      params: { id: messageId, channelId },
    });
    const member = await this.requireMember(channelId, userId);

    const isAuthor = message.authorId === userId;
    const isModerator = MODERATOR_ROLES.includes(member.role);
    if (!isAuthor && !isModerator) {
      throw new ForbiddenException(
        'Only the author or a moderator can delete this message',
      );
    }

    await this.chatDtoService.softDeleteMessage({ id: messageId });

    await this.redisPubSubService.publish(chatChannelRedisTopic(channelId), {
      type: ChatChannelEventType.MESSAGE_DELETED,
      channelId,
      messageId,
    });
  }

  public async banMember(
    channelId: string,
    actingUserId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.assertCanModerate(channelId, actingUserId, targetUserId);

    const target = await this.chatDtoService.ensureMember({
      channelId,
      userId: targetUserId,
    });
    await this.chatDtoService.updateMember({
      id: target.id,
      params: { status: ChatChannelMemberStatus.BANNED },
    });

    await this.publishModeration(
      ChatModerationEventType.BAN,
      channelId,
      targetUserId,
    );
  }

  public async unbanMember(
    channelId: string,
    actingUserId: string,
    targetUserId: string,
  ): Promise<void> {
    await this.assertCanModerate(channelId, actingUserId, targetUserId);

    const target = await this.chatDtoService.ensureMember({
      channelId,
      userId: targetUserId,
    });
    await this.chatDtoService.updateMember({
      id: target.id,
      params: { status: ChatChannelMemberStatus.ACTIVE },
    });

    await this.publishModeration(
      ChatModerationEventType.UNBAN,
      channelId,
      targetUserId,
    );
  }

  public async muteMember(
    channelId: string,
    actingUserId: string,
    dto: MuteChatMemberDto,
  ): Promise<void> {
    await this.assertCanModerate(channelId, actingUserId, dto.userId);

    const mutedUntil = new Date(Date.now() + dto.minutes * 60_000);
    const target = await this.chatDtoService.ensureMember({
      channelId,
      userId: dto.userId,
    });
    await this.chatDtoService.updateMember({
      id: target.id,
      params: { mutedUntil },
    });

    await this.publishModeration(
      ChatModerationEventType.MUTE,
      channelId,
      dto.userId,
      mutedUntil,
    );
  }

  public async promoteMember(
    channelId: string,
    actingUserId: string,
    targetUserId: string,
  ): Promise<void> {
    const actingMember = await this.requireMember(channelId, actingUserId);
    if (actingMember.role !== ChatChannelMemberRole.OWNER) {
      throw new ForbiddenException(
        'Only the channel owner can promote moderators',
      );
    }

    const target = await this.chatDtoService.ensureMember({
      channelId,
      userId: targetUserId,
    });
    await this.chatDtoService.updateMember({
      id: target.id,
      params: { role: ChatChannelMemberRole.MODERATOR },
    });

    await this.publishModeration(
      ChatModerationEventType.PROMOTE,
      channelId,
      targetUserId,
    );
  }

  public async mintWsTicket(userId: string): Promise<ChatWsTicketRespDto> {
    const ticket = jwt.sign(
      { sub: userId, typ: CHAT_WS_TICKET_TYPE },
      this.configService.get('jwt_secret'),
      { expiresIn: CHAT_WS_TICKET_TTL_SECONDS },
    );

    return {
      ticket,
      wsUrl: this.configService.get('chat_ws_url'),
      expiresAt: new Date(
        Date.now() + CHAT_WS_TICKET_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  private async requireMember(
    channelId: string,
    userId: string,
  ): Promise<ChatChannelMember> {
    const member = await this.chatDtoService.findMember({
      channelId,
      userId,
    });

    if (!member || member.status === ChatChannelMemberStatus.BANNED) {
      throw new ForbiddenException('You are not a member of this channel');
    }

    return member;
  }

  private async assertCanModerate(
    channelId: string,
    actingUserId: string,
    targetUserId: string,
  ): Promise<void> {
    const actingMember = await this.requireMember(channelId, actingUserId);
    if (!MODERATOR_ROLES.includes(actingMember.role)) {
      throw new ForbiddenException(
        'Only the channel owner or a moderator can do this',
      );
    }

    const targetMember = await this.chatDtoService.findMember({
      channelId,
      userId: targetUserId,
    });
    if (
      targetMember &&
      ROLE_RANK[targetMember.role] >= ROLE_RANK[actingMember.role]
    ) {
      throw new ForbiddenException(
        'Cannot moderate a member with an equal or higher role',
      );
    }
  }

  private async publishModeration(
    type: ChatModerationEventType,
    channelId: string,
    userId: string,
    mutedUntil?: Date,
  ): Promise<void> {
    await this.redisPubSubService.publish(CHAT_MODERATION_REDIS_TOPIC, {
      type,
      channelId,
      userId,
      ...(mutedUntil && { mutedUntil: mutedUntil.toISOString() }),
    });
  }
}

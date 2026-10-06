import { Injectable, Logger } from '@nestjs/common';
import { Transaction } from 'sequelize';
import { InjectModel } from '@nestjs/sequelize';
import { Fatal_NotFoundError } from '@app/common/errors/error.types';
import ChatChannel, {
  ChatChannelScope,
  ChatChannelWithAllFilters,
} from './models/chat-channel.model';
import ChatChannelMember, {
  ChatChannelMemberScope,
  ChatChannelMemberWithAllFilters,
} from './models/chat-channel-member.model';
import ChatMessage, {
  ChatMessageScope,
  ChatMessageWithAllFilters,
} from './models/chat-message.model';

@Injectable()
export class ChatDtoService {
  private readonly l = new Logger(ChatDtoService.name);

  constructor(
    @InjectModel(ChatChannel)
    private readonly chatChannelModel: typeof ChatChannel,
    @InjectModel(ChatChannelMember)
    private readonly chatChannelMemberModel: typeof ChatChannelMember,
    @InjectModel(ChatMessage)
    private readonly chatMessageModel: typeof ChatMessage,
  ) {}

  // --- --- --- --- --- ChatChannel --- --- --- --- --- //

  public findChannel(
    params?: ChatChannelWithAllFilters,
    tx?: Transaction,
  ): Promise<ChatChannel | null> {
    return this.chatChannelModel
      .scope({ method: [ChatChannelScope.WithAll, params] })
      .findOne({ transaction: tx });
  }

  public findChannels(
    params?: ChatChannelWithAllFilters,
    tx?: Transaction,
  ): Promise<ChatChannel[]> {
    return this.chatChannelModel
      .scope({ method: [ChatChannelScope.WithAll, params] })
      .findAll({ transaction: tx });
  }

  public async requestChannel({
    params,
    tx,
  }: {
    params: ChatChannelWithAllFilters;
    tx?: Transaction;
  }): Promise<ChatChannel> {
    const channel = await this.findChannel(params, tx);

    if (!channel) {
      throw new Fatal_NotFoundError({
        detail: `Chat channel ${params.id ?? params.productId} not found`,
        title: 'Chat channel not found',
      });
    }

    return channel;
  }

  public async createChannel({
    params,
    tx,
  }: {
    params: Partial<ChatChannel>;
    tx?: Transaction;
  }): Promise<ChatChannel> {
    return this.chatChannelModel.create(params, { transaction: tx });
  }

  public async updateChannel({
    params,
    id,
    tx,
  }: {
    params: Partial<ChatChannel>;
    id: string;
    tx?: Transaction;
  }): Promise<ChatChannel> {
    const [count, [channel]] = await this.chatChannelModel.update(params, {
      where: { id },
      transaction: tx,
      returning: true,
    });

    if (count === 0 || !channel) {
      throw new Fatal_NotFoundError({
        detail: 'Chat channel is not updated',
        title: 'Chat channel is not updated',
      });
    }

    return channel;
  }

  // --- --- --- --- --- ChatChannelMember --- --- --- --- --- //

  public findMember(
    params?: ChatChannelMemberWithAllFilters,
    tx?: Transaction,
  ): Promise<ChatChannelMember | null> {
    return this.chatChannelMemberModel
      .scope({ method: [ChatChannelMemberScope.WithAll, params] })
      .findOne({ transaction: tx });
  }

  public findMembers(
    params?: ChatChannelMemberWithAllFilters,
    tx?: Transaction,
  ): Promise<ChatChannelMember[]> {
    return this.chatChannelMemberModel
      .scope({ method: [ChatChannelMemberScope.WithAll, params] })
      .findAll({ transaction: tx });
  }

  /**
   * Membership is implicit for registered users - this creates the row the
   * first time it's needed (channel creation for the seller, first
   * moderation action, etc.) instead of requiring an explicit "join" step.
   */
  public async ensureMember({
    channelId,
    userId,
    role,
    tx,
  }: {
    channelId: string;
    userId: string;
    role?: ChatChannelMember['role'];
    tx?: Transaction;
  }): Promise<ChatChannelMember> {
    const [member] = await this.chatChannelMemberModel.findOrCreate({
      where: { channelId, userId },
      defaults: { channelId, userId, ...(role && { role }) },
      transaction: tx,
    });

    return member;
  }

  public async updateMember({
    params,
    id,
    tx,
  }: {
    params: Partial<ChatChannelMember>;
    id: string;
    tx?: Transaction;
  }): Promise<ChatChannelMember> {
    const [count, [member]] = await this.chatChannelMemberModel.update(
      params,
      {
        where: { id },
        transaction: tx,
        returning: true,
      },
    );

    if (count === 0 || !member) {
      throw new Fatal_NotFoundError({
        detail: 'Chat channel member is not updated',
        title: 'Chat channel member is not updated',
      });
    }

    return member;
  }

  // --- --- --- --- --- ChatMessage (read path - writes come from the Rust gateway) --- --- --- --- --- //

  public findMessages(
    params?: ChatMessageWithAllFilters,
    tx?: Transaction,
  ): Promise<ChatMessage[]> {
    return this.chatMessageModel
      .scope({ method: [ChatMessageScope.WithAll, params] })
      .findAll({ transaction: tx });
  }

  public findMessage(
    params?: ChatMessageWithAllFilters,
    tx?: Transaction,
  ): Promise<ChatMessage | null> {
    return this.chatMessageModel
      .scope({ method: [ChatMessageScope.WithAll, params] })
      .findOne({ transaction: tx });
  }

  public async requestMessage({
    params,
    tx,
  }: {
    params: ChatMessageWithAllFilters;
    tx?: Transaction;
  }): Promise<ChatMessage> {
    const message = await this.findMessage(params, tx);

    if (!message) {
      throw new Fatal_NotFoundError({
        detail: `Chat message ${params.id} not found`,
        title: 'Chat message not found',
      });
    }

    return message;
  }

  /** Moderation-only soft delete; the message row is kept for audit purposes. */
  public async softDeleteMessage({
    id,
    tx,
  }: {
    id: string;
    tx?: Transaction;
  }): Promise<ChatMessage> {
    const [count, [message]] = await this.chatMessageModel.update(
      { deletedAt: new Date() },
      { where: { id }, transaction: tx, returning: true },
    );

    if (count === 0 || !message) {
      throw new Fatal_NotFoundError({
        detail: 'Chat message is not deleted',
        title: 'Chat message is not deleted',
      });
    }

    return message;
  }
}

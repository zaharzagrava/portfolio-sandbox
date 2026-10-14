import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  ChatChannelEventType,
  ChatChannelMemberRole,
  ChatChannelMemberStatus,
  ChatModerationEventType,
} from '../domain/chat.constants';
import {
  channelNotFound,
  forbidden,
  invalidTransition,
  memberNotFound,
  messageNotFound,
} from '../domain/errors';
import {
  canActOn,
  memberTransition,
  type ActorRank,
  type MemberState,
  type ModerationAction,
} from '../domain/moderation-rules';
import {
  PORTS,
  type ChannelRecord,
  type ChannelRepository,
  type MemberRecord,
  type MembershipRepository,
  type MessageRepository,
  type ShopAuthority,
} from '../domain/ports';
import { ChatPublisher } from './chat-publisher';

const EVENT: Record<ModerationAction, ChatModerationEventType> = {
  ban: ChatModerationEventType.BAN,
  unban: ChatModerationEventType.UNBAN,
  mute: ChatModerationEventType.MUTE,
  unmute: ChatModerationEventType.UNMUTE,
  promote: ChatModerationEventType.PROMOTE,
  demote: ChatModerationEventType.DEMOTE,
};

/** Rank of a member: shop staff (live) outranks the stored roles; a stored OWNER has no authority of its own (FR-031). */
const rankOf = (
  isManager: boolean,
  role: ChatChannelMemberRole | undefined,
): ActorRank => (isManager ? 'STAFF' : ((role ?? 'MEMBER') as ActorRank));

/**
 * Moderation and message deletion (S24 US7, FR-031, FR-040, FR-041). Authority is the live shop membership (never
 * cached here); a stored `MODERATOR` may act on strictly lower ranks. Every state change is a conditional update that
 * asserts the row it expects, so a lost race is `409 invalid_transition`; the event on the moderation bus follows the
 * commit and a bus that is down never fails the call.
 */
@Injectable()
export class ChatModerationService {
  constructor(
    @Inject(PORTS.ChannelRepository)
    private readonly channels: ChannelRepository,
    @Inject(PORTS.MembershipRepository)
    private readonly members: MembershipRepository,
    @Inject(PORTS.MessageRepository)
    private readonly messages: MessageRepository,
    @Inject(PORTS.ShopAuthority) private readonly shops: ShopAuthority,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly publisher: ChatPublisher,
  ) {}

  async moderate(
    actorId: string,
    channelId: string,
    action: ModerationAction,
    targetId: string,
    minutes?: number,
  ): Promise<void> {
    const { channel, actor } = await this.actorOf(actorId, channelId);
    // no authority at all (a plain member): refused before the target is looked up, so nothing can be probed through it
    if (actor === 'MEMBER' || actor === 'OWNER') throw forbidden();

    const target = await this.members.find(channelId, targetId);
    if (!target) throw memberNotFound();
    const targetRank = rankOf(
      await this.shops.canManage(channel.shopId, targetId),
      target.role,
    );
    if (!canActOn({ actor, target: targetRank, self: actorId === targetId }))
      throw forbidden();
    // promoting and demoting is manager authority (FR-041)
    if ((action === 'promote' || action === 'demote') && actor !== 'STAFF')
      throw forbidden();

    const now = this.clock.now();
    const next = memberTransition(action, this.stateOf(target), now, minutes);
    if (!next.ok) throw invalidTransition();

    await this.runner.run(async () => {
      // the channel row first (as a sender does), then the member row: the member count moves with a status flip
      if (action === 'ban' || action === 'unban')
        await this.channels.lock(channelId);
      const done = await this.apply(
        action,
        channelId,
        targetId,
        target,
        next.next,
        now,
      );
      if (!done) throw invalidTransition();
    });

    await this.publisher.moderation({
      type: EVENT[action],
      channelId,
      userId: targetId,
      ...(action === 'mute'
        ? { mutedUntil: next.next.mutedUntil!.toISOString() }
        : {}),
    });
  }

  /**
   * Idempotent (`204` each time). The author deletes their own message; a moderator or staff delete a strictly
   * lower-ranked author's. The tombstone, who and when, and the channel's delete epoch (the cache key) change in one
   * transaction; the live event is published once, by the call that changed the row.
   */
  async deleteMessage(
    actorId: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const { channel, actor } = await this.actorOf(actorId, channelId);
    const found = await this.messages.authorOf(channelId, messageId);
    if (!found) throw messageNotFound();
    if (found.authorId !== actorId) {
      const author = await this.members.find(channelId, found.authorId);
      const authorRank = rankOf(
        await this.shops.canManage(channel.shopId, found.authorId),
        author?.role,
      );
      if (!canActOn({ actor, target: authorRank, self: false }))
        throw forbidden();
    }
    const now = this.clock.now();
    const outcome = await this.runner.run(async () => {
      const result = await this.messages.softDelete(
        channelId,
        messageId,
        actorId,
        now,
      );
      if (result === 'deleted') await this.channels.bumpDeleteEpoch(channelId);
      return result;
    });
    if (outcome === 'missing') throw messageNotFound();
    if (outcome === 'deleted') {
      await this.publisher.channel(
        channelId,
        { type: ChatChannelEventType.MESSAGE_DELETED, channelId, messageId },
        'message_deleted',
      );
    }
  }

  /**
   * The channel and the caller's rank in it. A caller who is neither an active member nor a manager gets the same
   * `404 channel_not_found` as for an unknown channel.
   */
  private async actorOf(
    actorId: string,
    channelId: string,
  ): Promise<{ channel: ChannelRecord; actor: ActorRank }> {
    const channel = await this.channels.findById(channelId);
    if (!channel) throw channelNotFound();
    const [member, manager] = await Promise.all([
      this.members.find(channelId, actorId),
      this.shops.canManage(channel.shopId, actorId),
    ]);
    const active =
      member?.status === ChatChannelMemberStatus.ACTIVE ? member : undefined;
    if (!manager && !active) throw channelNotFound();
    return { channel, actor: rankOf(manager, active?.role) };
  }

  private stateOf(member: MemberRecord): MemberState {
    return {
      role: member.role as MemberState['role'],
      status: member.status as MemberState['status'],
      mutedUntil: member.mutedUntil,
    };
  }

  private apply(
    action: ModerationAction,
    channelId: string,
    userId: string,
    from: MemberRecord,
    to: MemberState,
    now: Date,
  ): Promise<boolean> {
    switch (action) {
      case 'ban':
      case 'unban':
        return this.members.changeStatus(
          channelId,
          userId,
          from.status,
          to.status as ChatChannelMemberStatus,
        );
      case 'promote':
      case 'demote':
        return this.members.changeRole(
          channelId,
          userId,
          from.role,
          to.role as ChatChannelMemberRole,
        );
      case 'mute':
        return this.members.setMute(channelId, userId, to.mutedUntil!, now);
      case 'unmute':
        return this.members.clearMute(channelId, userId, now);
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { forbidden, channelNotFound } from '../domain/errors';
import {
  PORTS,
  type ChannelRecord,
  type ChannelRepository,
  type MemberRecord,
  type MembershipRepository,
  type ShopAuthority,
} from '../domain/ports';
import { ChatChannelMemberStatus } from '../domain/chat.constants';

/**
 * Who may act on a channel (S24 FR-031, R-06). Manager authority is the live shop membership with `products.write`,
 * asked every time and never cached (AS-54); the stored `OWNER` role confers none by itself. A caller who is neither a
 * manager nor an active member gets the same `404 channel_not_found` as for an unknown channel; an active member
 * without authority gets `403 permission_denied`.
 */
@Injectable()
export class ChatAuthority {
  constructor(
    @Inject(PORTS.ChannelRepository)
    private readonly channels: ChannelRepository,
    @Inject(PORTS.MembershipRepository)
    private readonly members: MembershipRepository,
    @Inject(PORTS.ShopAuthority) private readonly shops: ShopAuthority,
  ) {}

  isManager(channel: ChannelRecord, userId: string): Promise<boolean> {
    return this.shops.canManage(channel.shopId, userId);
  }

  /** The channel, for a caller with manager authority over it. */
  async requireManager(
    channelId: string,
    userId: string,
  ): Promise<{ channel: ChannelRecord; member: MemberRecord | null }> {
    const channel = await this.channels.findById(channelId);
    if (!channel) throw channelNotFound();
    const member = await this.members.find(channelId, userId);
    const active =
      member?.status === ChatChannelMemberStatus.ACTIVE ? member : null;
    if (await this.isManager(channel, userId))
      return { channel, member: active };
    if (!active) throw channelNotFound();
    throw forbidden();
  }
}

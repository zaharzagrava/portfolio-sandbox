import { Inject, Injectable } from '@nestjs/common';
import type {
  ChatChannel,
  ChatInboxPage,
  CreateChannelRequest,
  UpdateChannelRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { ChatChannelEventType } from '../domain/chat.constants';
import {
  banned,
  channelArchived,
  channelExists,
  channelNotFound,
  ChatValidationError,
  forbidden,
  invalidTransition,
  productArchived,
  productNotFound,
} from '../domain/errors';
import {
  decodeInboxCursor,
  encodeInboxCursor,
  type InboxCursor,
} from '../domain/history-cursor';
import {
  PORTS,
  type ChannelRecord,
  type ChannelRepository,
  type MembershipRepository,
  type ProductLookup,
  type ShopAuthority,
} from '../domain/ports';
import { ChatAuthority } from './chat-authority';
import { ChatPublisher } from './chat-publisher';
import { toChannelView } from './chat-views';

const TITLE_MAX = 120;

/** Channels: open, join, read, rename and archive (S24 US1). Thin over the ports; time only from the injected clock. */
@Injectable()
export class ChatChannelService {
  constructor(
    @Inject(PORTS.ChannelRepository)
    private readonly channels: ChannelRepository,
    @Inject(PORTS.MembershipRepository)
    private readonly members: MembershipRepository,
    @Inject(PORTS.ProductLookup) private readonly products: ProductLookup,
    @Inject(PORTS.ShopAuthority) private readonly shops: ShopAuthority,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly authority: ChatAuthority,
    private readonly publisher: ChatPublisher,
    private readonly runner: TransactionRunner,
  ) {}

  /**
   * Opens the chat for a product: shop staff with `products.write` (live), product from the catalog's R1 service. The
   * unique `productId` decides a race: the loser gets `409 channel_exists` (never a second row).
   */
  async create(
    userId: string,
    input: CreateChannelRequest,
  ): Promise<ChatChannel> {
    const product = await this.products.find(input.productId);
    if (!product) throw productNotFound();
    if (!(await this.shops.canManage(product.shopId, userId)))
      throw forbidden();
    if (product.status === 'ARCHIVED') throw productArchived();
    const title =
      input.title ?? [...product.title].slice(0, TITLE_MAX).join('');
    const channel = await this.channels.createIfAbsent({
      productId: product.id,
      shopId: product.shopId,
      sellerId: userId,
      title,
      ownerUserId: userId,
      now: this.clock.now(),
    });
    if (!channel) throw channelExists();
    return toChannelView(channel, 'OWNER');
  }

  async join(channelId: string, userId: string): Promise<ChatChannel> {
    const outcome = await this.members.join(
      channelId,
      userId,
      this.clock.now(),
    );
    switch (outcome.kind) {
      case 'not_found':
        throw channelNotFound();
      case 'banned':
        throw banned();
      case 'archived':
        throw channelArchived();
      case 'joined':
      case 'exists': {
        const found = await this.channels.findForMember(channelId, userId);
        if (!found) throw channelNotFound();
        return toChannelView(found.channel, outcome.member.role);
      }
    }
  }

  /**
   * The caller's chats for the inbox (W05 B-1): active memberships only, archived ones after the active ones, newest
   * message first. One query for the page; keyset cursor.
   */
  async mine(
    userId: string,
    query: { limit: number; cursor?: string },
  ): Promise<ChatInboxPage> {
    let after: InboxCursor | null = null;
    if (query.cursor !== undefined) {
      after = decodeInboxCursor(query.cursor);
      if (!after) throw new ChatValidationError(['cursor']);
    }
    const rows = await this.channels.listMine(userId, query.limit + 1, after);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ channel, member, lastMessageAt }) => ({
        ...toChannelView(channel, member.role),
        unread: Math.max(0, channel.lastSeq - member.lastReadSeq),
        lastSeq: channel.lastSeq,
        lastMessageAt: lastMessageAt
          ? new Date(lastMessageAt).toISOString()
          : null,
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeInboxCursor({
              archived: last.channel.isArchived,
              at: last.lastMessageAt,
              channelId: last.channel.id,
            })
          : null,
    };
  }

  /** Members only; a stranger (or a banned member) is told the channel does not exist. */
  async get(channelId: string, userId: string): Promise<ChatChannel> {
    const found = await this.channels.findForMember(channelId, userId);
    if (!found) throw channelNotFound();
    return toChannelView(found.channel, found.member.role);
  }

  /** The discovery route: any signed-in user, public fields only, `myRole` null for a non-member. */
  async byProduct(productId: string, userId: string): Promise<ChatChannel> {
    const found = await this.channels.findByProduct(productId, userId);
    if (!found) throw channelNotFound();
    return toChannelView(found.channel, found.member?.role ?? null);
  }

  /**
   * Rename and/or (un)archive: manager authority. The state change is a conditional update (`isArchived = :from`), so
   * a repeat or a lost race is `409 invalid_transition`; the live event follows the commit.
   */
  async update(
    channelId: string,
    userId: string,
    input: UpdateChannelRequest,
  ): Promise<ChatChannel> {
    const { member } = await this.authority.requireManager(channelId, userId);
    const now = this.clock.now();
    const updated = await this.runner.run(async () => {
      let current: ChannelRecord | null = null;
      if (input.isArchived !== undefined) {
        current = await this.channels.setArchived(
          channelId,
          !input.isArchived,
          now,
        );
        if (!current) throw invalidTransition();
      }
      if (input.title !== undefined) {
        current = await this.channels.setTitle(channelId, input.title, now);
        if (!current) throw channelNotFound();
      }
      return current!;
    });
    if (input.isArchived === true) {
      await this.publisher.channel(
        channelId,
        { type: ChatChannelEventType.CHANNEL_ARCHIVED, channelId },
        'channel_archived',
      );
    }
    return toChannelView(updated, member?.role ?? null);
  }
}

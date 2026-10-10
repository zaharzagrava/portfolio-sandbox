import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { UserDirectoryService } from '@app/domains/identity';
import {
  INVITE_REPOSITORY,
  MEMBERSHIP_REPOSITORY,
  SHOP_REPOSITORY,
  TENANT_TRANSACTIONS,
  type InviteRecord,
  type InviteRepository,
  type InviteStatus,
  type MembershipRepository,
  type ShopRepository,
  type TenantTransactions,
} from '../domain/ports';
import {
  INVITE_REQUESTED_QUEUE,
  INVITE_REQUESTED_TYPE,
  InviteCreated,
  MemberAdded,
  type InviteRequested,
} from '../domain/events';
import {
  Domain_AlreadyMemberError,
  Domain_InsufficientRoleError,
  Domain_InvalidQueryError,
  Domain_InvalidTransitionError,
  Domain_InvitePendingError,
  Domain_InviteNotFoundError,
  Domain_SeatLimitReachedError,
  Domain_ShopNotFoundError,
} from '../domain/errors';
import { decodeKeyset, encodeKeyset, parseLimit } from '../domain/cursor';
import {
  digestInviteToken,
  generateInviteToken,
  INVITE_TTL_MS,
} from '../domain/invite-token';
import { canManage } from '../domain/role-policy';
import { hasFreeSeat } from '../domain/seat-policy';
import type { ShopRole } from '../domain/shop-types';
import { ShopAccessService } from './shop-access.service';
import { TenancyAudit } from './tenancy-observability';

interface Actor {
  id: string;
  role: ShopRole;
}

export const inviteStatus = (invite: InviteRecord, now: Date): InviteStatus =>
  invite.acceptedAt
    ? 'accepted'
    : invite.revokedAt
      ? 'revoked'
      : invite.expiresAt.getTime() <= now.getTime()
        ? 'expired'
        : 'pending';

/**
 * Invitations (FR-030 to FR-035). The token exists in memory twice: once hashed in the row, once in the
 * single-consumer message that the mail capability reads; it is in no response, event, log or audit line.
 */
@Injectable()
export class InviteService {
  constructor(
    @Inject(INVITE_REPOSITORY) private readonly invites: InviteRepository,
    @Inject(MEMBERSHIP_REPOSITORY)
    private readonly members: MembershipRepository,
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly directory: UserDirectoryService,
    private readonly access: ShopAccessService,
    private readonly audit: TenancyAudit,
  ) {}

  async create(
    shopId: string,
    actor: Actor,
    input: { email: string; role: Exclude<ShopRole, 'OWNER'> },
  ) {
    if (!canManage(actor.role, input.role, input.role))
      throw new Domain_InsufficientRoleError();
    const email = input.email.trim().toLowerCase();
    const existingUser = await this.directory.findByEmail(email);

    const record = await this.shopTx.inShop(
      shopId,
      async () => {
        // The shop row is the lock that serialises seat counting and invite creation for this shop.
        const shop = await this.shops.lockById(shopId);
        if (!shop || shop.status === 'DELETED')
          throw new Domain_ShopNotFoundError();
        const now = this.clock.now();

        if (existingUser && (await this.members.find(shopId, existingUser.id)))
          throw new Domain_AlreadyMemberError();
        const pending = await this.invites.findPendingByEmail(shopId, email);
        if (pending) {
          if (pending.expiresAt.getTime() > now.getTime())
            throw new Domain_InvitePendingError();
          await this.invites.revoke(shopId, pending.id, now); // an expired one is replaced
        }
        const seatsUsed = await this.members.count(shopId);
        const seatsHeld = await this.invites.countPending(shopId, now);
        if (!hasFreeSeat(shop.plan, seatsUsed, seatsHeld))
          throw new Domain_SeatLimitReachedError();

        const token = generateInviteToken();
        const inserted = await this.invites.insert({
          shopId,
          email,
          role: input.role,
          tokenHash: digestInviteToken(token),
          invitedBy: actor.id,
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          now,
        });
        if (!inserted) throw new Domain_InvitePendingError();
        await this.publish(shop.shopVersion, shop.name, inserted, token);
        return inserted;
      },
      { userId: actor.id },
    );
    this.audit.record('invite.created', {
      shopId,
      actorId: actor.id,
      inviteId: record.id,
    });
    return this.toDto(record);
  }

  async list(
    shopId: string,
    viewerId: string,
    query: { status?: InviteStatus; limit?: string; cursor?: string },
  ) {
    const limit = parseLimit(query.limit);
    if (limit === null)
      throw new Domain_InvalidQueryError('limit', 'invalid_limit');
    let after: { key: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      after = decodeKeyset(query.cursor);
      if (!after)
        throw new Domain_InvalidQueryError('cursor', 'invalid_cursor');
    }
    const now = this.clock.now();
    const rows = await this.shopTx.inShop(
      shopId,
      () =>
        this.invites.listPage(
          shopId,
          query.status ?? null,
          now,
          after,
          limit + 1,
        ),
      { userId: viewerId },
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((i) => this.toDto(i)),
      nextCursor:
        rows.length > limit && last
          ? encodeKeyset(last.cursorKey, last.id)
          : null,
    };
  }

  async resend(shopId: string, actor: Actor, inviteId: string) {
    const record = await this.shopTx.inShop(
      shopId,
      async () => {
        const shop = await this.shops.lockById(shopId);
        if (!shop || shop.status === 'DELETED')
          throw new Domain_ShopNotFoundError();
        const invite = await this.invites.find(shopId, inviteId);
        if (!invite) throw new Domain_InviteNotFoundError();
        const now = this.clock.now();
        const status = inviteStatus(invite, now);
        if (status === 'accepted' || status === 'revoked')
          throw new Domain_InvalidTransitionError();
        if (!canManage(actor.role, invite.role, invite.role))
          throw new Domain_InsufficientRoleError();

        const token = generateInviteToken();
        const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
        if (
          !(await this.invites.renew(
            shopId,
            inviteId,
            digestInviteToken(token),
            expiresAt,
          ))
        )
          throw new Domain_InvalidTransitionError();
        const renewed = { ...invite, expiresAt };
        await this.publish(shop.shopVersion, shop.name, renewed, token);
        return renewed;
      },
      { userId: actor.id },
    );
    this.audit.record('invite.resent', { shopId, actorId: actor.id, inviteId });
    return this.toDto(record);
  }

  /** Revoking is final; a repeat is a no-op, an accepted invite cannot be revoked. */
  async revoke(shopId: string, actor: Actor, inviteId: string): Promise<void> {
    await this.shopTx.inShop(
      shopId,
      async () => {
        const invite = await this.invites.find(shopId, inviteId);
        if (!invite) throw new Domain_InviteNotFoundError();
        const status = inviteStatus(invite, this.clock.now());
        if (status === 'accepted') throw new Domain_InvalidTransitionError();
        if (status === 'revoked') return;
        if (!canManage(actor.role, invite.role, invite.role))
          throw new Domain_InsufficientRoleError();
        if (!(await this.invites.revoke(shopId, inviteId, this.clock.now()))) {
          const after = await this.invites.find(shopId, inviteId);
          if (after?.acceptedAt) throw new Domain_InvalidTransitionError();
        }
      },
      { userId: actor.id },
    );
    this.audit.record('invite.revoked', {
      shopId,
      actorId: actor.id,
      inviteId,
    });
  }

  /**
   * The invitee has no shop context yet, so the lookup by token digest is an explicit, audited cross-tenant read.
   * Every failure - unknown, expired, revoked, used, someone else's address, no address, closed shop - is the same
   * `invite_not_found`; the conditional update lets exactly one concurrent accept win.
   */
  async accept(userId: string, token: string) {
    const profile = (await this.directory.getUsersByIds([userId])).get(userId);
    const address = profile?.email?.trim().toLowerCase();
    if (!address) throw new Domain_InviteNotFoundError();

    const result = await this.shopTx.crossTenant('invite.accept', async () => {
      const invite = await this.invites.findByTokenHash(
        digestInviteToken(token),
      );
      const now = this.clock.now();
      if (
        !invite ||
        invite.email.toLowerCase() !== address ||
        inviteStatus(invite, now) !== 'pending'
      )
        throw new Domain_InviteNotFoundError();
      const shop = await this.shops.lockById(invite.shopId);
      if (!shop || shop.status !== 'ACTIVE')
        throw new Domain_InviteNotFoundError();
      if (!(await this.invites.markAccepted(invite.id, userId, now)))
        throw new Domain_InviteNotFoundError();

      const existing = await this.members.find(invite.shopId, userId);
      if (existing)
        return {
          shopId: invite.shopId,
          role: existing.role,
          alreadyMember: true as const,
        };
      await this.members.insert({
        shopId: invite.shopId,
        userId,
        role: invite.role,
        source: 'invite',
        now,
      });
      await this.outbox.append(
        MemberAdded.create(invite.shopId, shop.shopVersion, {
          shopId: invite.shopId,
          userId,
          role: invite.role,
          source: 'invite',
        }),
      );
      return { shopId: invite.shopId, role: invite.role as ShopRole };
    });
    // The transaction has committed: drop a cached "not a member" so the new member is seen at once.
    this.access.invalidateAfterCommit(result.shopId, userId);
    this.audit.record('invite.accepted', {
      shopId: result.shopId,
      actorId: userId,
    });
    return result;
  }

  /** `invite_created` on the fan-out topic (no token) and `invite_requested` to the mail queue (the only carrier). */
  private async publish(
    shopVersion: number,
    shopName: string,
    invite: InviteRecord,
    token: string,
  ): Promise<void> {
    await this.outbox.append(
      InviteCreated.create(invite.shopId, shopVersion, {
        shopId: invite.shopId,
        inviteId: invite.id,
        role: invite.role,
      }),
    );
    const body: InviteRequested = {
      inviteId: invite.id,
      shopId: invite.shopId,
      shopName,
      email: invite.email,
      role: invite.role,
      token,
      expiresAt: invite.expiresAt.toISOString(),
      invitedBy: invite.invitedBy,
    };
    await this.outbox.appendTask({
      queue: INVITE_REQUESTED_QUEUE,
      type: INVITE_REQUESTED_TYPE,
      aggregateId: invite.shopId,
      body,
    });
  }

  private toDto(invite: InviteRecord) {
    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      status: inviteStatus(invite, this.clock.now()),
      invitedBy: invite.invitedBy,
      expiresAt: invite.expiresAt.toISOString(),
      createdAt: invite.createdAt.toISOString(),
    };
  }
}

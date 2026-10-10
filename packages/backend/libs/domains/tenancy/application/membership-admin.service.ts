import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@app/common/errors';
import { PlatformCodes } from '@app/common/errors/platform-codes';
import { afterCommit, TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { SessionRevocationService } from '@app/domains/identity';
import {
  MEMBERSHIP_REPOSITORY,
  SHOP_REPOSITORY,
  TENANT_TRANSACTIONS,
  type MembershipRepository,
  type ShopRepository,
  type TenantTransactions,
} from '../domain/ports';
import { MemberRemoved, MemberRoleChanged } from '../domain/events';
import {
  Domain_InsufficientRoleError,
  Domain_LastOwnerError,
  Domain_MemberNotFoundError,
  Domain_SerializationFailureError,
} from '../domain/errors';
import { serializationRetryCounter } from '../domain/tenancy-metrics';
import { canLeave, canManage } from '../domain/role-policy';
import type { ShopRole } from '../domain/shop-types';
import { ShopAccessService } from './shop-access.service';
import { TenancyAudit } from './tenancy-observability';

interface Actor {
  id: string;
  /** The role the guard resolved for this request. */
  role: ShopRole;
}

/**
 * Role changes, removals and self-leave (FR-021 to FR-023). The "a shop keeps an owner" invariant spans rows, so each
 * write runs under SERIALIZABLE isolation with the platform's bounded, jittered retry (3 attempts); exhaustion is
 * `503 serialization_failure`. Events go to the outbox in the same transaction; the cache entry and (for SSO members)
 * the sessions go after commit.
 */
@Injectable()
export class MembershipAdminService {
  constructor(
    @Inject(MEMBERSHIP_REPOSITORY)
    private readonly members: MembershipRepository,
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly access: ShopAccessService,
    private readonly sessions: SessionRevocationService,
    private readonly audit: TenancyAudit,
  ) {}

  async changeRole(
    shopId: string,
    actor: Actor,
    targetUserId: string,
    newRole: ShopRole,
  ): Promise<void> {
    await this.serializable(shopId, actor.id, async () => {
      const member = await this.members.find(shopId, targetUserId);
      if (!member) throw new Domain_MemberNotFoundError();
      if (!canManage(actor.role, member.role, newRole))
        throw new Domain_InsufficientRoleError();
      if (member.role === newRole) return; // already there: no write, no event
      if (
        member.role === 'OWNER' &&
        (await this.members.countOwners(shopId)) <= 1
      )
        throw new Domain_LastOwnerError();
      if (
        !(await this.members.updateRole(
          shopId,
          targetUserId,
          member.role,
          newRole,
        ))
      )
        throw new Domain_MemberNotFoundError();
      await this.outbox.append(
        MemberRoleChanged.create(shopId, await this.version(shopId), {
          shopId,
          userId: targetUserId,
          from: member.role,
          to: newRole,
        }),
      );
      this.access.invalidateAfterCommit(shopId, targetUserId);
      this.audit.record('member.role_changed', {
        shopId,
        actorId: actor.id,
        userId: targetUserId,
        from: member.role,
        to: newRole,
      });
    });
  }

  /** Removing someone else needs `members.manage` (read strongly) and `canManage`; leaving needs nothing but membership. */
  async remove(
    shopId: string,
    actor: Actor,
    targetUserId: string,
  ): Promise<void> {
    const self = actor.id === targetUserId;
    if (!self) await this.access.resolve(shopId, actor.id, 'members.manage');
    let revokeSessions = false;
    await this.serializable(shopId, actor.id, async () => {
      const member = await this.members.find(shopId, targetUserId);
      if (!member) throw new Domain_MemberNotFoundError();
      if (self ? !canLeave(member.role) : !canManage(actor.role, member.role))
        throw new Domain_InsufficientRoleError();
      if (
        member.role === 'OWNER' &&
        (await this.members.countOwners(shopId)) <= 1
      )
        throw new Domain_LastOwnerError();
      if (!(await this.members.delete(shopId, targetUserId, member.role)))
        throw new Domain_MemberNotFoundError();
      await this.outbox.append(
        MemberRemoved.create(shopId, await this.version(shopId), {
          shopId,
          userId: targetUserId,
          role: member.role,
          reason: self ? 'left' : 'removed',
        }),
      );
      this.access.invalidateAfterCommit(shopId, targetUserId);
      revokeSessions = member.source === 'sso';
      if (revokeSessions)
        afterCommit(async () => {
          await this.sessions.revokeAllForUser(
            targetUserId,
            'shop_membership_removed',
          );
        });
      this.audit.record('member.removed', {
        shopId,
        actorId: actor.id,
        userId: targetUserId,
        reason: self ? 'left' : 'removed',
      });
    });
  }

  private async version(shopId: string): Promise<number> {
    return (await this.shops.findById(shopId))?.shopVersion ?? 0;
  }

  private async serializable<T>(
    shopId: string,
    actorId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.runner.runSerializable(() =>
        this.shopTx.inShop(shopId, fn, { userId: actorId }),
      );
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === PlatformCodes.transaction_conflict
      ) {
        serializationRetryCounter.add(1, { outcome: 'exhausted' });
        throw new Domain_SerializationFailureError(error);
      }
      throw error;
    }
  }
}

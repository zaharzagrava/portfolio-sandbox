import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { afterCommit } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  OidcProviderRegistry,
  SessionRevocationService,
  UserDirectoryService,
} from '@app/domains/identity';
import {
  DIRECTORY_REPOSITORY,
  INVITE_REPOSITORY,
  MEMBERSHIP_REPOSITORY,
  SHOP_REPOSITORY,
  SSO_CONFIG_REPOSITORY,
  STATUS_HISTORY_REPOSITORY,
  TENANT_TRANSACTIONS,
  type DirectoryRepository,
  type InviteRecord,
  type InviteRepository,
  type MembershipRepository,
  type ShopRecord,
  type ShopRepository,
  type SsoConfigRepository,
  type StatusHistoryRepository,
  type TenantTransactions,
} from '../domain/ports';
import {
  MemberRemoved,
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
  ShopStatusChanged,
} from '../domain/events';
import {
  Domain_ConfirmationMismatchError,
  Domain_InvalidTransitionError,
  Domain_ShopNotFoundError,
  Domain_ShopSuspendedError,
} from '../domain/errors';
import { nextState, type ShopStatus } from '../domain/shop-status';
import {
  INVITE_RETENTION_MS,
  OFFBOARDING_GRACE_MS,
} from '../domain/offboarding-policy';
import { inviteStatus } from './invite.service';
import { toShopDto } from './shop.mapper';
import { ShopAccessService } from './shop-access.service';
import { ShopCellService } from './shop-cell.service';
import { TenancyAudit } from './tenancy-observability';

const EXPORT_PAGE = 100;
const PURGE_BATCH = 200;
const INVITE_PURGE_BATCH = 1000;

/**
 * Status changes of a shop and what follows from them (FR-007, FR-060 to FR-062): suspend and reinstate by the
 * platform, offboarding by the owner, the purge after the grace period, and the export. Each change is one
 * transaction: a conditional status update, a history row, events in the outbox. The shop row is locked first, so two
 * racing changes are decided one after the other and the loser is judged against the winner's result.
 */
@Injectable()
export class ShopLifecycleService {
  private readonly logger = new Logger(ShopLifecycleService.name);

  constructor(
    @Inject(SHOP_REPOSITORY) private readonly shops: ShopRepository,
    @Inject(MEMBERSHIP_REPOSITORY)
    private readonly members: MembershipRepository,
    @Inject(INVITE_REPOSITORY) private readonly invites: InviteRepository,
    @Inject(SSO_CONFIG_REPOSITORY)
    private readonly configs: SsoConfigRepository,
    @Inject(DIRECTORY_REPOSITORY)
    private readonly directory: DirectoryRepository,
    @Inject(STATUS_HISTORY_REPOSITORY)
    private readonly history: StatusHistoryRepository,
    @Inject(TENANT_TRANSACTIONS) private readonly shopTx: TenantTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly access: ShopAccessService,
    private readonly cells: ShopCellService,
    private readonly registry: OidcProviderRegistry,
    private readonly sessions: SessionRevocationService,
    private readonly users: UserDirectoryService,
    private readonly audit: TenancyAudit,
  ) {}

  async suspend(shopId: string, actorId: string, reason: string) {
    const shop = await this.change(shopId, actorId, 'SUSPENDED', reason);
    return { id: shop.id, status: shop.status };
  }

  /** Only a suspended shop is reinstated: `DELETING → ACTIVE` is the owner's cancellation, not the platform's call. */
  async reinstate(shopId: string, actorId: string, reason: string) {
    const shop = await this.change(
      shopId,
      actorId,
      'ACTIVE',
      reason,
      'SUSPENDED',
    );
    return { id: shop.id, status: shop.status };
  }

  /** Owner only (the route's permission). The slug is the confirmation; a repeat while closing answers the same. */
  async startOffboarding(shopId: string, actorId: string, confirmSlug: string) {
    const shop = await this.shopTx.inShop(
      shopId,
      async () => {
        const current = await this.shops.lockById(shopId);
        if (!current || current.status === 'DELETED')
          throw new Domain_ShopNotFoundError();
        if (confirmSlug !== current.slug)
          throw new Domain_ConfirmationMismatchError();
        if (current.status === 'DELETING') return current; // no second event
        // The status gate lets a suspended shop only read and export; the same answer when the suspension raced the guard.
        if (current.status === 'SUSPENDED')
          throw new Domain_ShopSuspendedError();
        const purgeAt = new Date(
          this.clock.now().getTime() + OFFBOARDING_GRACE_MS,
        );
        const updated = await this.apply(current, 'DELETING', {
          actorId,
          reason: 'offboarding_started',
          purgeAt,
        });
        await this.outbox.append(
          ShopOffboardingStarted.create(shopId, updated.shopVersion, {
            shopId,
            purgeAt: purgeAt.toISOString(),
            shopVersion: updated.shopVersion,
          }),
        );
        return updated;
      },
      { userId: actorId },
    );
    this.audit.record('shop.offboarding_started', { shopId, actorId });
    return { status: shop.status, purgeAt: shop.purgeAt!.toISOString() };
  }

  async cancelOffboarding(shopId: string, actorId: string) {
    const shop = await this.shopTx.inShop(
      shopId,
      async () => {
        const current = await this.shops.lockById(shopId);
        if (!current || current.status === 'DELETED')
          throw new Domain_ShopNotFoundError();
        if (current.status !== 'DELETING')
          throw new Domain_InvalidTransitionError();
        const updated = await this.apply(current, 'ACTIVE', {
          actorId,
          reason: 'offboarding_cancelled',
          purgeAt: null,
        });
        await this.outbox.append(
          ShopOffboardingCancelled.create(shopId, updated.shopVersion, {
            shopId,
            shopVersion: updated.shopVersion,
          }),
        );
        return updated;
      },
      { userId: actorId },
    );
    this.audit.record('shop.offboarding_cancelled', { shopId, actorId });
    return { status: shop.status };
  }

  /** Everything tenancy holds about the shop and nothing secret (FR-061). */
  async export(shopId: string, viewerId: string) {
    const now = this.clock.now();
    const data = await this.shopTx.inShop(
      shopId,
      async () => {
        const shop = await this.shops.findById(shopId);
        if (!shop || shop.status === 'DELETED')
          throw new Domain_ShopNotFoundError();
        const members = await this.members.listAll(shopId);
        const invites: InviteRecord[] = [];
        let after: { key: string; id: string } | null = null;
        for (;;) {
          const page = await this.invites.listPage(
            shopId,
            null,
            now,
            after,
            EXPORT_PAGE,
          );
          invites.push(...page);
          const last = page.at(-1);
          if (page.length < EXPORT_PAGE || !last) break;
          after = { key: last.cursorKey, id: last.id };
        }
        const sso = await this.configs.find(shopId);
        return { shop, members, invites, sso };
      },
      { userId: viewerId },
    );
    const users = await this.users.getUsersByIds(
      data.members.map((m) => m.userId),
    );
    this.audit.record('shop.exported', { shopId, actorId: viewerId });
    return {
      generatedAt: now.toISOString(),
      shop: toShopDto(data.shop),
      members: data.members.map((m) => ({
        userId: m.userId,
        email: users.get(m.userId)?.email ?? null,
        role: m.role,
        source: m.source,
        joinedAt: m.joinedAt.toISOString(),
      })),
      invites: data.invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        status: inviteStatus(i, now),
        createdAt: i.createdAt.toISOString(),
      })),
      sso: data.sso
        ? {
            issuer: data.sso.issuer,
            clientId: data.sso.clientId,
            defaultRole: data.sso.defaultRole,
            enabled: data.sso.enabled,
          }
        : null,
    };
  }

  /**
   * Purges one due shop in its own transaction (FR-062): members, invites, SSO configuration, directory row and
   * history are deleted, the shop row becomes a tombstone, `member_removed` (reason `shop_deleted`) and
   * `shop_deleted` are published. Returns false when the shop is not (or no longer) due, so a second or concurrent run
   * does nothing.
   */
  async purge(shopId: string): Promise<boolean> {
    const sessionsToEnd: string[] = [];
    const purged = await this.shopTx.crossTenant('shop.purge', async () => {
      const shop = await this.shops.lockById(shopId);
      const now = this.clock.now();
      if (
        !shop ||
        shop.status !== 'DELETING' ||
        !shop.purgeAt ||
        shop.purgeAt.getTime() > now.getTime()
      )
        return false;

      const members = await this.members.listAll(shopId);
      await this.outbox.append(
        members.map((m) =>
          MemberRemoved.create(shopId, shop.shopVersion, {
            shopId,
            userId: m.userId,
            role: m.role,
            reason: 'shop_deleted',
          }),
        ),
      );
      for (const m of members)
        if (m.source === 'sso') sessionsToEnd.push(m.userId);

      await this.members.deleteAll(shopId);
      await this.invites.deleteAllForShop(shopId);
      await this.configs.delete(shopId);
      await this.directory.delete(shopId);
      await this.history.deleteAll(shopId);
      const tombstone = await this.shops.tombstone(shopId, now);
      if (!tombstone) throw new Domain_InvalidTransitionError();
      await this.outbox.append([
        ShopStatusChanged.create(shopId, tombstone.shopVersion, {
          shopId,
          from: 'DELETING',
          to: 'DELETED',
          reason: 'purged',
          shopVersion: tombstone.shopVersion,
        }),
        ShopDeleted.create(shopId, tombstone.shopVersion, {
          shopId,
          shopVersion: tombstone.shopVersion,
        }),
      ]);
      this.access.invalidateAfterCommit(shopId);
      this.cells.forget(shopId);
      afterCommit(() => this.registry.invalidate(`shop:${shopId}`));
      afterCommit(async () => {
        for (const userId of sessionsToEnd)
          try {
            await this.sessions.revokeAllForUser(
              userId,
              'shop_membership_removed',
            );
          } catch (error) {
            // The shop is gone either way; a failed revocation is reported, not retried from here.
            this.logger.error({
              event: 'purge.session_revocation_failed',
              shopId,
              error: (error as Error).name,
            });
          }
      });
      return true;
    });
    if (purged) this.audit.record('shop.purged', { shopId, actorId: 'system' });
    return purged;
  }

  /**
   * One pass of the purge job: every due shop in its own transaction, so one failing shop is logged and left
   * `DELETING` for the next pass while the others go on. Returns how many were purged.
   */
  async purgeDue(batch = PURGE_BATCH): Promise<number> {
    const due = await this.shops.listDueForPurge(this.clock.now(), batch);
    let purged = 0;
    for (const shopId of due)
      try {
        if (await this.purge(shopId)) purged++;
      } catch (error) {
        this.logger.error({
          event: 'purge.failed',
          shopId,
          error: (error as Error).name,
        });
      }
    return purged;
  }

  /** Invites 30 days past their expiry, revocation or acceptance go, and their addresses with them. */
  async purgeSettledInvites(): Promise<number> {
    const before = new Date(this.clock.now().getTime() - INVITE_RETENTION_MS);
    let total = 0;
    for (;;) {
      const removed = await this.shopTx.crossTenant('shop.purge', () =>
        this.invites.deleteSettledBefore(before, INVITE_PURGE_BATCH),
      );
      total += removed;
      if (removed < INVITE_PURGE_BATCH) return total;
    }
  }

  private async change(
    shopId: string,
    actorId: string,
    to: ShopStatus,
    reason: string,
    requiredFrom?: ShopStatus,
  ): Promise<ShopRecord> {
    const shop = await this.shopTx.inShop(shopId, async () => {
      const current = await this.shops.lockById(shopId);
      if (!current || current.status === 'DELETED')
        throw new Domain_ShopNotFoundError();
      if (requiredFrom && current.status !== requiredFrom)
        throw new Domain_InvalidTransitionError();
      return this.apply(current, to, { actorId, reason, purgeAt: null });
    });
    this.audit.record('shop.status_changed', { shopId, actorId, to });
    return shop;
  }

  /** The conditional move, its history row and `shop_status_changed`, inside the caller's transaction. */
  private async apply(
    current: ShopRecord,
    to: ShopStatus,
    input: { actorId: string; reason: string; purgeAt: Date | null },
  ): Promise<ShopRecord> {
    const move = nextState(current.status, to);
    if (!move.ok) throw new Domain_InvalidTransitionError();
    const now = this.clock.now();
    const updated = await this.shops.transition({
      shopId: current.id,
      from: current.status,
      to,
      purgeAt: input.purgeAt,
      now,
    });
    if (!updated) throw new Domain_InvalidTransitionError();
    await this.history.insert({
      shopId: current.id,
      from: current.status,
      to,
      actor: input.actorId,
      reason: input.reason,
      at: now,
    });
    await this.outbox.append(
      ShopStatusChanged.create(current.id, updated.shopVersion, {
        shopId: current.id,
        from: current.status,
        to,
        reason: input.reason,
        shopVersion: updated.shopVersion,
      }),
    );
    this.access.invalidateAfterCommit(current.id);
    afterCommit(() => this.registry.invalidate(`shop:${current.id}`));
    return updated;
  }
}

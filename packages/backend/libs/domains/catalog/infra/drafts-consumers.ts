import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  MemberRemoved,
  MemberRoleChanged,
  ShopDeleted,
  ShopOffboardingStarted,
  ShopQueryService,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type {
  Projector,
  SinkCounts,
} from '@app/infrastructure/projections/projector';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import {
  COLLAB_BACKPLANE,
  DOC_STORE,
  DRAFT_REPOSITORY,
  SNAPSHOT_STORE,
  type Backplane,
  type DocStore,
  type DraftRepository,
  type SnapshotStore,
} from '../domain/draft-ports';

const counts = (applied: number, stale = 0): SinkCounts => ({
  applied,
  duplicate: 0,
  stale,
});

const uuid = z.string().uuid();
const role = z.enum(['OWNER', 'ADMIN', 'STAFF', 'VIEWER']);
const status = z.enum(['ACTIVE', 'SUSPENDED', 'DELETING', 'DELETED']);

/** The payloads these consumers accept, checked strictly (S06 events-services.md): anything else can never be applied. */
const memberRemovedPayload = z.object({
  shopId: uuid,
  userId: uuid,
  role,
  reason: z.string(),
});
const memberRoleChangedPayload = z.object({
  shopId: uuid,
  userId: uuid,
  from: role,
  to: role,
});
const shopStatusPayload = z.object({
  shopId: uuid,
  from: status,
  to: status,
  shopVersion: z.number().int(),
});
const shopOffboardingPayload = z.object({ shopId: uuid });
const shopDeletedPayload = z.object({ shopId: uuid });

/** Parses every payload of the batch before anything is done; a bad one is a permanent failure (dead letter, no effect). */
function strict<S extends z.ZodType>(
  schema: S,
  events: EventEnvelope[],
): z.output<S>[] {
  return events.map((event) => {
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success)
      throw new PermanentError(`invalid ${event.type} payload`);
    return parsed.data;
  });
}

/**
 * `tenancy.member_removed`: tells every editing instance to look at the user's membership now. The event is a trigger,
 * never a grant: the rooms read the membership fresh and close what the answer no longer allows (S06 FR-021).
 */
@Injectable()
export class DraftMemberRemovedConsumer implements Projector {
  readonly name: string = 'catalog-drafts-member-removed';
  readonly topics: string[] = [MemberRemoved.topic];
  readonly idempotency = 'inbox' as const;
  readonly handles = [{ event: MemberRemoved }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    @Inject(COLLAB_BACKPLANE) private readonly backplane: Backplane,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    for (const { shopId, userId } of strict(memberRemovedPayload, events))
      await this.backplane.publish({ type: 'revoke', shopId, userId });
    return counts(events.length);
  }
}

/** `tenancy.member_role_changed`: the same trigger; a role that gained write takes effect on the next connect. */
@Injectable()
export class DraftMemberRoleChangedConsumer implements Projector {
  readonly name: string = 'catalog-drafts-member-role-changed';
  readonly topics: string[] = [MemberRoleChanged.topic];
  readonly idempotency = 'inbox' as const;
  readonly handles = [{ event: MemberRoleChanged }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    @Inject(COLLAB_BACKPLANE) private readonly backplane: Backplane,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    for (const { shopId, userId } of strict(memberRoleChangedPayload, events))
      await this.backplane.publish({ type: 'recheck', shopId, userId });
    return counts(events.length);
  }
}

/** Closes the rooms of a shop that is not `ACTIVE` right now; a late event about a shop that is active again closes nothing. */
abstract class ShopClosingConsumer implements Projector {
  abstract readonly name: string;
  abstract readonly topics: string[];
  abstract readonly handles: Projector['handles'];
  readonly idempotency = 'inbox' as const;
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    protected readonly backplane: Backplane,
    protected readonly shops: ShopQueryService,
  ) {}

  /** The event's payload checked strictly; a payload that does not fit can never be applied. */
  protected abstract parse(
    events: EventEnvelope[],
  ): Array<{ shopId: string; concerns: boolean }>;

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    let closed = 0;
    let stale = 0;
    for (const { shopId, concerns } of this.parse(events)) {
      if (!concerns) {
        stale += 1;
        continue;
      }
      // The shop as it is now decides, so an event that arrives after a newer one changes nothing.
      const shop = (await this.shops.getShopsByIds([shopId])).get(shopId);
      if (shop && shop.status === 'ACTIVE') {
        stale += 1;
        continue;
      }
      await this.backplane.publish({
        type: 'close-shop',
        shopId,
        reason: 'shop_inactive',
      });
      closed += 1;
    }
    return counts(closed, stale);
  }
}

/** `tenancy.shop_status_changed`: a shop that is no longer `ACTIVE` closes its rooms (`4003 shop_inactive`). */
@Injectable()
export class DraftShopStatusConsumer extends ShopClosingConsumer {
  readonly name: string = 'catalog-drafts-shop-status';
  readonly topics: string[] = [ShopStatusChanged.topic];
  readonly handles = [{ event: ShopStatusChanged }];

  constructor(
    @Inject(COLLAB_BACKPLANE) backplane: Backplane,
    shops: ShopQueryService,
  ) {
    super(backplane, shops);
  }

  protected parse(events: EventEnvelope[]) {
    return strict(shopStatusPayload, events).map((p) => ({
      shopId: p.shopId,
      concerns: p.to !== 'ACTIVE',
    }));
  }
}

/** `tenancy.shop_offboarding_started`: the shop is closing, its rooms close. */
@Injectable()
export class DraftShopOffboardingConsumer extends ShopClosingConsumer {
  readonly name: string = 'catalog-drafts-shop-offboarding';
  readonly topics: string[] = [ShopOffboardingStarted.topic];
  readonly handles = [{ event: ShopOffboardingStarted }];

  constructor(
    @Inject(COLLAB_BACKPLANE) backplane: Backplane,
    shops: ShopQueryService,
  ) {
    super(backplane, shops);
  }

  protected parse(events: EventEnvelope[]) {
    return strict(shopOffboardingPayload, events).map((p) => ({
      shopId: p.shopId,
      concerns: true,
    }));
  }
}

/**
 * `tenancy.shop_deleted`: removes the shop's drafts, versions, snapshots and log entries, at most 100 drafts per
 * transaction, and closes its rooms. Naturally repeatable (deleting what is already gone changes nothing), so a crash
 * between batches is repaired by the redelivery: no inbox record could survive a rollback of the batches already done.
 */
@Injectable()
export class DraftShopDeletedConsumer implements Projector {
  private readonly logger = new Logger(DraftShopDeletedConsumer.name);
  readonly name: string = 'catalog-drafts-shop-deleted';
  readonly topics: string[] = [ShopDeleted.topic];
  readonly idempotency = 'natural' as const;
  readonly handles = [{ event: ShopDeleted }];
  readonly aggregateIdSchema = z.string().uuid();

  constructor(
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(DOC_STORE) private readonly docs: DocStore,
    @Inject(SNAPSHOT_STORE) private readonly snapshots: SnapshotStore,
    @Inject(COLLAB_BACKPLANE) private readonly backplane: Backplane,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    for (const { shopId } of strict(shopDeletedPayload, events)) {
      await this.backplane.publish({
        type: 'close-shop',
        shopId,
        reason: 'shop_inactive',
      });
      const removed = await this.purge(shopId);
      this.logger.log({
        msg: 'shop drafts purged',
        event: 'drafts_purged',
        shopId,
        drafts: removed,
      });
    }
    return counts(events.length);
  }

  /** Batches of at most 100 drafts; the stores are emptied before the rows go, so a crash leaves nothing unreachable. */
  private async purge(shopId: string): Promise<number> {
    let total = 0;
    for (;;) {
      const ids = await this.drafts.idsOfShop(shopId, DRAFT_LIMITS.purgeBatch);
      if (ids.length === 0) return total;
      const versionKeys = await this.drafts.versionKeysOf(shopId, ids);
      for (const id of ids) await this.docs.purge(id);
      for (const key of versionKeys) await this.snapshots.delete(key);
      total += await this.drafts.deleteByIds(shopId, ids);
    }
  }
}

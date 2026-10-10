import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { InvalidEventPayloadError } from '@app/infrastructure/events/event-errors';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { SinkCounts } from '@app/infrastructure/projections/projector';
import {
  ShopDeleted,
  ShopOffboardingCancelled,
  ShopOffboardingStarted,
  ShopPlanChanged,
  ShopStatusChanged,
} from '@app/domains/tenancy';
import {
  PRODUCT_INDEX,
  SHOP_SEARCH_REPOSITORY,
  SHOP_STATE_REPOSITORY,
  type ProductIndexPort,
  type ShopSearchRepository,
  type ShopStateChange,
  type ShopStateRepository,
} from '../../domain/ports';
import {
  searchIgnoredCounter,
  searchStaleIgnoredCounter,
} from '../../infra/search-metrics';
import { guarded, recordLag, stampOf, UUID } from './projection-support';

const PLANS = ['STARTER', 'PRO', 'ENTERPRISE'] as const;

/**
 * `tenancy.shop_*` into the shop-state copy and the shop stamp on the shop's index documents (S32 FR-022). Events with
 * a `shopVersion` are ordered by it, the offboarding events (which have none yet) by their envelope time. The copy is
 * written first (version guard), then the index documents are stamped; a shop deletion removes the shop's documents
 * and shop-table rows.
 */
@Injectable()
export class ShopStateProjectionService {
  constructor(
    @Inject(SHOP_STATE_REPOSITORY) private readonly shops: ShopStateRepository,
    @Inject(PRODUCT_INDEX) private readonly index: ProductIndexPort,
    @Inject(SHOP_SEARCH_REPOSITORY)
    private readonly shopSearch: ShopSearchRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<SinkCounts> {
    const counts: SinkCounts = { applied: 0, duplicate: 0, stale: 0 };
    for (const envelope of events) {
      const change = this.parse(envelope);
      if (!change) continue;
      await guarded(async () => {
        const { outcome, record } = await this.shops.apply(change);
        if (outcome === 'stale') {
          counts.stale++;
          searchStaleIgnoredCounter.add(1, { source: 'shop' });
          return;
        }
        if (outcome === 'duplicate') counts.duplicate++;
        else counts.applied++;
        if (record.status === 'DELETED') {
          await this.index.purgeShop(record.shopId);
          await this.shopSearch.purgeShop(record.shopId);
        } else {
          await this.index.stampShop(record.shopId, stampOf(record));
        }
        recordLag('shop', envelope.occurredAt, this.clock.now());
      });
    }
    return counts;
  }

  private parse(envelope: EventEnvelope): ShopStateChange | null {
    const occurredAt = new Date(envelope.occurredAt);
    try {
      switch (envelope.type) {
        case ShopStatusChanged.type: {
          const p = this.match(ShopStatusChanged, envelope);
          return this.change(p.shopId, envelope, {
            status: p.to,
            shopVersion: p.shopVersion,
          });
        }
        case ShopPlanChanged.type: {
          const p = this.match(ShopPlanChanged, envelope);
          if (!(PLANS as readonly string[]).includes(p.plan))
            throw new PermanentError(`unknown plan "${p.plan}"`);
          return this.change(p.shopId, envelope, {
            plan: p.plan as (typeof PLANS)[number],
            shopVersion: p.shopVersion,
          });
        }
        case ShopOffboardingStarted.type: {
          const p = this.match(ShopOffboardingStarted, envelope);
          return this.change(p.shopId, envelope, {
            offboarding: true,
            shopVersion: null,
          });
        }
        case ShopOffboardingCancelled.type: {
          const p = this.match(ShopOffboardingCancelled, envelope);
          return this.change(p.shopId, envelope, {
            offboarding: false,
            shopVersion: null,
          });
        }
        case ShopDeleted.type: {
          const p = this.match(ShopDeleted, envelope);
          return this.change(p.shopId, envelope, {
            status: 'DELETED',
            shopVersion: null,
          });
        }
        default:
          void occurredAt;
          searchIgnoredCounter.add(1, { reason: 'unknown_type' });
          return null;
      }
    } catch (error) {
      if (error instanceof InvalidEventPayloadError)
        throw new PermanentError(error.message, { cause: error });
      throw error;
    }
  }

  private match<P extends { shopId: string }>(
    definition: {
      type: string;
      match(e: EventEnvelope): { payload: P } | null;
    },
    envelope: EventEnvelope,
  ): P {
    const event = definition.match(envelope);
    if (!event)
      throw new PermanentError(
        `unsupported contract version ${envelope.version} of ${envelope.type}`,
      );
    if (!UUID.test(event.payload.shopId))
      throw new PermanentError(`shopId of ${envelope.type} is not a UUID`);
    return event.payload;
  }

  private change(
    shopId: string,
    envelope: EventEnvelope,
    over: Omit<ShopStateChange, 'shopId' | 'occurredAt'>,
  ): ShopStateChange {
    return {
      shopId,
      occurredAt: new Date(envelope.occurredAt),
      ...over,
    };
  }
}

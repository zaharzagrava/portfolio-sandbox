import { Inject, Injectable } from '@nestjs/common';
import type { AdAction, AdStatusReason } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  CAMPAIGN_STORE,
  type CampaignRecord,
  type CampaignStore,
} from '../domain/ads-ports';
import { isSponsored, nextStatus, reasonAfter } from '../domain/campaign-state';
import {
  CAMPAIGN_EVENT_FOR_ACTION,
  ProductSponsorshipChanged,
} from './events/ads-events';
import { toEventPayload } from './campaign-view';

export interface TransitionCause {
  /** The member who acted, `null` for the system (a product or shop event). */
  actorId: string | null;
  /** Free text kept in the history row: `seller_pause`, `product_archived` ... */
  reason: string;
  /** What `statusReason` shows on a pause or an end. */
  statusReason: AdStatusReason;
}

/**
 * The transition of one campaign inside the caller's transaction, shared by a member's command and by the effect of a
 * product or shop event (which runs in `apps/projector`, hence a provider of its own without the R1 lookups): conditional
 * update asserting one row, history row, quota release on end, the sponsored value when it changes (AS-11) and the outbox
 * events (FR-005, FR-007).
 */
@Injectable()
export class CampaignLifecycleService {
  constructor(
    @Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
  ) {}

  /** `null` when the pair is illegal or another change won the row. */
  async apply(
    campaign: CampaignRecord,
    action: AdAction,
    cause: TransitionCause,
  ): Promise<CampaignRecord | null> {
    const to = nextStatus(campaign.status, action);
    if (!to) return null;
    const now = this.clock.now();
    const updated = await this.campaigns.transition(
      campaign.id,
      campaign.shopId,
      campaign.status,
      to,
      reasonAfter(action, cause.statusReason),
      now,
    );
    if (!updated) return null;
    await this.campaigns.appendHistory(
      {
        campaignId: updated.id,
        actorId: cause.actorId,
        from: campaign.status,
        to,
        reason: cause.reason,
        campaignVersion: updated.campaignVersion,
      },
      now,
    );
    if (to === 'ENDED') await this.campaigns.releaseQuota(updated.shopId);
    const events: EventEnvelope[] = [
      CAMPAIGN_EVENT_FOR_ACTION[action].create(
        updated.id,
        updated.campaignVersion,
        toEventPayload(updated),
        now,
      ),
    ];
    await this.publishSponsorship(updated, isSponsored(to), now, events);
    await this.outbox.append(events);
    return updated;
  }

  /**
   * Sets the sponsored value of the campaign's product and, only when it changed, adds the signal S32 consumes to
   * `events` (AS-11); the version strictly rises per product.
   */
  async publishSponsorship(
    campaign: CampaignRecord,
    sponsored: boolean,
    now: Date,
    events: EventEnvelope[],
  ): Promise<void> {
    const version = await this.campaigns.setSponsorship(
      campaign.productId,
      campaign.shopId,
      sponsored,
      now,
    );
    if (version === null) return;
    events.push(
      ProductSponsorshipChanged.create(
        campaign.productId,
        version,
        {
          productId: campaign.productId,
          shopId: campaign.shopId,
          sponsored,
          sponsorshipVersion: version,
        },
        now,
      ),
    );
  }
}

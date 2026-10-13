import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type { SponsoredSlotsResponse } from '@marketplace-sandbox/contracts';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  CAMPAIGN_STORE,
  SPEND_COUNTER,
  type CampaignStore,
  type ServeCandidate,
  type SpendCounter,
} from '../domain/ads-ports';
import { adsImpressionsCounter } from '../domain/ads-metrics';
import { SERVE_CANDIDATE_LIMIT, TOKEN_TTL_MS } from '../domain/ads-constants';
import { serviceUnavailable } from '../domain/ads-errors';
import { dayKey } from '../domain/click-record';
import { hashViewer, signClickToken } from '../domain/click-token';
import { selectSlots } from '../domain/slot-ranking';

export interface ServeInput {
  /** `all` or a category slug (validated by the controller). */
  category: string;
  /** 1 to 3. */
  limit: number;
  /** Who is looking, as a kind-prefixed identity (`user:`, `anon:`, `ip:`): only ever fed to the keyed viewer hash. */
  viewer: string;
}

/**
 * `GET /ads/sponsored` (US2, FR-010 to FR-016): up to `limit` labelled slots from the marketing tables only, one per shop,
 * best CPC first, each with a fresh signed click token. Today's spend is read from the counters with a 100 ms limit: if it
 * cannot be read, the answer is an empty list rather than unchecked ads (FR-015); a database failure is a generic `503`.
 * The token never carries a price, the body never carries a CPC, a budget or a viewer identifier (FR-012).
 */
@Injectable()
export class ServingService {
  private readonly logger = new Logger(ServingService.name);

  constructor(
    @Inject(CAMPAIGN_STORE) private readonly campaigns: CampaignStore,
    @Inject(SPEND_COUNTER) private readonly spend: SpendCounter,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly config: ApiConfigService,
  ) {}

  async serve(input: ServeInput): Promise<SponsoredSlotsResponse> {
    const now = this.clock.now();
    const generatedAt = now.toISOString();

    let candidates: ServeCandidate[];
    try {
      candidates = await this.campaigns.serveCandidates(
        input.category,
        SERVE_CANDIDATE_LIMIT,
      );
    } catch (error) {
      this.logger.error(
        `serving candidates unavailable (${(error as Error).name})`,
      );
      throw serviceUnavailable();
    }
    if (candidates.length === 0) return { items: [], generatedAt };

    let clicks: Map<string, number>;
    try {
      clicks = await this.spend.readMany(
        candidates.map((c) => c.campaignId),
        dayKey(now),
      );
    } catch {
      adsImpressionsCounter.add(1, { result: 'degraded' });
      return { items: [], generatedAt };
    }

    // The next click must still fit in today's budget: (counted clicks + 1) x CPC <= budget. CPC cannot be edited, so the
    // product is exact; the counter is a pacing hint and the charge is capped separately (R-6).
    const affordable = candidates.filter(
      (c) =>
        ((clicks.get(c.campaignId) ?? 0) + 1) * c.cpcMinor <=
        c.dailyBudgetMinor,
    );
    const chosen = selectSlots(affordable, input.limit);

    const secret = this.config.get('ads_click_secret');
    const viewerHash = hashViewer(secret, input.viewer);
    const expiresAtMs = now.getTime() + TOKEN_TTL_MS;
    const items = chosen.map((c) => ({
      campaignId: c.campaignId,
      productId: c.productId,
      shopId: c.shopId,
      title: c.title,
      priceMinor: c.priceMinor,
      currency: c.currency,
      sponsored: true as const,
      clickUrl: `/api/ads/click/${signClickToken(
        {
          i: uuidv7(),
          c: c.campaignId,
          s: c.shopId,
          p: c.productId,
          e: expiresAtMs,
          v: viewerHash,
        },
        { current: secret },
      )}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    }));
    if (items.length > 0)
      adsImpressionsCounter.add(items.length, { result: 'served' });
    return { items, generatedAt };
  }
}
